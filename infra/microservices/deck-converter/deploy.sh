#!/usr/bin/env bash
# Deploy the Live Classroom PPTX→PDF converter (Gotenberg) to Cloud Run.
#
# This is a SEPARATE Cloud Run service from the main app. It runs the stock,
# battle-tested Gotenberg image (LibreOffice under the hood) so the heavy
# converter dependency never bloats the main app image. The app calls it over
# authenticated HTTP (Google ID token); see README.md for the full runbook,
# including the one-time IAM grant and the GOTENBERG_URL wiring on the app.
#
# Usage: bash infra/microservices/deck-converter/deploy.sh [--dry-run]
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │ AI ASSISTANT / OPERATOR NOTES                                            │
# │ 1. This deploys a PUBLIC IMAGE — no source build. Safe to re-run.         │
# │ 2. Service is IAM-locked (--no-allow-unauthenticated). It is NOT          │
# │    reachable without an ID token from an authorized service account.      │
# │ 3. --concurrency=1 is REQUIRED: LibreOffice is single-threaded and        │
# │    corrupts under concurrent load. Scale horizontally via --max-instances.│
# │ 4. After first deploy you MUST grant the app's runtime service account    │
# │    roles/run.invoker on this service, then set GOTENBERG_URL on the app.  │
# │    See README.md → "First-time setup".                                    │
# └──────────────────────────────────────────────────────────────────────────┘

set -euo pipefail

# ─── Config (matches infra/deploy-to-prod.sh) ────────────────────────────────
PROJECT_ID="project-da8bebd0-f168-4cee-869"
REGION="us-central1"
SERVICE_NAME="scholera-deck-converter"
# Pin the major+variant. For maximum reproducibility, pin a digest instead:
#   IMAGE="gotenberg/gotenberg@sha256:<digest>"
IMAGE="gotenberg/gotenberg:8-cloudrun"

MEMORY="2Gi"      # LibreOffice needs ~1-2Gi; 2Gi gives headroom.
CPU="2"
CONCURRENCY="1"   # CRITICAL: one conversion per instance (LibreOffice limitation).
MIN_INSTANCES="0" # Scale to zero — no idle cost. Bump to 1 if cold-start latency bites profs.
MAX_INSTANCES="5" # Horizontal scaling handles concurrent profs.
TIMEOUT="300"     # A single conversion should never approach this.
PORT="3000"       # Gotenberg's default listen port.

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
DRY_RUN=false
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --help) echo "Usage: bash infra/microservices/deck-converter/deploy.sh [--dry-run]"; exit 0 ;;
    *) echo -e "${RED}Unknown flag: $arg${NC}"; exit 1 ;;
  esac
done

echo -e "${BLUE}━━━ Scholera Deck Converter (Gotenberg) deploy ━━━${NC}"

# ─── Verify gcloud auth + project ────────────────────────────────────────────
ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null || true)
[ -z "$ACTIVE_ACCOUNT" ] && { echo -e "${RED}Not authenticated. Run: gcloud auth login${NC}"; exit 1; }
echo -e "  ${GREEN}Authenticated as $ACTIVE_ACCOUNT${NC}"

ACTIVE_PROJECT=$(gcloud config get-value project 2>/dev/null || true)
if [ "$ACTIVE_PROJECT" != "$PROJECT_ID" ]; then
  echo -e "  ${YELLOW}Switching project to $PROJECT_ID${NC}"
  gcloud config set project "$PROJECT_ID" --quiet
fi
echo -e "  Image:   ${GREEN}$IMAGE${NC}"
echo -e "  Service: ${GREEN}$SERVICE_NAME${NC} (${REGION})"
echo -e "  Limits:  ${MEMORY} / ${CPU} CPU / concurrency=${CONCURRENCY} / max=${MAX_INSTANCES}"

if [ "$DRY_RUN" = true ]; then
  echo -e "\n${YELLOW}Dry run — not deploying.${NC}"; exit 0
fi

read -p "  Deploy converter to PRODUCTION? (y/N): " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo -e "  ${YELLOW}Cancelled.${NC}"; exit 0; }

gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --no-allow-unauthenticated \
  --port "$PORT" \
  --memory "$MEMORY" \
  --cpu "$CPU" \
  --concurrency "$CONCURRENCY" \
  --timeout "$TIMEOUT" \
  --min-instances "$MIN_INSTANCES" \
  --max-instances "$MAX_INSTANCES"

URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)" 2>/dev/null)
echo -e "\n${GREEN}Deployed.${NC} Converter URL: ${BLUE}${URL}${NC}"
echo -e "Next: grant the app's service account run.invoker, then set GOTENBERG_URL=${URL} on the app."
echo -e "See infra/microservices/deck-converter/README.md → First-time setup."
