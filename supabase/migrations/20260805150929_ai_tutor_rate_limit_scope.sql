-- ============================================================
-- Student AI Tutor gets its own rate-limit pool (pilot follow-up F1)
-- ============================================================
-- The student tutor route (/api/chat) had NO per-user cap. It records spend via
-- recordAiUsage but enforces nothing, so an enrolled student could drive it
-- indefinitely — and since the round-1 prompt change dropped "answer only from
-- the course materials", a materials-free section is effectively a general LLM.
-- That removed the incidental brake that scoping to uploads used to provide.
--
-- Nothing new is built here. The professor-side Athena limiter is already
-- hardened, atomic and rolling-window (20260624130647_athena_rate_limits, then
-- 20260802174306_athena_rate_limit_scope), so the tutor simply becomes another
-- SCOPE on that counter: its own independent pool at the same caps, drawing down
-- neither the console's nor any authoring surface's budget.
--
-- This is a CHECK-constraint widening ONLY — no new table, so no RLS or policy
-- work is in scope here; athena_rate_limits already carries both from its
-- creating migration, and this touches neither. No new RPC, no grant changes.
-- Enforcement logic stays in code (ATHENA_LIMIT_SCOPES in
-- src/lib/ai/professor-assistant/models.ts). Adding a scope stays a deliberate
-- migration because each new pool raises the per-user daily ceiling by a full set
-- of caps.
-- ============================================================

-- Postgres has no CREATE CONSTRAINT IF NOT EXISTS, and re-adding an existing
-- constraint aborts the transaction — so drop first, unconditionally, BEFORE the
-- add. Re-running this migration must be a no-op, not a halt.
alter table public.athena_rate_limits
  drop constraint if exists athena_rate_limits_scope_check;

alter table public.athena_rate_limits
  add constraint athena_rate_limits_scope_check
  check (scope in ('console', 'assignment', 'quiz', 'grade', 'tutor'));

comment on constraint athena_rate_limits_scope_check on public.athena_rate_limits is
  'One pool per Athena surface. Must stay in sync with ATHENA_LIMIT_SCOPES in src/lib/ai/professor-assistant/models.ts — a scope the code sends but the constraint rejects would fail every request on that surface.';
