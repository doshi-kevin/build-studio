#!/usr/bin/env bash
# Set up the Studio Stage 2 validator runner on Google Cloud: a Cloud Run job that runs
# one plugin validation per execution in a container with no IAM roles and no route to
# anything but Google APIs. See README.md in this folder for what each piece is for and
# what has not been verified yet.
#
# Usage:
#   bash infra/validator-runner/deploy.sh [--project ID] [--region REGION]   # dry run
#   bash infra/validator-runner/deploy.sh --apply --project ID [--region REGION]
#
# A dry run prints every command and calls nothing. --apply executes them, and needs
# --project on the command line so the target is never picked up by accident.
#
# Required environment:
#   APP_SERVICE_ACCOUNT       the Scholera app's service account email
#   PLAYWRIGHT_IMAGE_DIGEST   64 hex digits: the digest of
#                             mcr.microsoft.com/playwright:v1.61.0-noble
#   ADMIN_GROUP               Google group email that may read job executions
# Optional environment: PROJECT (dry run only; --apply needs --project), REGION
# (default us-central1).
#
# Every step is safe to re-run: missing resources are created, existing ones are
# brought back to the settings below.

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
step() { echo -e "\n${BLUE}>${NC} $1"; }
pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1" >&2; exit 1; }

# ─── Flags ───────────────────────────────────────────────────────────────────
APPLY=false
PROJECT_FLAG=""
REGION="${REGION:-us-central1}"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)   APPLY=true ;;
    --project) PROJECT_FLAG="${2:-}"; shift ;;
    --region)  REGION="${2:-}"; shift ;;
    --help)    sed -n '2,24p' "$0"; exit 0 ;;
    *)         fail "Unknown argument: $1" ;;
  esac
  shift
done

if [ "$APPLY" = true ]; then
  [ -n "$PROJECT_FLAG" ] || fail "--apply needs an explicit --project."
  PROJECT="$PROJECT_FLAG"
else
  PROJECT="${PROJECT_FLAG:-${PROJECT:-}}"
fi

# ─── Inputs ──────────────────────────────────────────────────────────────────
[ -n "$PROJECT" ] || fail "Set the project with --project (or PROJECT for a dry run)."
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail "PROJECT ($PROJECT) is not a valid project ID."
[[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || fail "REGION ($REGION) is not a valid region."
APP_SA="${APP_SERVICE_ACCOUNT:-}"
[[ "$APP_SA" =~ ^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$ ]] || fail "APP_SERVICE_ACCOUNT must be a service account email."
BASE_DIGEST="${PLAYWRIGHT_IMAGE_DIGEST:-}"
BASE_DIGEST="${BASE_DIGEST#sha256:}"
[[ "$BASE_DIGEST" =~ ^[0-9a-f]{64}$ ]] || fail "PLAYWRIGHT_IMAGE_DIGEST must be the 64 hex digits of the base image digest."
[[ "${ADMIN_GROUP:-}" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]+$ ]] || fail "ADMIN_GROUP must be a Google group email."

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AR_REPO="studio-validator"
IMAGE_PATH="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/runner"
JOB="studio-validator-runner"
RUNNER_SA_NAME="studio-validator-runner"
RUNNER_SA="${RUNNER_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
NETWORK="studio-validator-vpc"
SUBNET="studio-validator-subnet"
SUBNET_RANGE="10.88.0.0/26"   # Direct VPC egress needs at least a /26.
VIP_RANGE="199.36.153.4/30"   # restricted.googleapis.com
DNS_ZONE="studio-validator-googleapis"
ROUTE="studio-validator-restricted-vip"
FW_ALLOW="studio-validator-allow-google-apis"
FW_DENY="studio-validator-deny-all-egress"
BUCKET="${PROJECT}-studio-validator"

# run: a command that changes something. Printed in a dry run, executed with --apply.
run() {
  if [ "$APPLY" = true ]; then
    echo "  + gcloud$(printf ' %q' "$@")"
    gcloud "$@" --project="$PROJECT" --quiet
  else
    echo "  [dry run] gcloud$(printf ' %q' "$@" "--project=$PROJECT")"
  fi
}
# exists: a read-only check. A dry run calls nothing and treats the resource as missing,
# so the create command is what gets printed.
exists() {
  [ "$APPLY" = true ] || return 1
  gcloud "$@" --project="$PROJECT" --quiet >/dev/null 2>&1
}
# read_value: a read-only query whose output the script uses. A dry run prints the
# query and returns the placeholder.
read_value() {
  local placeholder="$1"; shift
  if [ "$APPLY" = true ]; then
    gcloud "$@" --project="$PROJECT" --quiet
  else
    echo "  [dry run] would read: gcloud$(printf ' %q' "$@" "--project=$PROJECT")" >&2
    printf '%s' "$placeholder"
  fi
}

echo -e "${BLUE}Studio validator runner: ${PROJECT} (${REGION})${NC}"
if [ "$APPLY" = true ]; then
  echo -e "  ${YELLOW}--apply: changes will be made.${NC}"
else
  echo -e "  ${YELLOW}Dry run: nothing is called. Re-run with --apply --project ${PROJECT} to execute.${NC}"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ─── Auth and APIs ───────────────────────────────────────────────────────────
step "GCP auth and APIs"
if [ "$APPLY" = true ]; then
  ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null || true)
  [ -n "$ACCOUNT" ] || fail "Not authenticated. Run: gcloud auth login"
  pass "Authenticated as $ACCOUNT"
