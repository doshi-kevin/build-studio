#!/usr/bin/env bash
#
# Provisions the GCP Cloud Scheduler jobs that keep prod's scheduled work running:
#   jobs-worker-sweep        */5      drains the background-jobs queue
#   extraction-worker-sweep  */5      drains the extraction queue
#   notifications-pulse      */5      Scholera Pulse (digests, reminders, nudges)
#   lc-deck-reaper           03:00    deletes orphaned live-classroom deck files
#
# The last two were added after an audit found neither had ever run in prod.
# Pulse had no scheduler at all AND denied every request via a NODE_ENV branch.
# The deck reaper existed only as a pg_cron job that failed 134 times out of 134,
# because it deleted from storage.objects directly and Supabase blocks that.
#
# WHY Cloud Scheduler (not GitHub Actions): these sweeps used to run as GitHub
# Actions crons (.github/workflows/jobs-sweep.yml + extraction-sweep.yml). That
# coupled a core prod invariant — "the queue always drains" — to GitHub's
# billing: when org Actions billing lapsed, every workflow silently stopped and
# jobs sat `pending` forever. Cloud Scheduler runs on GCP next to Cloud Run,
# independent of GitHub.
#
# AUTH: each job POSTs to the worker's kick route using that route's existing
# shared-secret header (x-background-jobs-secret / x-extraction-worker-secret).
# The secrets and public URLs are read AT RUN TIME from the deployed Cloud Run
# service — never hardcoded in this repo. (The value does end up stored in the
# created scheduler job config, the same exposure tier as the Cloud Run env var
# it mirrors — anyone with scheduler read access can see it.)
#
# Idempotent: create-or-update. Safe to re-run after a secret rotation or a
# schedule tweak.
#
# STAGING (--staging): creates or updates one job, jobs-worker-sweep-staging, for
# the scholera-staging service, so Studio builds there recover from a lost kick.
# None of the other three jobs is created for staging. Staging injects
# BACKGROUND_JOBS_SECRET from Secret Manager, so the service env holds only a
# secret reference: the value is read from the secret deploy-to-staging.sh
# creates, and the kick URL from the service's plain BACKGROUND_JOBS_KICK_URL.
# Deploy staging once before running this, so the service and secret exist.
#
# Usage:  bash infra/app/setup-sweep-schedulers.sh [--staging]
set -euo pipefail
# The jobs secret travels in the scheduler job's header argument. Keep gcloud from copying
# its command lines, and so that value, into its log files on this machine.
export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true

PROJECT="project-da8bebd0-f168-4cee-869"
REGION="us-central1"
SERVICE="scholera"
# Same name as BG_JOBS_SECRET_NAME in deploy-to-staging.sh.
STAGING_BG_SECRET_NAME="staging-background-jobs-secret"

# Anything but no argument or --staging is refused, so a mistyped flag can never
# fall through to the prod jobs.
TARGET="prod"
case "${1:-}" in
  "") ;;
  --staging) TARGET="staging"; SERVICE="scholera-staging" ;;
  *) echo "Unknown argument: $1. Usage: bash infra/app/setup-sweep-schedulers.sh [--staging]" >&2; exit 1 ;;
esac
[ "$#" -le 1 ] || { echo "Too many arguments. Usage: bash infra/app/setup-sweep-schedulers.sh [--staging]" >&2; exit 1; }
SCHEDULE="*/5 * * * *"
# The kick route drains until the queue is empty or ~840s (maxDuration 900s
# minus a 60s cushion). Give the scheduler attempt room to see a full drain,
# and NO retries — the next 5-min tick is the natural retry, so a slow drain
# can't spawn overlapping retry runs.
ATTEMPT_DEADLINE="600s"

# Print the value of an env var set on the deployed Cloud Run service.
svc_env() {
  gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format=json \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(e['value'] for e in d['spec']['template']['spec']['containers'][0].get('env',[]) if e['name']=='$1'))"
}

