-- Security audit remediation (2026-06-26)
--
-- Reconciles prod with the intended security posture after the RLS/security audit.
-- Every block is server-side-safe: all legitimate writes already route through the
-- service_role admin client (verified in the audit), so locking anon/authenticated
-- out changes no behavior. Applied as ONE migration => ONE PostgREST schema reload.
--
-- Audit findings covered:
--   H1  two SECURITY DEFINER views readable cross-tenant by anon/authenticated
--   H2  over-granted SECURITY DEFINER functions callable by anon/authenticated
--   M1  challenge_claims FOR ALL student write-hole (self-approve own claim)
--   M2  profiles privilege columns (is_platform_owner/status) self-writable
--   M3  (subset) mutable search_path on verified SECURITY DEFINER functions
-- Deferred to separate migrations: M4 read-policy defense-in-depth, M5 the
--   auth_rls_initplan sweep, M3 remainder (handle_new_user et al.), L-items.

-- ─────────────────────────────────────────────────────────────────────────────
-- H1 — Lock the two SECURITY DEFINER views.
-- They run with the view owner's rights (bypassing the caller's RLS), and Supabase
-- default privileges granted SELECT to anon/authenticated — so anyone with the
-- public anon key could read every institution + every section-staff row across
-- tenants via PostgREST. A prior migration tried `REVOKE ALL ... FROM PUBLIC`,
-- which does NOT remove the direct anon/authenticated grants. Both views are read
-- only via the service_role admin client (admin/page.tsx, super-admin/page.tsx);
-- service_role bypasses RLS, so security_invoker is transparent to it.
-- Pattern: 20260620212822_secure_audit_log_with_actor_view.sql
-- ─────────────────────────────────────────────────────────────────────────────
alter view public.institutions_with_counts      set (security_invoker = on);
alter view public.section_staff_with_institution set (security_invoker = on);

revoke all on public.institutions_with_counts      from anon, authenticated;
revoke all on public.section_staff_with_institution from anon, authenticated;

