#!/usr/bin/env bash
#
# Spin up a demo university for a client walkthrough.
#
# Creates ONE isolated tenant — Northcrest University — containing a single
# course, three sections, three professors and two dozen students, with a term
# that is already nine weeks in: graded work, mastery trends, live class reports,
# a running team project, and conversation history. Nothing it writes touches any
# other institution.
#
#   bash scripts/demo/seed-demo.sh --local             # create/refresh against local Supabase
#   bash scripts/demo/seed-demo.sh --prod              # create/refresh against production
#   bash scripts/demo/seed-demo.sh --local --reset     # delete the tenant, then rebuild
#   bash scripts/demo/seed-demo.sh --env <file>        # power-user escape hatch: any env file
#
# --local and --prod NEVER read the shared repo-root .env.local — that file
# also drives `npm run dev` and has historically been toggled between local
# and production values for unrelated reasons, which is exactly the kind of
# incidental state this script must never trust. Each target has its own
# dedicated, gitignored file:
#   scripts/demo/.env.demo.local   (optional — see .env.demo.local.example)
#   scripts/demo/.env.demo.prod    (required for --prod — see .env.demo.prod.example)
#
# One of --local, --prod, or --env is REQUIRED. There is no silent default
# that could resolve to production by accident.
#
# Re-running is safe. Every row has a deterministic id, so a second run updates
# the same rows rather than duplicating them, and the logins never change.
#
# Read scripts/demo/CONTEXT.md before changing anything here.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
die() { printf '\n%s ✗ %s%s\n\n' "$RED" "$1" "$OFF" >&2; exit 1; }

ENV_FILE=""
TARGET=""
PASSTHRU=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) TARGET="local"; shift ;;
    --prod)  TARGET="prod"; shift ;;
    --env)   ENV_FILE="${2:-}"; TARGET="env"; shift 2 ;;
    --reset) PASSTHRU+=("--reset"); shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -z "$TARGET" ]] && die "Pass --local, --prod, or --env <file> — there is no default target. Run with -h for details."

# ── Preflight ────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node is not installed."
[[ -d node_modules ]] || die "Dependencies are missing. Run: npm install"
[[ -d node_modules/jspdf ]] || die "jspdf is missing. Run: npm install"

# ── Environment ──────────────────────────────────────────────────────
# Every path below is either an explicit flag or a live LOCAL stack — nothing
# here can silently resolve to production. --prod only ever reads its own
# dedicated file, never the shared repo-root .env.local.
DEMO_ENV_LOCAL="scripts/demo/.env.demo.local"
DEMO_ENV_PROD="scripts/demo/.env.demo.prod"

case "$TARGET" in
  prod)
    ENV_FILE="$DEMO_ENV_PROD"
    [[ -f "$ENV_FILE" ]] || die "No $ENV_FILE found. Copy scripts/demo/.env.demo.prod.example to $ENV_FILE and fill in the real production URL + service role key."
    ;;
  local)
    if command -v supabase >/dev/null 2>&1 && supabase status >/dev/null 2>&1; then
      NEXT_PUBLIC_SUPABASE_URL="$(supabase status -o env 2>/dev/null | sed -n 's/^API_URL="\(.*\)"$/\1/p')"
      SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env 2>/dev/null | sed -n 's/^SERVICE_ROLE_KEY="\(.*\)"$/\1/p')"
      export NEXT_PUBLIC_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
      printf '%s  Using the local Supabase stack.%s\n' "$GRN" "$OFF"
    else
      ENV_FILE="$DEMO_ENV_LOCAL"
      [[ -f "$ENV_FILE" ]] || die "Local Supabase isn't running, and no $ENV_FILE found either. Run 'supabase start', or copy scripts/demo/.env.demo.local.example to $ENV_FILE."
      printf '%s  Local Supabase stack not detected — using %s.%s\n' "$YLW" "$ENV_FILE" "$OFF"
    fi
    ;;
  env)
    [[ -f "$ENV_FILE" ]] || die "Environment file not found: $ENV_FILE"
    ;;
esac

if [[ -n "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | sed 's/[[:space:]]*#.*$//')
  set +a
fi

[[ -n "${NEXT_PUBLIC_SUPABASE_URL:-}" ]]   || die "NEXT_PUBLIC_SUPABASE_URL is not set."
[[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]  || die "SUPABASE_SERVICE_ROLE_KEY is not set."

# Belt and braces on top of the typed-confirmation gate below: if --prod was
# requested but the resolved URL is actually localhost, or --local was
# requested but it resolved to something remote, the file is misconfigured —
# say so plainly rather than letting the mismatch pass silently into the
# generic "REMOTE Supabase project" prompt.
IS_LOCAL_URL=0
[[ "$NEXT_PUBLIC_SUPABASE_URL" == http://127.0.0.1* || "$NEXT_PUBLIC_SUPABASE_URL" == http://localhost* ]] && IS_LOCAL_URL=1
if [[ "$TARGET" == "prod" && "$IS_LOCAL_URL" == "1" ]]; then
  die "--prod was requested but $DEMO_ENV_PROD resolves to a LOCAL URL ($NEXT_PUBLIC_SUPABASE_URL). Check that file."
fi
if [[ "$TARGET" == "local" && "$IS_LOCAL_URL" == "0" ]]; then
  die "--local was requested but resolved to a REMOTE URL ($NEXT_PUBLIC_SUPABASE_URL). Check $DEMO_ENV_LOCAL, or that your local Supabase stack is actually the one running."
fi

# ── Confirm the target ───────────────────────────────────────────────
URL="$NEXT_PUBLIC_SUPABASE_URL"
if [[ "$URL" == http://127.0.0.1* || "$URL" == http://localhost* ]]; then
  printf '  Target: %s%s%s (local)\n' "$BLD" "$URL" "$OFF"
else
  REF="$(printf '%s' "$URL" | sed -n 's#^https://\([^.]*\)\.supabase\.co.*#\1#p')"
  [[ -n "$REF" ]] || die "Could not read a Supabase project ref from $URL"
  export DEMO_CONFIRM_REF="$REF"

  printf '\n%s  This is a REMOTE Supabase project.%s\n' "$YLW" "$OFF"
  printf '    URL:         %s\n' "$URL"
  printf '    Project ref: %s%s%s\n' "$BLD" "$REF" "$OFF"
  printf '\n  The seed only ever writes inside its own Northcrest University tenant,\n'
  printf '  but a remote write is a remote write. Type the institution name to go ahead.\n\n'
  printf '  Institution name: '
  read -r TYPED
  [[ "$TYPED" == "Northcrest University" ]] || die "Not confirmed — nothing was written."
fi

if [[ " ${PASSTHRU[*]:-} " == *" --reset "* ]]; then
  printf '\n%s  --reset will DELETE the Northcrest tenant: every row, every uploaded file,\n' "$YLW"
  printf '  and every @northcrest.edu account. Other institutions are untouched.%s\n\n' "$OFF"
  printf '  Type "reset" to continue: '
  read -r CONFIRM
  [[ "$CONFIRM" == "reset" ]] || die "Not confirmed — nothing was deleted."
fi

# ── Run ──────────────────────────────────────────────────────────────
exec npx tsx --tsconfig scripts/demo/tsconfig.json scripts/demo/seed-demo.ts "${PASSTHRU[@]:-}"
