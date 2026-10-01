#!/bin/bash
# Scholera — one-command local dev setup for interns.
#
# What it does (in order):
#   1. Preflight: Docker installed → Docker running → Supabase CLI available.
#      Each failure prints the exact command/link to fix it.
#   2. Ensure the local Supabase stack is up (auto-starts it if it isn't).
#   3. supabase db reset  → replays ALL migrations = current prod SCHEMA, locally.
#                           Falls back to `migration up` if reset dies partway
#                           through (known upstream CLI bug, see Step 3 below).
#   4. seed-dev.ts        → creates the storage buckets that migrations don't
#                           (course-materials, proctoring-snapshots — made by hand
#                           in the prod dashboard) AND fills the schema with dummy
#                           Scholera Dev data.
#   5. Print the dev logins.
#
# This script reads the LOCAL stack's URL + service key from `supabase status`
# and refuses to run against anything that isn't localhost. It needs NO prod
# credentials and cannot write to production.
#
# Usage:  ./scripts/dev-setup/setup-local.sh
# Read scripts/dev-setup/CONTEXT.md first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

# ── Colors ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}▶${NC} ${BOLD}$1${NC}"; }

echo -e "${BOLD}Scholera — Local Dev Setup${NC}"
echo "──────────────────────────────"

# ── Step 1: preflight — check each prerequisite bottom-up ─────────────
# Failures here print the exact next action so a human OR an AI assistant
# reading the terminal knows precisely what to fix.
step "Preflight checks"

# 1a. Docker CLI installed.
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker is not installed. Supabase runs its local stack in Docker.
     Install Docker Desktop: https://docs.docker.com/desktop
     Then re-run this script."
fi
ok "Docker CLI found"

# 1b. Docker daemon actually running (CLI present but daemon down is the common case).
if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but the daemon isn't running.
     Start Docker Desktop (open the app and wait for the whale icon to settle),
     then re-run this script."
fi
ok "Docker daemon is running"

# 1c. Supabase CLI reachable (we invoke it via npx, but surface a clear error early).
if ! npx --no-install supabase --version >/dev/null 2>&1; then
  fail "Supabase CLI not available via npx.
     Install deps first:  npm install
     (the supabase CLI is a devDependency of this repo)."
fi
ok "Supabase CLI available"

# ── Step 2: ensure the local stack is up (auto-start if needed) ───────
step "Ensuring local Supabase stack is up"
status_env() { npx supabase status -o env >/tmp/scholera-supabase-status.$$ 2>/dev/null; }

if status_env; then
  ok "Local stack already running"
else
  warn "Stack not running — starting it (first run pulls Docker images, can take a few minutes)…"
  if ! npx supabase start; then
    rm -f /tmp/scholera-supabase-status.$$
    fail "supabase start failed. Check the output above; common cause is Docker
     out of memory/disk. After fixing, re-run this script."
  fi
  status_env || { rm -f /tmp/scholera-supabase-status.$$; fail "Stack started but 'supabase status' still failed. Re-run this script."; }
  ok "Local stack started"
fi

# Pull the local URL + service key out of `supabase status -o env`.
# Keys come quoted (KEY="value"); strip the quotes.
API_URL="$(grep '^API_URL=' /tmp/scholera-supabase-status.$$ | cut -d= -f2- | tr -d '"')"
SERVICE_ROLE_KEY="$(grep '^SERVICE_ROLE_KEY=' /tmp/scholera-supabase-status.$$ | cut -d= -f2- | tr -d '"')"
rm -f /tmp/scholera-supabase-status.$$

[ -n "$API_URL" ] || fail "Could not read API_URL from supabase status."
[ -n "$SERVICE_ROLE_KEY" ] || fail "Could not read SERVICE_ROLE_KEY from supabase status."

# Safety gate: only ever target localhost.
case "$API_URL" in
  http://127.0.0.1:*|http://localhost:*) ok "Local stack at $API_URL" ;;
  *) fail "API_URL=$API_URL is not local. Refusing to run." ;;
esac

# ── Step 3: reset schema from migrations ──────────────────────────────
step "Resetting local DB (replaying migrations = current prod schema)"
warn "This WIPES your local database and rebuilds it from supabase/migrations/."
if ! npx supabase db reset; then
  # Known upstream bug (github.com/supabase/cli#5139): right after `db reset`
  # recreates the Postgres container, the CLI can fail on a multi-statement
  # migration with SQLSTATE 42601 ("cannot insert multiple commands into a
  # prepared statement"), even though the SQL is valid (confirmed by applying
  # the same file directly with psql — it works). `db reset` already recorded
  # every migration that DID apply before it died, so `migration up` — the
  # CLI's own mechanism for applying whatever's left — finishes the job. This
  # is a confirmed recovery, not a guess: it unblocked two independent runs
  # while diagnosing the bug. If the failure is a real broken migration
  # instead, `migration up` hits the same error and the fail below still fires.
  warn "db reset failed partway through — this is a known Supabase CLI issue, not a problem with our migrations. Retrying via 'migration up'…"
  npx supabase migration up || fail "Both db reset and migration up failed. Re-run this script. If it keeps failing, run 'npx supabase db reset --debug' and check the actual SQL error."
fi
ok "Schema rebuilt from migrations"

# ── Step 4: ensure storage buckets + seed dummy data ──────────────────
# seed-dev.ts first recreates the storage buckets that no migration creates
# (course-materials, proctoring-snapshots), so uploads work locally, then
# seeds dummy data.
step "Ensuring storage buckets and seeding dummy Scholera Dev data"
NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  npx tsx "$SCRIPT_DIR/seed-dev.ts"

echo -e "\n${GREEN}${BOLD}Done.${NC} Your local Supabase has dummy data and is ready."
echo -e "  Studio: ${CYAN}http://127.0.0.1:54323${NC}"
echo -e "  App:    ${CYAN}http://localhost:3000${NC}  (run: npm run dev)"