grant select on public.institutions_with_counts      to service_role;
grant select on public.section_staff_with_institution to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- H2 — Revoke client EXECUTE on over-granted SECURITY DEFINER functions.
-- These bypass RLS; being callable by anon/authenticated let any caller invoke them
-- via PostgREST RPC. Legit callers are the service_role admin client (extraction
-- worker) and pg_cron (runs jobs as postgres) — both unaffected by these revokes.
-- The is_* RLS-helper functions and pgvector functions are intentionally LEFT
-- executable (required by RLS / the extension) and are not touched here.
-- Pattern: 00000000000012_secure_rpc_permissions.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- increment_student_quizzes_taken: the worst — SECURITY DEFINER with no caller
-- check let any user set ANY student's rating in ANY section. Re-create it with a
-- baked-in caller guard so the lock survives future grant drift (a CREATE OR
-- REPLACE / fresh-DB build re-grants EXECUTE to anon/authenticated via Supabase
-- default privileges — that drift is why it was re-exposed despite migrations
-- 00000000000005 / 00000000000012), plus a pinned search_path. Then re-assert the
-- revoke/grant. (Function is currently dormant — adaptive quiz was wired out — so
-- this is zero-risk and hardens it if ever re-wired.)
create or replace function public.increment_student_quizzes_taken(
  p_student_id uuid,
  p_section_id uuid,
  p_new_rating integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server-only: callable solely by the service_role admin client (or postgres/cron).
  if not (current_user = 'postgres' or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'increment_student_quizzes_taken is server-only'
      using errcode = 'insufficient_privilege';
  end if;

  insert into student_ratings (student_id, section_id, rating, quizzes_taken, updated_at)
  values (p_student_id, p_section_id, p_new_rating, 1, now())
  on conflict (student_id, section_id)
  do update set
    rating = p_new_rating,
    quizzes_taken = student_ratings.quizzes_taken + 1,
    updated_at = now();
end;
$$;

revoke execute on function public.increment_student_quizzes_taken(uuid, uuid, integer) from public, anon, authenticated;
grant  execute on function public.increment_student_quizzes_taken(uuid, uuid, integer) to service_role;

-- Assignment lifecycle + extraction queue + live-classroom maintenance functions.
revoke execute on function public.finalize_overdue_assignments()           from public, anon, authenticated;
grant  execute on function public.finalize_overdue_assignments()           to service_role;

revoke execute on function public.publish_scheduled_assignments()          from public, anon, authenticated;
grant  execute on function public.publish_scheduled_assignments()          to service_role;

revoke execute on function public.claim_next_extraction_job(uuid, integer) from public, anon, authenticated;
grant  execute on function public.claim_next_extraction_job(uuid, integer) to service_role;

revoke execute on function public.cancel_pending_extraction_jobs(uuid)     from public, anon, authenticated;
grant  execute on function public.cancel_pending_extraction_jobs(uuid)     to service_role;

revoke execute on function public.lc_auto_end_stale_rooms()                from public, anon, authenticated;
grant  execute on function public.lc_auto_end_stale_rooms()                to service_role;

revoke execute on function public.lc_reap_orphan_decks()                   from public, anon, authenticated;
grant  execute on function public.lc_reap_orphan_decks()                   to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- M3 (subset) — Pin search_path on SECURITY DEFINER functions verified to use
-- schema-qualified refs (storage., cron.). pg_catalog is implicitly searched
-- first, so operators/system functions can't be hijacked. handle_new_user and the
-- remaining util/trigger functions are deferred (need per-body review first).
-- ─────────────────────────────────────────────────────────────────────────────
alter function public.lc_auto_end_stale_rooms() set search_path = public;
alter function public.lc_reap_orphan_decks()    set search_path = public;
alter function public.schedule_quiz_publish()   set search_path = public;

-- ─────────────────────────────────────────────────────────────────────────────
-- M1 — challenge_claims: replace the FOR ALL student policy with read-only.
-- The FOR ALL policy (with_check null) plus Supabase column grants let a student
-- PATCH their own claim to status='approved', reviewed_by=<prof> directly via
-- PostgREST (self-approve). All real writes (claim / withdraw / submit) go through
-- server actions via the admin client, so removing the client write path changes
-- nothing functionally. Professor SELECT/UPDATE policies are left intact.
-- Pattern: read-only client policy (e.g. dm_read_cursors in 00000000000068).
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "Students can manage own claims" on public.challenge_claims;
drop policy if exists "Students read own claims"        on public.challenge_claims;
create policy "Students read own claims" on public.challenge_claims
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- M2 — Extend the profile self-update guard to freeze is_platform_owner + status.
-- "Users can update own profile" + Supabase column grants let a user self-set these
-- via PostgREST; the existing trigger only froze role + institution_id. Self-setting
-- is_platform_owner lets a super_admin self-promote to platform owner. New checks
-- live in the UPDATE-only path (the INSERT branch returns early), so they never trip
-- on INSERT where OLD is NULL. status is wrapped in coalesce(,'') to avoid a
-- NULL-vs-'' false-positive blocking a legit name/avatar/settings self-update. The
-- service_role early-return is unchanged, so server actions (incl.
-- transferPlatformOwnership and admin status changes) keep working.
-- Pattern: 20260611204904_harden_profiles_self_update.sql
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  -- Trusted server-side / internal callers may set/change protected columns.
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;

  -- INSERT: a non-service-role caller may only ever create a plain student row.
  if tg_op = 'INSERT' then
    if new.role is distinct from 'student' then
      raise exception 'Creating a profile with an elevated role is not permitted'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- UPDATE: the following columns are immutable to non-service-role callers.
  if new.role is distinct from old.role then
    raise exception 'Changing profile role is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  if new.institution_id is distinct from old.institution_id then
    raise exception 'Changing profile institution is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  if new.is_platform_owner is distinct from old.is_platform_owner then
    raise exception 'Changing platform-owner status is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(new.status, '') is distinct from coalesce(old.status, '') then
    raise exception 'Changing profile status is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;
