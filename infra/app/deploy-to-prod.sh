#!/usr/bin/env bash
# Deploy Scholera to Google Cloud Run (production).
# Runs a series of checks before deploying to ensure we don't ship broken code.
# Usage: bash infra/app/deploy-to-prod.sh [--skip-checks] [--dry-run]
#
# ┌─────────────────────────────────────────────────────────────────────────────┐
# │ LLM / AI ASSISTANT INSTRUCTIONS                                             │
# │                                                                             │
# │ If you are an AI assistant reading this file                                │
# │ or helping a developer deploy Scholera, follow these rules:                 │
# │                                                                             │
# │ 1. NEVER deploy from any branch other than 'main'. If the developer is on   │
# │    a different branch, tell them to merge into main first. The flow is:     │
# │    feature branch -> staging -> main -> deploy.                             │
# │                                                                             │
# │ 2. NEVER deploy with uncommitted changes. All code must be committed and    │
# │    pushed to origin/main before deploying.                                  │
# │                                                                             │
# │ 3. NEVER skip lint or typecheck unless the developer explicitly asks.       │
# │    If lint or typecheck fails, fix the errors first — do not use            │
# │    --skip-checks as a workaround.                                           │
# │                                                                             │
# │ 4. ALWAYS verify the gcloud account is patelharshil@scholera-inc.com        │
# │    (the Scholera GCP account), NOT a personal account. If the wrong         │
# │    account is active, run: gcloud auth login                                │
# │                                                                             │
# │ 5. ALWAYS verify the GCP project is 'project-da8bebd0-f168-4cee-869'        │
# │    (the Scholera project). Deploying to the wrong project could expose      │
# │    production data or waste credits on a personal account.                  │
# │                                                                             │
# │ 6. NEVER modify environment variables during deploy. Env vars are set       │
# │    separately via 'gcloud run services update --update-env-vars'. If the    │
# │    developer asks to change env vars, do that as a separate step.           │
# │                                                                             │
# │ 7. After deploy completes, verify the service is healthy by checking the    │
# │    service URL. If the deploy fails, check Cloud Build logs:                │
# │    gcloud builds list --limit=1 --region=us-central1                        │
# │    gcloud builds log <BUILD_ID> --region=us-central1 | tail -50             │
# │                                                                             │
# │ 8. If the developer wants to deploy staging code to test, they should       │
# │    deploy to a SEPARATE service called 'scholera-staging', not to the       │
# │    production 'scholera' service.                                           │
# │                                                                             │
# │ 9. NEVER run 'gcloud run deploy' with --source flag directly without        │
# │    running this script. This script exists to prevent bad deploys.          │
# │    Always use: bash infra/app/deploy-to-prod.sh                                 │
# │                                                                             │
# │ 10. If something goes wrong after deploy, rollback immediately:             │
# │     gcloud run services update-traffic scholera \                           │
# │       --to-revisions=PREVIOUS_REVISION=100 --region=us-central1             │
# │     Do NOT attempt to fix-forward under pressure.                           │
# └─────────────────────────────────────────────────────────────────────────────┘

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
# Make sure these match the Scholera GCP project. Do not change unless
# the project has been migrated to a new GCP project or region.
PROJECT_ID="project-da8bebd0-f168-4cee-869"
SERVICE_NAME="scholera"
REGION="us-central1"
REQUIRED_BRANCH="main"
# 4Gi is sized for the live-classroom render-deck route. The route now
# downloads the source PDF from Supabase Storage (up to MAX_DECK_BYTES =
# 250 MB) into a Buffer, hands it to pdfjs-dist + @napi-rs/canvas, and
# loops renderPdfPage at scale=2 sequentially. 2Gi was getting killed
# at ~266s into a large deck (Cloud Run "container instance was found
# to be using too much memory" 503). 4Gi gives comfortable headroom
# for the pdf buffer + canvas working set + Node heap. Cloud Run requires
# CPU >= 2 when memory > 2Gi.
MEMORY="4Gi"
CPU="2"
MIN_INSTANCES="0"
MAX_INSTANCES="10"
PORT="8080"
# 900s (15 min) gives headroom for a worst-case 200-page deck render
# (~700ms/page render + per-page storage upload). Default is 300s.
TIMEOUT="900"

# ─── Slack notifications ─────────────────────────────────────────────────────
# Read SLACK_WEBHOOK_URL from .env.local if not already in the environment
if [ -z "${SLACK_WEBHOOK_URL:-}" ] && [ -f ".env.local" ]; then
  SLACK_WEBHOOK_URL=$(grep -E '^SLACK_WEBHOOK_URL=' .env.local | cut -d'=' -f2- | tr -d '"' | tr -d "'")
