-- Close the last of the local↔prod schema drift, in the ADDITIVE direction.
--
-- Background: 00000000000068_reconcile_prod_drift.sql caught up everything that
-- existed in prod but not in the migration set. It explicitly deferred two
-- columns going the OTHER way — present locally (from the base schema) but
-- missing in prod:
--
--     events.created_at              timestamptz default now()
--     department_faculty.role        text default 'member'
--
-- That migration framed reconciling them as DROPPING the local columns, called
-- that destructive, and left it for a human decision. This takes the opposite,
-- non-destructive direction: ADD them to prod so the two schemas finally agree.
--
-- WHY THIS MATTERS (the concrete failure it prevents): a migration written and
-- tested against a local `supabase db reset` can reference these columns, pass
-- review, merge, and then FAIL on prod. CI never catches it — it runs lint,
-- typecheck, build and unit tests, and never applies migrations to a database.
-- That is exactly what happened to 20260731180233_profiles_last_active_at.sql
-- (PR #496): its backfill read events.created_at and errored with
-- `42703: column "created_at" does not exist` on prod, after review had passed.
-- With this applied, that class of failure stops being possible.
--
-- IDEMPOTENT BY DESIGN, following migration 68's pattern: every statement uses
-- IF NOT EXISTS, so on a fresh local DB (where the base schema already created
-- both columns) this is a no-op, and re-running it against prod is safe.
--
-- Column types/defaults are copied VERBATIM from the local base schema
-- (00000000000000_base_schema.sql) — not hand-invented — so the two sides match
-- exactly rather than approximately.

BEGIN;

-- ── events.created_at ──────────────────────────────────────────────────────
-- NOTE the backfill. `ADD COLUMN ... DEFAULT now()` stamps every existing row
-- with the migration's clock, which would assert that all 5,509 historical
-- events were created at deploy time. `events.timestamp` is the real event
-- time (same `default now()` semantics, populated since 2026-02), so copy it
-- across and keep the column truthful for anything that later reads it.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

UPDATE public.events
SET created_at = timestamp
WHERE timestamp IS NOT NULL
  AND created_at IS DISTINCT FROM timestamp;

-- ── department_faculty.role ────────────────────────────────────────────────
-- Postgres backfills existing rows with the default, so the 12 current rows
-- land on 'member' — the same value a locally-created row gets today.
ALTER TABLE public.department_faculty
  ADD COLUMN IF NOT EXISTS role text DEFAULT 'member';

COMMIT;

-- No RLS changes: both tables already have RLS enabled with their existing
-- policies, and adding a column does not alter policy coverage. Neither column
-- is tenant-scoping data, so no policy needs to reference it.