fi
run services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  compute.googleapis.com dns.googleapis.com storage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com

# ─── Image ───────────────────────────────────────────────────────────────────
step "Runner image"
exists artifacts repositories describe "$AR_REPO" --location="$REGION" ||
  run artifacts repositories create "$AR_REPO" --repository-format=docker --location="$REGION" \
    --description="Studio Stage 2 validator runner"

# The build context holds only the Dockerfile and the built runner.
STAGE="$WORK/context"
if [ "$APPLY" = true ]; then
  mkdir -p "$STAGE"
  node "$REPO_ROOT/validator-runtime/build.mjs" --out "$STAGE/validator-runtime/dist"
  [ -f "$STAGE/validator-runtime/dist/cloud-entry.mjs" ] || fail "validator-runtime/build.mjs produced no cloud-entry.mjs."
  cp "$REPO_ROOT/infra/validator-runner/Dockerfile" "$STAGE/Dockerfile"
  # Without its own ignore file, gcloud would apply the repository's .gitignore rules.
  : > "$STAGE/.gcloudignore"
else
  echo "  [dry run] node validator-runtime/build.mjs --out <temp>/validator-runtime/dist"
fi
TAG="${IMAGE_PATH}:$(date -u +%Y%m%d%H%M%S)"
cat > "$WORK/cloudbuild.yaml" <<YAML
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '--build-arg', 'PLAYWRIGHT_IMAGE_DIGEST=${BASE_DIGEST}', '-t', '${TAG}', '.']
images: ['${TAG}']
YAML
run builds submit "$STAGE" --config="$WORK/cloudbuild.yaml"
DIGEST=$(read_value "sha256:<digest>" artifacts docker images describe "$TAG" --format="value(image_summary.digest)")
if [ "$APPLY" = true ]; then
  [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Could not resolve the built image to a digest (got '$DIGEST')."
fi
IMAGE="${IMAGE_PATH}@${DIGEST}"
pass "Image: $IMAGE"

# ─── Runner service account: no roles ────────────────────────────────────────
step "Runner service account"
exists iam service-accounts describe "$RUNNER_SA" ||
  run iam service-accounts create "$RUNNER_SA_NAME" --display-name="Studio validator runner (no roles)"
if [ "$APPLY" = true ]; then
  ROLES=$(gcloud projects get-iam-policy "$PROJECT" --flatten="bindings[].members" \
    --filter="bindings.members:serviceAccount:${RUNNER_SA}" --format="value(bindings.role)")
  [ -z "$ROLES" ] || fail "$RUNNER_SA holds project roles ($ROLES). It must hold none: remove them first."
  KEYS=$(gcloud iam service-accounts keys list --iam-account="$RUNNER_SA" --managed-by=user \
    --project="$PROJECT" --format="value(name)")
  [ -z "$KEYS" ] || fail "$RUNNER_SA has user-managed keys. Delete them: the runner never needs one."
  pass "$RUNNER_SA holds no project roles and no keys"
else
  echo "  [dry run] would check that $RUNNER_SA has no project role bindings and no keys"
fi

# ─── Network: Google APIs only ───────────────────────────────────────────────
step "Network"
exists compute networks describe "$NETWORK" ||
  run compute networks create "$NETWORK" --subnet-mode=custom
if exists compute networks subnets describe "$SUBNET" --region="$REGION"; then
  run compute networks subnets update "$SUBNET" --region="$REGION" --enable-private-ip-google-access
else
  run compute networks subnets create "$SUBNET" --network="$NETWORK" --region="$REGION" \
    --range="$SUBNET_RANGE" --enable-private-ip-google-access
fi

# No Cloud NAT anywhere on this network: without one, nothing in it reaches the internet.
if [ "$APPLY" = true ]; then
  # Assigned first: a failure inside a for-list substitution would not stop the script.
  ROUTERS=$(gcloud compute routers list --filter="network:${NETWORK}" --format="value(name)" --project="$PROJECT")
  for router in $ROUTERS; do
    NATS=$(gcloud compute routers nats list --router="$router" --region="$REGION" --format="value(name)" --project="$PROJECT")
    [ -z "$NATS" ] || fail "Router $router on $NETWORK has Cloud NAT ($NATS). The runner network must have none."
  done
  pass "No Cloud NAT on $NETWORK"
else
  echo "  [dry run] would check that no router on $NETWORK has a Cloud NAT"
fi

exists compute routes describe "$ROUTE" ||
  run compute routes create "$ROUTE" --network="$NETWORK" --destination-range="$VIP_RANGE" \
    --next-hop-gateway=default-internet-gateway --priority=100

if exists compute firewall-rules describe "$FW_ALLOW"; then
  run compute firewall-rules update "$FW_ALLOW" --rules=tcp:443 --destination-ranges="$VIP_RANGE" --priority=100
else
  run compute firewall-rules create "$FW_ALLOW" --network="$NETWORK" --direction=EGRESS --action=ALLOW \
    --rules=tcp:443 --destination-ranges="$VIP_RANGE" --priority=100
fi
if exists compute firewall-rules describe "$FW_DENY"; then
  run compute firewall-rules update "$FW_DENY" --rules=all --destination-ranges=0.0.0.0/0 --priority=65000
else
  run compute firewall-rules create "$FW_DENY" --network="$NETWORK" --direction=EGRESS --action=DENY \
    --rules=all --destination-ranges=0.0.0.0/0 --priority=65000
fi

# Every *.googleapis.com name resolves to the restricted VIP inside this network.
exists dns managed-zones describe "$DNS_ZONE" ||
  run dns managed-zones create "$DNS_ZONE" --dns-name=googleapis.com. --visibility=private \
    --networks="$NETWORK" --description="Google APIs through restricted.googleapis.com only"
record() { # name type rrdatas
  if exists dns record-sets describe "$1" --type="$2" --zone="$DNS_ZONE"; then
    run dns record-sets update "$1" --type="$2" --zone="$DNS_ZONE" --ttl=300 --rrdatas="$3"
  else
    run dns record-sets create "$1" --type="$2" --zone="$DNS_ZONE" --ttl=300 --rrdatas="$3"
  fi
}
record "*.googleapis.com." CNAME "restricted.googleapis.com."
record "restricted.googleapis.com." A "199.36.153.4,199.36.153.5,199.36.153.6,199.36.153.7"

# ─── Bucket: payloads and reports, deleted after a day ───────────────────────
step "Bucket"
exists storage buckets describe "gs://$BUCKET" ||
  run storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access \
    --public-access-prevention
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}' > "$WORK/lifecycle.json"
run storage buckets update "gs://$BUCKET" --uniform-bucket-level-access --public-access-prevention \
  --lifecycle-file="$WORK/lifecycle.json"