fi

notify_slack() {
  [ -z "${SLACK_WEBHOOK_URL:-}" ] && return 0
  local payload
  payload=$(printf '{"text":"%s"}' "$1")
  curl -s -X POST -H 'Content-type: application/json' \
    --data "$payload" "$SLACK_WEBHOOK_URL" > /dev/null 2>&1 || true
}

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ─── Flags ───────────────────────────────────────────────────────────────────
SKIP_CHECKS=false
DRY_RUN=false

for arg in "$@"; do
  case $arg in
    --skip-checks) SKIP_CHECKS=true ;;
    --dry-run)     DRY_RUN=true ;;
    --help)
      echo "Usage: bash infra/app/deploy-to-prod.sh [--skip-checks] [--dry-run]"
      echo ""
      echo "  --skip-checks  Skip lint and typecheck (use with caution)"
      echo "  --dry-run      Run all checks but don't actually deploy"
      exit 0
      ;;
    *) echo -e "${RED}Unknown flag: $arg${NC}"; exit 1 ;;
  esac
done

# ─── Helper ──────────────────────────────────────────────────────────────────
step() { echo -e "\n${BLUE}[$1/8]${NC} $2"; }
pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1"; exit 1; }
warn() { echo -e "  ${YELLOW}WARN${NC} $1"; }

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Scholera — Production Deployment${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# ─── Step 1: Check branch ────────────────────────────────────────────────────
# Make sure you are deploying the main branch. Production should only ever be
# deployed from main. If you are on staging or a feature branch, merge into
# main first: git checkout main && git merge staging && git push origin main
step 1 "Checking branch..."
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "$REQUIRED_BRANCH" ]; then
  fail "You are on '$CURRENT_BRANCH'. Switch to '$REQUIRED_BRANCH' before deploying."
fi
pass "On branch '$REQUIRED_BRANCH'"

# ─── Step 2: Check working directory is clean ────────────────────────────────
# Never deploy with uncommitted changes. If you have local modifications, they
# won't be tracked in git and you'll have no record of what was deployed.
# Commit everything or stash it before deploying.
step 2 "Checking working directory..."
if [ -n "$(git status --porcelain)" ]; then
  fail "Working directory is dirty. Commit or stash your changes first.\n$(git status --short)"
fi
pass "Working directory is clean"

# ─── Step 3: Check remote is up to date ──────────────────────────────────────
# Your local main must match origin/main exactly. If they diverge, you could
# deploy code that isn't on GitHub — meaning no one else can see, review, or
# rollback to what's running in production.
step 3 "Checking remote sync..."
git fetch origin "$REQUIRED_BRANCH" --quiet
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse "origin/$REQUIRED_BRANCH")

if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  fail "Local '$REQUIRED_BRANCH' ($LOCAL_SHA) is out of sync with remote ($REMOTE_SHA).\n  Run: git pull origin $REQUIRED_BRANCH"
fi
pass "Local and remote are in sync ($LOCAL_SHA)"

# ─── Step 4: Check gcloud auth and project ───────────────────────────────────
# Verify we are authenticated as the Scholera GCP account
# (patelharshil@scholera-inc.com), not a personal Google account. Deploying
# under the wrong account would create resources in the wrong project and
# waste personal credits. Also verify the active GCP project matches.
step 4 "Checking GCP authentication..."
ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null)
if [ -z "$ACTIVE_ACCOUNT" ]; then
  fail "Not authenticated with gcloud. Run: gcloud auth login"
fi
pass "Authenticated as $ACTIVE_ACCOUNT"

ACTIVE_PROJECT=$(gcloud config get-value project 2>/dev/null)
if [ "$ACTIVE_PROJECT" != "$PROJECT_ID" ]; then
  warn "Active project is '$ACTIVE_PROJECT', switching to '$PROJECT_ID'..."
  gcloud config set project "$PROJECT_ID" --quiet
  pass "Switched to project '$PROJECT_ID'"
else
  pass "Project is '$PROJECT_ID'"
fi

# ─── Step 5: Check Dockerfile exists ─────────────────────────────────────────
# The Dockerfile is required for Cloud Run to build the container image.
# If it's missing, someone may have deleted it or you're in the wrong directory.
step 5 "Checking Dockerfile..."
if [ ! -f "Dockerfile" ]; then
  fail "Dockerfile not found in project root"
