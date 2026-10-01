-- Leaving a project team, atomically (#699).
--
-- Students can leave a team they joined; when the last member leaves, the team is deleted so
-- an empty group does not linger on the project roster.
--
-- Both halves need care, which is why this is one function rather than three round trips from
-- a server action:
--
-- 1. DELETING A TEAM IS FAR MORE DESTRUCTIVE THAN IT LOOKS. `project_teams` is the parent of 14
--    ON DELETE CASCADE relationships, including `project_grades`, `project_item_scores`,
--    `project_docs`, `project_videos`, `project_showcase` and every team chat channel. Taken
--    literally, "last member leaves, delete the team" lets ONE student click destroy a graded
--    submission with no professor involvement and no undo. When this was written production had
--    21 teams of which 18 were already single-member and 2 of those already carried a grade — so
--    this was one click away from real loss, not a hypothetical.
--
--    A student-initiated action must never delete an academic record. So the last member is
--    REFUSED when the team carries a grade or a submitted submission, and told to talk to their
--    professor. A draft submission does not block: that is the team's own work in progress, and
--    the UI confirms before discarding it.
--
--    The test deliberately reads academic STATE (a grade row, the submission's own status)
--    rather than counting rows across the cascade. Enumerating child tables here would be
--    fragile in the worst way: adding a 15th cascading table later would silently widen what a
--    student can destroy, and nothing would fail.
--
-- 2. THE COUNT-THEN-DELETE RACE. Two members leaving at the same instant can each observe the
--    other still present and both decline to clean up, stranding an empty team — the exact mess
--    the auto-delete exists to prevent. `FOR UPDATE` on the team row serialises the pair, so the
--    second caller reads the first's committed delete.
--
-- SECURITY DEFINER because the delete crosses tables that the caller's own RLS does not cover.
-- The caller id is passed in rather than read from auth.uid(): every caller is a server action
-- using the service-role client, where auth.uid() is NULL. That makes the grant below
-- load-bearing — see the revoke.

create or replace function public.leave_project_team(p_team_id uuid, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_others      int;
  v_has_grade   boolean;
  v_submitted   boolean;
begin
  -- Serialise concurrent leavers on this team.
  perform 1 from project_teams where id = p_team_id for update;
  if not found then
    return 'team_not_found';
  end if;

  select role into v_role
    from project_members
   where team_id = p_team_id and user_id = p_user_id;
  if v_role is null then
    return 'not_member';
  end if;

  select count(*) into v_others
    from project_members
   where team_id = p_team_id and user_id <> p_user_id;

  -- An owner with people still in the team hands over first. Auto-promoting someone
  -- silently makes a person responsible for a team they did not choose to run.
  if v_role = 'owner' and v_others > 0 then
    return 'owner_must_transfer';
  end if;

  if v_others = 0 then
    select exists (select 1 from project_grades where team_id = p_team_id) into v_has_grade;
    select coalesce(submission->>'status', '') = 'submitted'
      into v_submitted
      from project_teams where id = p_team_id;

    if v_has_grade or v_submitted then
      -- Refuse BEFORE removing them: leaving and stranding the record would be worse than
      -- not leaving, and the professor is the only one who can unpick this.
      return 'has_academic_record';
    end if;
  end if;

  delete from project_members where team_id = p_team_id and user_id = p_user_id;

  if v_others = 0 then
    delete from project_teams where id = p_team_id;
    return 'left_and_team_deleted';
  end if;

  return 'left';
end;
$$;

comment on function public.leave_project_team(uuid, uuid) is
  'Removes a member from a project team, deleting the team when the last member leaves. Refuses '
  'when an owner still has teammates (transfer first) or when the team carries a grade or a '
  'submitted submission. Server-only: the caller id is an argument, not auth.uid().';

-- Server-only. Postgres grants EXECUTE to PUBLIC by default and Supabase exposes functions over
-- PostgREST, so without this a student could call it directly with someone else's id and remove
-- them from a team.
revoke execute on function public.leave_project_team(uuid, uuid) from public, anon, authenticated;
