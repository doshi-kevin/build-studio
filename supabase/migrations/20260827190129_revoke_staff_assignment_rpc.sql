-- Moves revokeStaffAssignment's conditional end-date into SQL, closing a clock-split corruption.
--
-- The TypeScript version decided whether an assignment had already ended using the NODE process
-- clock (`Date.parse(ends_at) <= Date.now()`) and then wrote the result back. A consultant review
-- found the direction that bites: if the app clock runs BEHIND the database, a genuinely expired
-- `ends_at` reads as not-yet-expired, so the action stamps the app's lagging time over a real past
-- end date. That is the exact data corruption the conditional was written to PREVENT, and it is
-- shown back to the person as "Through {date}" on their own dashboard.
--
-- Deciding it in SQL removes the split entirely: one clock, and the read-decide-write becomes a
-- single atomic statement, so the compare-and-swap on `status` no longer needs a prior SELECT to
-- be correct. `section_staff` has no `updated_at`, which is why status is the guard column, and it
-- is sound here because the transition is one-way (active -> removed).
--
-- `ends_at` is NOT NULL on this table, so no null branch is needed.
--
-- NOT `security definer`, deliberately. The only caller is the service-role admin client, which
-- already bypasses RLS, so definer rights would add privilege for no benefit and create a hole to
-- get wrong. Postgres grants EXECUTE to PUBLIC by default and Supabase exposes functions over
-- PostgREST, so the revoke below is load-bearing rather than tidiness: without it any logged-in
-- student could close out any TA's assignment.

create or replace function public.revoke_staff_assignment(p_staff_id uuid)
returns table (id uuid)
language sql
set search_path = public
as $$
  update public.section_staff
     set status = 'removed',
         -- Keep a genuine past end date; only stamp now() when the assignment is still running.
         ends_at = case when ends_at <= now() then ends_at else now() end
   where id = p_staff_id
     and status = 'active'
  returning section_staff.id;
$$;

revoke all on function public.revoke_staff_assignment(uuid) from public;
revoke all on function public.revoke_staff_assignment(uuid) from anon, authenticated;
grant execute on function public.revoke_staff_assignment(uuid) to service_role;

comment on function public.revoke_staff_assignment(uuid) is
  'Closes out an active section_staff assignment. Preserves a genuine past ends_at and stamps '
  'now() only when the assignment is still running, decided in SQL so there is no app-vs-DB clock '
  'split. Guarded on status = active, so zero rows means someone else got there first. '
  'service_role only: never grant to anon or authenticated.';