# create-or-update an HTTP POST scheduler job with one secret header.
# Args: name, uri, header_name, header_val, [schedule]  (schedule defaults to */5)
upsert_job() {
  local name="$1" uri="$2" header_name="$3" header_val="$4" schedule="${5:-$SCHEDULE}"
  # ^#^ sets '#' as the header-list delimiter so a header VALUE may contain commas.
  local args=(
    --project "$PROJECT" --location "$REGION"
    --schedule "$schedule" --time-zone "Etc/UTC"
    --uri "$uri" --http-method POST
    --headers "^#^content-type=application/json#${header_name}=${header_val}"
    --message-body '{"source":"cloud-scheduler"}'
    --attempt-deadline "$ATTEMPT_DEADLINE"
    --max-retry-attempts 0
  )
  if gcloud scheduler jobs describe "$name" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
    echo "Updating existing scheduler job: $name"
    gcloud scheduler jobs update http "$name" "${args[@]}" >/dev/null
  else
    echo "Creating scheduler job: $name"
    gcloud scheduler jobs create http "$name" "${args[@]}" >/dev/null
  fi
}

if [ "$TARGET" = "staging" ]; then
  gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 \
    || { echo "The '$SERVICE' service doesn't exist yet. Run infra/app/deploy-to-staging.sh first." >&2; exit 1; }
  echo "Reading the kick URL from the '$SERVICE' Cloud Run service…"
  BG_URL="$(svc_env BACKGROUND_JOBS_KICK_URL)"
  SITE_URL="$(svc_env SITE_URL)"
  # The kick must reach the app host. The runtime origin answers 404 to it.
  case "$BG_URL" in
    "${SITE_URL%/}/api/jobs-worker/kick") ;;
    *) echo "BACKGROUND_JOBS_KICK_URL ($BG_URL) is not ${SITE_URL%/}/api/jobs-worker/kick. Re-deploy staging." >&2; exit 1 ;;
  esac
  # Read inside the substitution and never printed. A failed read exits here.
  BG_SECRET="$(gcloud secrets versions access latest --secret="$STAGING_BG_SECRET_NAME" --project "$PROJECT")"
  [ "${#BG_SECRET}" -ge 32 ] || { echo "Secret $STAGING_BG_SECRET_NAME is shorter than 32 characters. Replace it with a generated value." >&2; exit 1; }
  upsert_job "jobs-worker-sweep-staging" "$BG_URL" "x-background-jobs-secret" "$BG_SECRET"
  echo
  echo "Done. Scheduler jobs in ${REGION}:"
  gcloud scheduler jobs list --project "$PROJECT" --location "$REGION" \
    --format='table(name.basename(),schedule,state,lastAttemptTime)'
  exit 0
fi

echo "Reading kick URLs + secrets from the '$SERVICE' Cloud Run service…"
BG_URL="$(svc_env BACKGROUND_JOBS_KICK_URL)"
BG_SECRET="$(svc_env BACKGROUND_JOBS_SECRET)"
EX_URL="$(svc_env EXTRACTION_WORKER_KICK_URL)"
EX_SECRET="$(svc_env EXTRACTION_WORKER_SECRET)"
# The two newer routes are addressed off SITE_URL rather than each carrying its
# own *_KICK_URL env var. Two more variables to keep in sync buys nothing when
# they would only ever be SITE_URL plus a fixed path.
SITE_URL="$(svc_env SITE_URL)"
PULSE_SECRET="$(svc_env NOTIFICATIONS_CRON_SECRET)"

upsert_job "jobs-worker-sweep"       "$BG_URL" "x-background-jobs-secret"   "$BG_SECRET"
upsert_job "extraction-worker-sweep" "$EX_URL" "x-extraction-worker-secret" "$EX_SECRET"
upsert_job "notifications-pulse" "${SITE_URL}/api/notifications/cron" "x-notifications-cron-secret" "$PULSE_SECRET"
# Daily, and deliberately not */5: this walks the whole deck bucket. 03:00 UTC
# matches the pg_cron job it replaces.
upsert_job "lc-deck-reaper" "${SITE_URL}/api/live-classroom/reap-decks" "x-extraction-worker-secret" "$EX_SECRET" "0 3 * * *"

echo
echo "Done. Scheduler jobs in ${REGION}:"
gcloud scheduler jobs list --project "$PROJECT" --location "$REGION" \
  --format='table(name.basename(),schedule,state,lastAttemptTime)'
