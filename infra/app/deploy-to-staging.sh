#!/usr/bin/env bash
# Deploy Scholera to the STAGING Cloud Run service (scholera-staging).
#
# Staging is a hosted mirror of prod backed by a SEPARATE, isolated Supabase
# project (a free-tier project, rotated when it auto-pauses). It is where PRs
# land for QA before promotion to prod. It NEVER touches the prod database.
#
# Usage:
#   bash infra/app/deploy-to-staging.sh [ENV_FILE] [--skip-checks] [--dry-run]
#
#   ENV_FILE        Path to the staging env file (default: .env.staging).
#                   Keep multiple profiles (.env.staging, .env.staging.b, ...)
#                   and pass one to switch which Supabase project staging uses.
#   --skip-checks   Skip lint + typecheck.
#   --dry-run       Build nothing; just validate config and print what would run.
#
# ┌─────────────────────────────────────────────────────────────────────────────┐
# │ HOW THIS DIFFERS FROM deploy-to-prod.sh (and why)                           │
# │                                                                             │
# │ - Targets the 'scholera-staging' service, NOT 'scholera'.                   │
# │ - Does NOT require branch 'main' or a clean/synced tree — staging exists to │
# │   test work-in-progress (typically the 'staging' branch).                   │
# │ - Builds via infra/app/cloudbuild.staging.yaml so it can pass --build-arg   │
# │   the staging Supabase URL/anon key (gcloud run deploy --source cannot).    │
# │ - Injects the staging service_role key from GCP Secret Manager, never as a  │
# │   plaintext env var / build substitution.                                   │
# │ - Hard-refuses to deploy if the env file points at the PROD project ref.    │
# └─────────────────────────────────────────────────────────────────────────────┘
#
# Studio builder settings (infra/app/README.md, "Environment for the Studio builder"):
#   STUDIO_RUNTIME_ORIGIN       required in the env file: https, a bare origin, and
#                               on a different registrable domain from SITE_URL.
#   BACKGROUND_JOBS_KICK_URL    always ${SITE_URL}/api/jobs-worker/kick.
#   BACKGROUND_JOBS_SECRET      Secret Manager, staging-background-jobs-secret.
#   STUDIO_FRAME_TICKET_SECRET  Secret Manager, staging-studio-frame-ticket-secret.
# A missing secret is created once with a random value. An existing one is never
# rotated here. STUDIO_STUDENT_ACCESS is never set, and the deploy refuses an env
# file that turns it on.

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
PROJECT_ID="project-da8bebd0-f168-4cee-869"   # same GCP project as prod
SERVICE_NAME="scholera-staging"
REGION="us-central1"
AR_REPO="cloud-run-source-deploy"             # existing Artifact Registry repo
SECRET_NAME="supabase-staging-service-role-key"
# Studio builder secrets. setup-sweep-schedulers.sh --staging reads the jobs
# secret by this name, so rename it in both places or neither.
BG_JOBS_SECRET_NAME="staging-background-jobs-secret"
FRAME_TICKET_SECRET_NAME="staging-studio-frame-ticket-secret"
PROD_REF="ywdqaoahfmmzcsczxvxn"               # NEVER deploy staging against this
MEMORY="4Gi"; CPU="2"; TIMEOUT="900"; PORT="8080"
MIN_INSTANCES="0"; MAX_INSTANCES="2"

# ─── Colors / helpers ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
step() { echo -e "\n${BLUE}▶${NC} $1"; }
pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1"; exit 1; }
warn() { echo -e "  ${YELLOW}WARN${NC} $1"; }

# ─── Flags ───────────────────────────────────────────────────────────────────
ENV_FILE=".env.staging"
SKIP_CHECKS=false
DRY_RUN=false
for arg in "$@"; do
  case $arg in
    --skip-checks) SKIP_CHECKS=true ;;
    --dry-run)     DRY_RUN=true ;;
    --help)        sed -n '2,38p' "$0"; exit 0 ;;
    -*)            fail "Unknown flag: $arg" ;;
    *)             ENV_FILE="$arg" ;;
  esac
