-- Revoke `anon` EXECUTE on the 30 SECURITY DEFINER functions PostgREST exposes.
--
-- Supabase auto-grants EXECUTE to `anon` and `authenticated` on every function it
-- creates, and PostgREST publishes each one at /rest/v1/rpc/<name>. Nothing here
-- asked for those grants; they are the default and were never narrowed. Result:
-- anyone holding the public anon key could call all 30 without signing in.
--
-- Most leak nothing (they key off auth.uid(), which is NULL for anon, so they
-- return false). Five take an EXPLICIT user-id argument, though, so an anonymous
-- caller with two UUIDs could probe the membership graph -- "is user X in team Y"
-- answered truthfully, unauthenticated: is_team_member, is_dm_participant,
-- is_project_member, is_project_owner, is_enrolled_or_professor. That is the hole
-- this closes.
--
-- ══════════════════════════════════════════════════════════════════
-- READ THIS BEFORE "TIDYING" THE REVOKES BELOW INTO ONE UNIFORM LIST
-- ══════════════════════════════════════════════════════════════════
-- The role lists differ per group ON PURPOSE.
--
-- RLS policy expressions are evaluated with the privileges of the QUERYING role,
-- and EXECUTE is enforced there. The 15 `is_*` helpers in section 2 are called
-- inside policy USING clauses on 25 tables. Revoking EXECUTE from `authenticated`
-- on those would make every one of those policies raise
--   ERROR: permission denied for function is_...
-- for every signed-in user -- an app-wide lockout, not a degraded feature.
--
-- So: `authenticated` KEEPS EXECUTE in sections 2 and 4. Only `public` and `anon`
-- lose it. Same selective shape as 00000000000062_lc_revoke_rpc_execute.sql, which
-- revokes lc_user_can_access_room FROM public, anon and leaves authenticated alone.
--
-- REVOKE is idempotent, so re-running this file is a no-op. It takes a catalog lock
-- on each function row only; it does not block in-flight queries against the tables
-- whose policies reference these functions.

-- ══════════════════════════════════════════════════════════════════
-- 1. Trigger + event-trigger functions -- no client role needs EXECUTE
-- ══════════════════════════════════════════════════════════════════
-- Postgres checks EXECUTE on a trigger function at CREATE TRIGGER time, not when
-- the trigger fires, so revoking every client role cannot stop a trigger firing.
-- handle_new_user fires on auth.users as GoTrue's supabase_auth_admin role, so
-- signup is unaffected. Calling any of these directly via /rpc/ is meaningless
-- anyway -- a trigger function invoked outside trigger context just errors.

REVOKE EXECUTE ON FUNCTION public.emit_member_joined_system_message() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enqueue_cleanup_on_module_item_delete() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lc_interactions_after_change() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lc_mirror_current_slide() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lc_responses_after_insert() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lc_rooms_after_insert() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lc_rooms_after_update() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.schedule_assignment_publish() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.schedule_quiz_publish() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_institution_status_to_members() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_institution_to_auth_metadata() FROM public, anon, authenticated;

-- ══════════════════════════════════════════════════════════════════
-- 2. RLS helper predicates -- anon loses EXECUTE, authenticated MUST keep it
-- ══════════════════════════════════════════════════════════════════
-- None of these is called via .rpc() anywhere in src/. They exist only to be
-- called from inside RLS policies. See the warning at the top of this file before
-- adding `authenticated` to any line below.

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_admin_of(uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_dm_participant(uuid, uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_enrolled_in_section(uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_enrolled_or_professor(uuid, uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_professor_of_section(uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_project_member(uuid, uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_project_owner(uuid, uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_section_admin(uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_section_member(uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_section_owner_or_staff(uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_section_staff(uuid, text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_staff_of_section(uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_team_member(uuid, uuid) FROM public, anon;

-- ══════════════════════════════════════════════════════════════════
-- 3. Server-only RPC -- service_role is the only legitimate caller
-- ══════════════════════════════════════════════════════════════════
-- lc_try_drawings_lock is the live-classroom drawings rate limiter
-- (pg_try_advisory_xact_lock). Its only caller is
-- src/lib/live-classroom/drawings/actions.ts, via the admin client. A client role
-- holding EXECUTE would let a student burn another user's rate-limit budget.

REVOKE EXECUTE ON FUNCTION public.lc_try_drawings_lock(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_try_drawings_lock(uuid, uuid) TO service_role;

-- ══════════════════════════════════════════════════════════════════
-- 4. Signed-in RPC -- anon loses EXECUTE, authenticated keeps it
-- ══════════════════════════════════════════════════════════════════
-- professor_busy_times backs the student office-hours booking calendar
-- (src/lib/supabase/queries.ts -> src/app/(dashboard)/student/office-hours).
-- Reached only by signed-in students, so anon has no business calling it -- and
-- unauthenticated it would expose a professor's busy/free schedule by user id.

REVOKE EXECUTE ON FUNCTION public.professor_busy_times(uuid) FROM public, anon;
