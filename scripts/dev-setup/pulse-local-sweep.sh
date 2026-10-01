#!/bin/bash
# Local stand-in for the production Cloud Scheduler that calls the Scholera Pulse
# notifications cron endpoint. There is no Cloud Scheduler on a dev machine, so
# scheduled-assignment publishes (done by the publish_scheduled_assignments pg_cron
# job) would never get their notification without something poking the endpoint.
#
# Prod calls the endpoint every 5 min; locally we poll faster so notifications show
# up promptly while testing. Run this in a spare terminal; Ctrl-C to stop.
#
#   bash scripts/dev-setup/pulse-local-sweep.sh
#
# Env overrides: PULSE_CRON_URL, NOTIFICATIONS_CRON_SECRET, PULSE_SWEEP_INTERVAL.

set -uo pipefail

URL="${PULSE_CRON_URL:-http://localhost:3000/api/notifications/cron}"
SECRET="${NOTIFICATIONS_CRON_SECRET:-local-dev-cron-secret}"
INTERVAL="${PULSE_SWEEP_INTERVAL:-60}"

echo "Pulse local sweep → POST $URL every ${INTERVAL}s (Ctrl-C to stop)"
while true; do
  resp=$(curl -s -X POST "$URL" -H "Authorization: Bearer $SECRET" 2>/dev/null || echo '{"error":"unreachable"}')
  echo "[$(date '+%H:%M:%S')] $resp"
  sleep "$INTERVAL"
done