done

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Scholera — STAGING Deployment${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# ─── Step 1: Load + validate the staging env file ───────────────────────────
step "Loading staging config from '$ENV_FILE'"
[ -f "$ENV_FILE" ] || fail "Env file '$ENV_FILE' not found. Copy your staging Supabase URL/anon/service_role into it (gitignored)."
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a

: "${NEXT_PUBLIC_SUPABASE_URL:?NEXT_PUBLIC_SUPABASE_URL missing in $ENV_FILE}"
: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?NEXT_PUBLIC_SUPABASE_ANON_KEY missing in $ENV_FILE}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY missing in $ENV_FILE}"
SITE_URL="${NEXT_PUBLIC_SITE_URL:-https://staging.scholera-inc.com}"

# Last line of defense: never let staging deploy point at the prod project.
case "$NEXT_PUBLIC_SUPABASE_URL" in
  *"$PROD_REF"*) fail "Env file points at the PRODUCTION project ($PROD_REF). Refusing to deploy staging against prod." ;;
esac
STAGING_REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https://([^.]+)\.supabase\.co.*#\1#')
pass "Target Supabase project: $STAGING_REF  (site: $SITE_URL)"

# Studio builder. The origin rules mirror studioOrigins() in
# src/lib/studio/runtime/origin.ts, which turns plugin frames off when any of them
# fails. Checking here turns a silently disabled preview into a failed deploy.
step "Studio builder settings"
# Lower-cased host of a bare http(s) origin (a trailing slash is allowed, as in the
# app), or empty unless the rest is a plain host name with an optional numeric port.
# That rejects a path, query, fragment, credentials, whitespace and backslashes,
# which the app's URL parser would also refuse or read as a path.
origin_host() {
  local rest
  case "$1" in https://*|http://*) rest="${1#*://}" ;; *) return 0 ;; esac
  rest=$(printf '%s' "${rest%/}" | tr '[:upper:]' '[:lower:]')
  [[ "$rest" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?$ ]] || return 0
  printf '%s' "${rest%%:*}"
}
# Last two labels of a host. A rough stand-in for the registrable domain, which
# needs a public-suffix list; it errs towards refusing.
host_site() { printf '%s' "$1" | awk -F. '{ if (NF >= 2) print $(NF-1) "." $NF; else print $0 }'; }
SITE_HOST=$(origin_host "$SITE_URL")
[ -n "$SITE_HOST" ] || fail "SITE_URL ($SITE_URL) must be a bare origin with no path, e.g. https://staging.scholera-inc.com"

[ -n "${STUDIO_RUNTIME_ORIGIN:-}" ] || fail "STUDIO_RUNTIME_ORIGIN missing in $ENV_FILE. Set it to the staging plugin runtime origin: https, and a different site from $SITE_URL. See infra/app/README.md."
case "$STUDIO_RUNTIME_ORIGIN" in https://*) ;; *) fail "STUDIO_RUNTIME_ORIGIN ($STUDIO_RUNTIME_ORIGIN) must be https." ;; esac
RUNTIME_HOST=$(origin_host "$STUDIO_RUNTIME_ORIGIN")
[ -n "$RUNTIME_HOST" ] || fail "STUDIO_RUNTIME_ORIGIN ($STUDIO_RUNTIME_ORIGIN) must be a bare origin: a host name and optional port, with no path."
if [ "$RUNTIME_HOST" = "$SITE_HOST" ] || [[ "$SITE_HOST" == *".$RUNTIME_HOST" ]] || [[ "$RUNTIME_HOST" == *".$SITE_HOST" ]]; then
  fail "STUDIO_RUNTIME_ORIGIN ($RUNTIME_HOST) must not be the SITE_URL host ($SITE_HOST), a subdomain of it, or a parent of it."
fi
# The app can't check this one (docs/reference/studio-plugin-runtime.md). A sibling
# such as plugins.scholera-inc.com is same-site, so frame requests would carry the
# app's cookies.
if [ "$(host_site "$RUNTIME_HOST")" = "$(host_site "$SITE_HOST")" ]; then
  fail "STUDIO_RUNTIME_ORIGIN ($RUNTIME_HOST) must be on a different registrable domain from SITE_URL ($SITE_HOST), not another subdomain of $(host_site "$SITE_HOST")."
fi
STUDIO_RUNTIME_ORIGIN="${STUDIO_RUNTIME_ORIGIN%/}"

