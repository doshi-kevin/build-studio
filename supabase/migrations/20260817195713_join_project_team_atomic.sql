-- #698 — two students accepting the last slot both succeed, putting a team over its cap.
-- Live-reproduced: Team Beta reached 5 members against a cap of 4, and one team in
-- production is over cap right now.
--
-- Both accept paths read the member count, decide in JS, then insert — the read guards
-- the write across an await, so two requests read the same pre-insert count and both
-- pass. The issue notes respondToJoinRequest "handles this", but its compare-and-set is
-- on the REQUEST ROW (pending → handled), which stops one request being processed twice;
-- it does nothing about two different requests claiming one slot. So both paths race.
--
-- Fixed where it can be made atomic: one function that takes the team row lock, counts,
-- and inserts inside a single transaction. Per the data-access rule — a capacity check
-- cannot be a SELECT followed by an INSERT, and supabase-js gives no transaction across
-- separate .from() calls.
--
-- Deliberately NOT a CHECK constraint or trigger: max_team_size lives on `projects`, so
-- enforcing it per-row would mean a subquery in a constraint (not allowed) or a trigger
-- that still needs this same lock. The lock is the honest mechanism.
--
-- Returns a discriminated result rather than raising: callers must distinguish "full"
-- from "already a member" from success to report the right thing to the student, and an
-- exception would collapse those.

create or replace function public.join_project_team_atomic(
  p_team_id uuid,
  p_project_id uuid,
  p_user_id uuid,
  p_role text default 'member'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_cap      int;
  v_count    int;
  v_team_ok  boolean;
BEGIN
  -- Lock the TEAM row for the duration of the transaction. Every concurrent accept for
  -- this team serializes here, so the count below cannot go stale between read and
  -- insert. Locking the team (not the project) keeps two different teams independent.
  SELECT true INTO v_team_ok
    FROM project_teams
   WHERE id = p_team_id AND project_id = p_project_id
     FOR UPDATE;

  IF v_team_ok IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'team_not_found');
  END IF;

  SELECT coalesce(max_team_size, 5) INTO v_cap FROM projects WHERE id = p_project_id;

  -- Already in ANY team on this project? That is a different refusal from "full", and
  -- the UNIQUE (project_id, user_id) constraint would otherwise surface it as a raw 23505.
  IF EXISTS (SELECT 1 FROM project_members WHERE project_id = p_project_id AND user_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_member');
  END IF;

  SELECT count(*) INTO v_count FROM project_members WHERE team_id = p_team_id;

  IF v_count >= v_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'full', 'count', v_count, 'cap', v_cap);
  END IF;

  INSERT INTO project_members (team_id, project_id, user_id, role)
  VALUES (p_team_id, p_project_id, p_user_id, coalesce(p_role, 'member'));

  RETURN jsonb_build_object('ok', true, 'count', v_count + 1, 'cap', v_cap);
END;
$function$;

comment on function public.join_project_team_atomic(uuid, uuid, uuid, text) is
  'Adds a student to a project team under the team row lock, so a concurrent accept cannot push the team past max_team_size (#698). Returns {ok, reason} — callers distinguish full / already_member / team_not_found.';

-- Server-only: the app calls this with the service-role client after its own authz.
revoke execute on function public.join_project_team_atomic(uuid, uuid, uuid, text) from public, anon, authenticated;
