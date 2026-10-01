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

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
PROJECT_ID="project-da8bebd0-f168-4cee-869"   # same GCP project as prod
SERVICE_NAME="scholera-staging"
REGION="us-central1"
AR_REPO="cloud-run-source-deploy"             # existing Artifact Registry repo
SECRET_NAME="supabase-staging-service-role-key"
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
    --help)        sed -n '2,30p' "$0"; exit 0 ;;
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

# Grant the Cloud Run runtime SA (default compute SA) read access to the secret.
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" --quiet >/dev/null 2>&1 || true
pass "Runtime SA can read the secret"

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
  --set-secrets "SUPABASE_SERVICE_ROLE_KEY=${SECRET_NAME}:latest,GOOGLE_GENERATIVE_AI_API_KEY=gemini-api-key:latest,OPENAI_API_KEY=openai-api-key:latest,RESEND_API_KEY=resend-api-key:latest,EMAIL_FROM=email-from:latest,ELEVENLABS_API_KEY=elevenlabs-api-key:latest,SLACK_FEEDBACK_WEBHOOK_URL=slack-feedback-webhook-url:latest,EXTRACTION_WORKER_SECRET=extraction-worker-secret:latest" \
  --set-env-vars "SITE_URL=${SITE_URL},NEXT_PUBLIC_SITE_URL=${SITE_URL},EXTRACTION_V2_ENABLED=true,GOTENBERG_URL=https://scholera-deck-converter-7cmrekqoxa-uc.a.run.app,EXTRACTION_WORKER_KICK_URL=${SITE_URL}/api/extraction-worker/kick"

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)" 2>/dev/null)
echo -e "\n${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Staging deployed.${NC}"
echo -e "${GREEN}  Service:  $SERVICE_NAME ($COMMIT_SHA)${NC}"
echo -e "${GREEN}  Supabase: $STAGING_REF${NC}"
echo -e "${GREEN}  Live at:  $SERVICE_URL${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Wake the (possibly auto-paused) free-tier Supabase project so the first real
# request doesn't eat the cold-start. Best-effort; never fails the deploy.
curl -fsS -I -o /dev/null "${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/" \
  -H "apikey: ${NEXT_PUBLIC_SUPABASE_ANON_KEY}" 2>/dev/null \
  && pass "Pinged staging Supabase (awake)" || warn "Supabase ping failed (it may be resuming)."