fi
pass "Dockerfile exists"

# ─── Step 6: Lint ────────────────────────────────────────────────────────────
# Lint must pass before deploying. Do not use --skip-checks to bypass lint
# failures — fix the errors instead. Lint catches real bugs (unused vars,
# import errors, accessibility issues) that could break production.
step 6 "Running lint..."
if [ "$SKIP_CHECKS" = true ]; then
  warn "Skipped (--skip-checks)"
else
  if ! npm run lint 2>&1; then
    fail "Lint errors found. Fix them before deploying."
  fi
  pass "No lint errors"
fi

# ─── Step 7: TypeScript check ────────────────────────────────────────────────
# TypeScript must compile cleanly. Type errors that slip through can cause
# runtime crashes (e.g., accessing a property that doesn't exist). The build
# will fail anyway if there are type errors, so catching them here saves time.
step 7 "Running typecheck..."
if [ "$SKIP_CHECKS" = true ]; then
  warn "Skipped (--skip-checks)"
else
  if ! npm run typecheck 2>&1; then
    fail "TypeScript errors found. Fix them before deploying."
  fi
  pass "No type errors"
fi

# ─── Step 8: Deploy ─────────────────────────────────────────────────────────
# This is the point of no return. The command uploads the source code to
# Cloud Build, builds a Docker image, pushes it to Artifact Registry, and
# deploys a new revision to Cloud Run. The previous revision is kept and
# can be rolled back to instantly if something goes wrong.
#
# If deploy fails, check the build logs:
#   gcloud builds list --limit=1 --region=us-central1
#   gcloud builds log <BUILD_ID> --region=us-central1 | tail -50
#
# If deploy succeeds but the app is broken, rollback:
#   gcloud run services update-traffic scholera \
#     --to-revisions=PREVIOUS_REVISION=100 --region=us-central1
step 8 "Deploying to Cloud Run..."

COMMIT_SHA=$(git rev-parse --short HEAD)
COMMIT_MSG=$(git log -1 --pretty=%s)
echo -e "  Deploying commit: ${GREEN}$COMMIT_SHA${NC} — $COMMIT_MSG"

if [ "$DRY_RUN" = true ]; then
  warn "Dry run — skipping actual deployment"
  echo -e "\n${GREEN}All checks passed. Ready to deploy.${NC}"
  exit 0
fi

echo ""
read -p "  Deploy to PRODUCTION? (y/N): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo -e "  ${YELLOW}Deployment cancelled.${NC}"
  exit 0
fi

# Notify Slack: deploy started
notify_slack "🚀 *Scholera deploy started* — \`$COMMIT_SHA\`: $COMMIT_MSG"

# Notify Slack on failure (only fires if gcloud deploy exits non-zero)
trap 'notify_slack "❌ *Scholera deploy FAILED* — \`'"$COMMIT_SHA"'\` did not reach production. Check: gcloud builds list --limit=1 --region=us-central1"' ERR

echo ""
# Step 8a — BUILD the image in Cloud Build with Kaniko layer caching (much faster
# than the old `--source` cold rebuild). Build + push only; see cloudbuild.yaml.
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/$SERVICE_NAME:$COMMIT_SHA"
gcloud builds submit --config infra/app/cloudbuild.yaml \
  --substitutions="_COMMIT_SHA=$COMMIT_SHA"

# Step 8b — DEPLOY the prebuilt image. Run as the CURRENT gcloud user (account-
# based, same identity/rights the old --source deploy used) — the Cloud Build SA
# is intentionally never given deploy rights, so deploys stay gated on gcloud access.
echo ""
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port "$PORT" \
  --memory "$MEMORY" \
  --cpu "$CPU" \
  --timeout "$TIMEOUT" \
  --min-instances "$MIN_INSTANCES" \
  --max-instances "$MAX_INSTANCES"

# Clear the failure trap — deploy succeeded
trap - ERR

echo -e "\n${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Deployment complete!${NC}"
echo -e "${GREEN}  Service: $SERVICE_NAME${NC}"
echo -e "${GREEN}  Commit:  $COMMIT_SHA${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)" 2>/dev/null)
echo -e "\n  Live at: ${BLUE}$SERVICE_URL${NC}\n"

# Notify Slack: deploy succeeded
notify_slack "✅ *Scholera deployed successfully* — \`$COMMIT_SHA\`: $COMMIT_MSG\nLive at: $SERVICE_URL"