# ─── Job ─────────────────────────────────────────────────────────────────────
step "Cloud Run job"
# No env vars and no secrets on the job itself: each execution's three values come
# from the app as overrides.
run run jobs deploy "$JOB" --region="$REGION" --image="$IMAGE" --service-account="$RUNNER_SA" \
  --tasks=1 --parallelism=1 --max-retries=0 --task-timeout=240s --cpu=2 --memory=2Gi \
  --execution-environment=gen2 --network="$NETWORK" --subnet="$SUBNET" --vpc-egress=all-traffic \
  --clear-env-vars --clear-secrets

# ─── IAM: one job, one bucket, nothing project-wide ──────────────────────────
step "IAM"
run run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="serviceAccount:${APP_SA}" --role=roles/run.jobsExecutorWithOverrides
run run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="serviceAccount:${APP_SA}" --role=roles/run.viewer
run run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="group:${ADMIN_GROUP}" --role=roles/run.viewer
run storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:${APP_SA}" --role=roles/storage.objectAdmin
# Lets the app sign URLs through IAM signBlob, with no key file.
run iam service-accounts add-iam-policy-binding "$APP_SA" \
  --member="serviceAccount:${APP_SA}" --role=roles/iam.serviceAccountTokenCreator

# ─── App configuration ───────────────────────────────────────────────────────
step "Set these on the Scholera app"
cat <<EOF
  STUDIO_VALIDATOR_RUNNER=cloud
  STUDIO_VALIDATOR_GCP_PROJECT=${PROJECT}
  STUDIO_VALIDATOR_REGION=${REGION}
  STUDIO_VALIDATOR_JOB=${JOB}
  STUDIO_VALIDATOR_BUCKET=${BUCKET}
  STUDIO_VALIDATOR_RUNNER_DIGEST=${DIGEST}
EOF
if [ "$APPLY" != true ]; then
  echo -e "\n${YELLOW}Dry run complete. Nothing was changed.${NC}"
fi
