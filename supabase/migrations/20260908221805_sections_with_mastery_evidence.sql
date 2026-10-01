-- sections_with_mastery_evidence() — the section list for the nightly Topic
-- Mastery sweep (POST /api/skills/recompute-sweep).
--
-- Why a function instead of four queries from the route. The sweep needs the
-- DISTINCT set of sections that have any mastery evidence. PostgREST cannot do
-- DISTINCT, so the route was reading every row of four tables and de-duplicating
-- in JS. Two problems with that, both of which end in the sweep silently missing
-- sections — the exact bug the sweep was just fixed for:
--
--   1. It needs a page ceiling to bound runtime under the route's 60s limit, and
--      any ceiling truncates deterministically by sort order. Past the ceiling
--      the SAME sections drop out every night rather than a different slice each
--      time, so the backstop quietly stops covering them. quiz_questions is the
--      fastest-growing of the four and is the one that would trip it.
--   2. Offset paging over `id` (a random v4 uuid) can skip a row when a
--      concurrent insert sorts ahead of the current offset. Skipping one row
--      only loses a section when it was that section's only row, but that is
--      exactly a new section with its first quiz question.
--
-- One round trip removes both. The union is computed and de-duplicated in
-- Postgres, so there is no row cap and no pagination to get wrong.
--
-- Deliberately coarse: "has a module" not "has an extracted module", "has an
-- assignment" not "has a graded submission". Narrowing it costs an unindexed
-- scan on module_items' jsonb, and enqueuing a section with no evidence is cheap
-- because recomputeSectionMastery is idempotent and early-returns.
--
-- Cross-tenant by design. This is a platform cron, not a user-facing read, and
-- it returns section ids only. SECURITY INVOKER, called with the service role,
-- and EXECUTE is revoked from every client role below.

create or replace function public.sections_with_mastery_evidence()
returns table (section_id uuid)
language sql
stable
security invoker
set search_path = public
as $$
  select s.section_id from public.skills s
  union
  select q.section_id from public.quiz_questions q
  union
  select a.section_id from public.assignments a
  union
  select m.section_id from public.modules m
$$;

comment on function public.sections_with_mastery_evidence() is
  'Distinct sections with any Topic Mastery evidence. Service-only; backs the nightly recompute sweep.';

-- Service-only. CREATE FUNCTION grants EXECUTE to PUBLIC by default and
-- anon/authenticated inherit it, so revoke all three (see
-- 20260717060430_rpc_grant_hardening_repair.sql).
revoke execute on function public.sections_with_mastery_evidence() from public, anon, authenticated;

-- Then hand it back to service_role, which is the only caller. It inherited
-- EXECUTE through PUBLIC, so the revoke above takes it away too and the route
-- 500s on "permission denied for function". Verified against a local database:
-- without this line service_role is denied along with anon and authenticated.
-- Matches the grant shape of the other service-only skill RPCs
-- (replace_section_skill_mastery, reorder_skills, confirm_skill_review), which
-- all sit at postgres + service_role.
grant execute on function public.sections_with_mastery_evidence() to service_role;