# Student access stays off on staging until the release gate passes
# (docs/reference/studio-plugin-publication.md#release-gate). The deploy never sets
# it, so an env file that turns it on is a mistake worth stopping for.
if [ "${STUDIO_STUDENT_ACCESS:-}" = "on" ]; then
  fail "$ENV_FILE sets STUDIO_STUDENT_ACCESS=on. Student access stays off on staging; remove it from the env file."
fi

# The kick goes to the app host, never the runtime origin, which 404s everything
# but plugin frames.
BG_JOBS_KICK_URL="${SITE_URL%/}/api/jobs-worker/kick"
pass "STUDIO_RUNTIME_ORIGIN=$STUDIO_RUNTIME_ORIGIN"
pass "BACKGROUND_JOBS_KICK_URL=$BG_JOBS_KICK_URL"
pass "BACKGROUND_JOBS_SECRET from Secret Manager ($BG_JOBS_SECRET_NAME)"
pass "STUDIO_FRAME_TICKET_SECRET from Secret Manager ($FRAME_TICKET_SECRET_NAME)"
pass "STUDIO_STUDENT_ACCESS not set, so students reach no plugin"

# ─── Step 2: Show branch (no restriction — staging tests WIP) ────────────────
step "Branch"
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")
COMMIT_SHA=$(git rev-parse --short HEAD)
if [ "$CURRENT_BRANCH" = "main" ]; then
  warn "On 'main' — deploying prod code to staging (allowed, just unusual)."
else
  pass "On '$CURRENT_BRANCH' ($COMMIT_SHA)"
fi

# ─── Step 3: gcloud auth + project ───────────────────────────────────────────
step "GCP auth"
ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null)
[ -n "$ACTIVE_ACCOUNT" ] || fail "Not authenticated. Run: gcloud auth login"
pass "Authenticated as $ACTIVE_ACCOUNT"
gcloud config set project "$PROJECT_ID" --quiet >/dev/null 2>&1
pass "Project: $PROJECT_ID"

# ─── Step 4: Lint + typecheck (skippable) ────────────────────────────────────
step "Lint + typecheck"
if [ "$SKIP_CHECKS" = true ]; then
  warn "Skipped (--skip-checks)"
else
  npm run lint || fail "Lint failed. Fix before deploying."
  pass "Lint clean"
  npm run typecheck || fail "Typecheck failed. Fix before deploying."
  pass "Typecheck clean"
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:${COMMIT_SHA}"

if [ "$DRY_RUN" = true ]; then
  echo -e "\n${YELLOW}Dry run — would build $IMAGE and deploy to $SERVICE_NAME.${NC}"
  echo "  Studio builder settings it would apply:"
  echo "    env     STUDIO_RUNTIME_ORIGIN=$STUDIO_RUNTIME_ORIGIN"
  echo "    env     BACKGROUND_JOBS_KICK_URL=$BG_JOBS_KICK_URL"
  for s in "$BG_JOBS_SECRET_NAME" "$FRAME_TICKET_SECRET_NAME"; do
    if gcloud secrets describe "$s" >/dev/null 2>&1; then state="exists, kept as is"; else state="missing, would be created"; fi
    echo "    secret $s ($state)"
  done
  exit 0
fi

# ─── Step 5: Store service_role in Secret Manager (not in plaintext flags) ───
step "Secret Manager"
if ! gcloud secrets describe "$SECRET_NAME" >/dev/null 2>&1; then
  gcloud secrets create "$SECRET_NAME" --replication-policy=automatic --quiet
  pass "Created secret $SECRET_NAME"
fi
printf '%s' "$SUPABASE_SERVICE_ROLE_KEY" | gcloud secrets versions add "$SECRET_NAME" --data-file=- --quiet >/dev/null
pass "Added new version of $SECRET_NAME"

