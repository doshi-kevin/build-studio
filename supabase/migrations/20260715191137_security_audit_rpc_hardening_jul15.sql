-- ============================================================================
-- Security audit remediation (2026-07-15) — harden identity-parameterized
-- SECURITY DEFINER functions against unauthenticated / cross-tenant IDOR.
--
-- ROOT CAUSE: migration 00000000000070_reconcile_prod_schema_drift.sql recreated
-- these prod functions VERBATIM without the revoke-execute / search_path /
-- caller-identity hardening the rest of the codebase applies. Each takes the
-- caller identity as a `p_user_id` PARAMETER (instead of reading auth.uid()),
-- is SECURITY DEFINER (bypasses RLS), and is EXECUTE-able by `anon`. A direct
-- POST /rest/v1/rpc/<fn> with only the public anon key and any victim UUID
-- therefore returns that victim's data across every tenant.
--
-- VERIFIED LIVE 2026-07-15 (read-only): with the anon key alone,
-- get_dm_unread_counts + get_visible_profile_ids returned a victim's DM partner
-- list and visible-profile graph. The guarded bodies below were proven (in a
-- rolled-back tx) to return the caller's own data (8 rows) but 0 rows when an
-- authenticated caller passes a foreign id.
--
-- Fix strategy is per-function, driven by how each is reachable:
--   * get_dm_unread_counts / get_teammate_ids — NOT referenced by any RLS policy
--     and only ever called via the service-role admin client (or not at all),
--     so revoke EXECUTE from public, anon AND authenticated outright, and
--     re-grant to service_role. service_role keeps access, so the app is
--     unaffected.
--   * get_visible_profile_ids / can_access_phase — BACK RLS policies that call
--     them as fn(auth.uid()), so authenticated must keep EXECUTE. Instead add an
--     internal caller-identity guard (foreign/anon id -> empty/false) and revoke
--     public + anon (authenticated retains its explicit grant for the policy).
--
-- NOTE on `revoke ... from public`: Postgres grants EXECUTE to PUBLIC by default,
-- so revoking only anon/authenticated leaves that PUBLIC ACE intact and the
-- function stays anon-callable. `from public, anon, authenticated` is required
-- (matches the existing remediation pattern in 20260626184930 / the
-- security-auth-checks test). service_role keeps its own explicit grant.
-- ============================================================================

-- 1. get_dm_unread_counts — CRITICAL. Pin search_path (was unset) + revoke.
--    Body unchanged; only called via the service-role admin client
--    (src/app/(dashboard)/dms/actions.ts:getDmUnreadCounts).
create or replace function public.get_dm_unread_counts(p_user_id uuid)
returns table(other_user_id uuid, unread_count bigint, last_message_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    case when ch.user_a_id = p_user_id then ch.user_b_id else ch.user_a_id end as other_user_id,
    count(msg.id) as unread_count,
    ch.last_message_at
  from public.dm_channels ch
  left join public.dm_read_cursors cur
    on cur.channel_id = ch.id and cur.user_id = p_user_id
  left join public.dm_messages msg
    on msg.channel_id = ch.id
    and msg.author_id != p_user_id
    and msg.deleted_at is null
    and msg.created_at > coalesce(cur.last_read_at, '1970-01-01'::timestamptz)
  where ch.user_a_id = p_user_id or ch.user_b_id = p_user_id
  group by ch.id, ch.user_a_id, ch.user_b_id, ch.last_message_at;
$function$;

revoke execute on function public.get_dm_unread_counts(uuid) from public, anon, authenticated;
grant execute on function public.get_dm_unread_counts(uuid) to service_role;

-- 2. get_teammate_ids — no app call-site, not referenced by any policy. Revoke.
revoke execute on function public.get_teammate_ids(uuid) from public, anon, authenticated;
grant execute on function public.get_teammate_ids(uuid) to service_role;

-- 3. get_visible_profile_ids — CRITICAL. Backs the `profiles` "Users can read
--    visible profiles" SELECT policy (calls it as fn(auth.uid())). Keep
--    authenticated EXECUTE for the policy; wrap the body so a caller can only
--    ever resolve their OWN visible set (or the service role, defensively);
--    revoke anon.
create or replace function public.get_visible_profile_ids(p_user_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select vid from (
    -- Own profile
    select p_user_id as vid
    union
    -- Teammates
    select distinct pm2.user_id
    from public.project_members pm1
    join public.project_members pm2 on pm1.team_id = pm2.team_id
    where pm1.user_id = p_user_id
    union
    -- Classmates (same enrolled section)
    select distinct e2.student_id
    from public.enrollments e1
    join public.enrollments e2 on e1.section_id = e2.section_id
    where e1.student_id = p_user_id
    union
    -- Students enrolled in sections the user owns (professor sees their students)
    select distinct e.student_id
    from public.course_sections cs
    join public.enrollments e on e.section_id = cs.id
    where cs.professor_id = p_user_id
    union
    -- Students/professors can see the professor of their enrolled sections
    select distinct cs.professor_id
    from public.enrollments e
    join public.course_sections cs on cs.id = e.section_id
    where e.student_id = p_user_id
  ) resolved
  -- Caller-identity guard: only the caller (policy passes auth.uid()) or the
  -- service role may resolve a given user's visible set. A direct rpc call from
  -- anon (auth.uid() null) or an authenticated user passing a foreign id gets 0 rows.
  where p_user_id = (select auth.uid())
     or (select auth.role()) = 'service_role';
$function$;

revoke execute on function public.get_visible_profile_ids(uuid) from public, anon;
grant execute on function public.get_visible_profile_ids(uuid) to service_role;

-- 4. can_access_phase — MEDIUM (authz oracle). Backs the `phase_comments` SELECT
--    policy (calls it as can_access_phase(id, auth.uid())). Keep authenticated
--    EXECUTE; add the caller-identity guard; revoke anon.
create or replace function public.can_access_phase(p_phase_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    (p_user_id = (select auth.uid()) or (select auth.role()) = 'service_role')
    and exists (
      select 1 from public.project_phases ph
      where ph.id = p_phase_id and (
        public.is_team_member(ph.team_id, p_user_id)
        or ph.project_id in (
          select p.id from public.projects p
          join public.course_sections cs on cs.id = p.section_id
          where cs.professor_id = p_user_id
        )
      )
    );
$function$;

revoke execute on function public.can_access_phase(uuid, uuid) from public, anon;
grant execute on function public.can_access_phase(uuid, uuid) to service_role;
