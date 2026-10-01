-- ============================================================
-- Athena on the Projects authoring surface gets its own rate-limit pool
-- ============================================================
-- The project detail screen (Phases + Rubric) gains an embedded Athena: the
-- 'project' authoring kind on /api/assignment-assistant. Same pattern as the
-- About pool (20260817214138) and the tutor pool (20260805150929) — nothing new
-- is built, the surface becomes another SCOPE on the existing hardened, atomic,
-- rolling-window counter, with its own independent pool at the same caps, so
-- draining it never starves the console or any other authoring surface.
--
-- CHECK-constraint widening ONLY: no new table, no RLS or policy work, no new
-- RPC, no grant changes. Enforcement stays in code (ATHENA_LIMIT_SCOPES in
-- src/lib/ai/professor-assistant/models.ts).
--
-- Adding a scope stays a deliberate migration because each new pool raises the
-- per-user daily cost ceiling by a full set of caps (~$1.65/day at current caps
-- — see docs/reference/athena-cost-analysis.md).
--
-- ORDERING MATTERS: apply this BEFORE deploying the code that sends the new
-- scope. Supabase migrations and the Cloud Run deploy are independent steps, and
-- reserveAthenaSlot fails OPEN by design — so code-first does not error loudly,
-- it silently stops capping this surface entirely until the migration lands.
-- ============================================================

-- Postgres has no CREATE CONSTRAINT IF NOT EXISTS, and re-adding an existing
-- constraint aborts the transaction — so drop first, unconditionally, BEFORE the
-- add. Re-running this migration must be a no-op, not a halt.
alter table public.athena_rate_limits
  drop constraint if exists athena_rate_limits_scope_check;

alter table public.athena_rate_limits
  add constraint athena_rate_limits_scope_check
  check (scope in ('console', 'assignment', 'quiz', 'grade', 'tutor', 'about', 'project'));

comment on constraint athena_rate_limits_scope_check on public.athena_rate_limits is
  'One pool per Athena surface. Must stay in sync with ATHENA_LIMIT_SCOPES in src/lib/ai/professor-assistant/models.ts — a scope the code sends but the constraint rejects would fail every request on that surface.';