# Studio builder secrets: created once with a random value, never rotated here.
# A new jobs secret would leave the staging sweep job sending the old one until
# setup-sweep-schedulers.sh --staging is re-run. The value is held in a shell
# variable and piped to gcloud by the printf builtin, so it is never echoed,
# logged, written to disk or put on a command line. tr keeps only the hex digits:
# openssl's line ending (\n, or \r\n on Windows) would otherwise become part of
# the secret and fail the kick route's exact comparison. The length check stops a
# failed openssl from creating a short secret that later deploys would keep.
for s in "$BG_JOBS_SECRET_NAME" "$FRAME_TICKET_SECRET_NAME"; do
  if gcloud secrets describe "$s" >/dev/null 2>&1; then
    pass "Using existing secret $s"
  else
    secret_val=$(openssl rand -hex 32 | tr -dc '0-9a-f') || fail "openssl could not generate a value for $s"
    [ "${#secret_val}" -eq 64 ] || fail "Generated value for $s is not 64 hex characters; secret not created"
    printf '%s' "$secret_val" \
      | gcloud secrets create "$s" --replication-policy=automatic --data-file=- --quiet >/dev/null \
      || fail "Could not create secret $s"
    unset secret_val
    pass "Created secret $s"
  fi
done

# Grant the Cloud Run runtime SA (default compute SA) read access to the secrets.
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for s in "$SECRET_NAME" "$BG_JOBS_SECRET_NAME" "$FRAME_TICKET_SECRET_NAME"; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" --quiet >/dev/null 2>&1 || true
done
pass "Runtime SA can read the secrets"

# ─── Step 6: Build the staging image (build-args via Cloud Build) ────────────
step "Building image $IMAGE"
gcloud builds submit \
  --config infra/app/cloudbuild.staging.yaml \
  --substitutions "_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL},_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY},_SITE_URL=${SITE_URL},_IMAGE=${IMAGE}"
pass "Image built + pushed"

# ─── Step 7: Deploy to Cloud Run ─────────────────────────────────────────────
step "Deploying $SERVICE_NAME"
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port "$PORT" \
  --memory "$MEMORY" \
  --cpu "$CPU" \
  --timeout "$TIMEOUT" \
  --min-instances "$MIN_INSTANCES" \
  --max-instances "$MAX_INSTANCES" \
  --set-secrets "SUPABASE_SERVICE_ROLE_KEY=${SECRET_NAME}:latest,GOOGLE_GENERATIVE_AI_API_KEY=gemini-api-key:latest,OPENAI_API_KEY=openai-api-key:latest,RESEND_API_KEY=resend-api-key:latest,EMAIL_FROM=email-from:latest,ELEVENLABS_API_KEY=elevenlabs-api-key:latest,SLACK_FEEDBACK_WEBHOOK_URL=slack-feedback-webhook-url:latest,EXTRACTION_WORKER_SECRET=extraction-worker-secret:latest,BACKGROUND_JOBS_SECRET=${BG_JOBS_SECRET_NAME}:latest,STUDIO_FRAME_TICKET_SECRET=${FRAME_TICKET_SECRET_NAME}:latest" \
  --set-env-vars "SITE_URL=${SITE_URL},NEXT_PUBLIC_SITE_URL=${SITE_URL},EXTRACTION_V2_ENABLED=true,GOTENBERG_URL=https://scholera-deck-converter-7cmrekqoxa-uc.a.run.app,EXTRACTION_WORKER_KICK_URL=${SITE_URL}/api/extraction-worker/kick,BACKGROUND_JOBS_KICK_URL=${BG_JOBS_KICK_URL},STUDIO_RUNTIME_ORIGIN=${STUDIO_RUNTIME_ORIGIN}"

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)" 2>/dev/null)
echo -e "\n${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Staging deployed.${NC}"
echo -e "${GREEN}  Service:  $SERVICE_NAME ($COMMIT_SHA)${NC}"
echo -e "${GREEN}  Supabase: $STAGING_REF${NC}"
echo -e "${GREEN}  Live at:  $SITE_URL${NC}"
if [ "${SERVICE_URL%/}" = "$STUDIO_RUNTIME_ORIGIN" ]; then
  echo -e "${GREEN}  Runtime:  $SERVICE_URL (plugin frames only; other paths 404)${NC}"
else
  echo -e "${GREEN}  Run URL:  $SERVICE_URL${NC}"
fi
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Wake the (possibly auto-paused) free-tier Supabase project so the first real
# request doesn't eat the cold-start. Best-effort; never fails the deploy.
curl -fsS -I -o /dev/null "${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/" \
  -H "apikey: ${NEXT_PUBLIC_SUPABASE_ANON_KEY}" 2>/dev/null \
  && pass "Pinged staging Supabase (awake)" || warn "Supabase ping failed (it may be resuming)."
