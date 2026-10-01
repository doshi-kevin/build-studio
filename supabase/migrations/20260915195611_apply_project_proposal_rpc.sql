-- ============================================================
-- apply_project_proposal: land an Athena-proposed phase timeline + rubric atomically
-- ============================================================
-- Athena proposes a whole project structure at once: several phases, and several
-- weighted rubric rows hanging off them. Written one server action at a time that
-- is wrong in two ways a professor would actually hit:
--
--   * PARTIAL FAILURE. placePhaseItem commits its upsert before its reorder updates
--     and can return an error after the placement already landed, so a dropped
--     connection mid-batch leaves a half-built board — and the client-side Discard
--     that was the undo is gone on reload.
--   * RETRY DUPLICATES. createMasterPhase and addManualPhaseItem are plain inserts
--     with no natural key. An ambiguous response the professor retries silently
--     doubles every phase and row.
--
-- So the whole proposal is one function call, which is one transaction: it all lands
-- or none of it does. Idempotency is a claimed proposal id, so pressing Apply twice
-- is a no-op rather than a second board.
--
-- SECURITY DEFINER because it writes tables whose policies are deliberately
-- SELECT-only (all writes are server-side). It is NOT an authorization boundary:
-- the caller is the server action, which has already run verifySectionAccess +
-- canWriteAsStaff. What this function re-checks is the things a client snapshot
-- cannot be trusted on — that the project really belongs to the caller's verified
-- section and institution, and whether the project is frozen RIGHT NOW.
--
-- The freeze re-check is the race Athena's own screen state cannot close: the
-- professor can open a proposal while nothing is scored, have a TA grade a team in
-- another tab, and then click Apply. Re-reading it inside the transaction is what
-- makes "never silently re-score released work" true rather than merely intended.
-- ============================================================

-- ── Idempotency ledger ───────────────────────────────────────────────
create table if not exists public.project_proposal_applications (
  proposal_id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  institution_id uuid not null references public.institutions(id) on delete cascade,
  applied_by uuid not null references public.profiles(id) on delete cascade,
  applied_at timestamptz not null default now()
);

comment on table public.project_proposal_applications is
  'One row per Athena project proposal that has been applied. Exists so pressing Apply twice (or retrying an ambiguous response) is a no-op instead of a duplicated board. Server-only: RLS on, no policies, no client grants.';

alter table public.project_proposal_applications enable row level security;

-- No policies on purpose: nothing reads this from a client. RLS-on with no
-- permissive policy denies every client command, and the grants below remove the
-- privilege as well so the two locks are independent.
revoke all on public.project_proposal_applications from public, anon, authenticated;
grant all on public.project_proposal_applications to service_role;

-- ── The function ─────────────────────────────────────────────────────
create or replace function public.apply_project_proposal(
  p_proposal_id   uuid,
  p_project_id    uuid,
  p_section_id    uuid,
  p_institution_id uuid,
  p_user_id       uuid,
  p_actions       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action        jsonb;
  v_kind          text;
  v_phase_id      uuid;
  v_phase_keys    jsonb := '{}'::jsonb;   -- batch key -> new phase id
  v_ref           text;
  v_next_pos      int;
  v_frozen        boolean;
  v_released      boolean;
  v_levels        jsonb;
  v_level         jsonb;
  v_built_levels  jsonb;
  v_idx           int;
  v_phases_added  int := 0;
  v_items_added   int := 0;
  v_edits         int := 0;
begin
  -- 1. The project must belong to the caller's VERIFIED section and institution.
  -- Same message for "wrong tenant" and "deleted" so this cannot probe for ids.
  if not exists (
    select 1 from projects p
    join course_sections cs on cs.id = p.section_id
    where p.id = p_project_id
      and p.section_id = p_section_id
      and cs.institution_id = p_institution_id
  ) then
    return jsonb_build_object('ok', false, 'error', 'That project could not be found in this course.');
  end if;

  -- 2. Idempotency. Claim the proposal id first; a second Apply loses the race and
  -- returns the no-op rather than writing a second board.
  begin
    insert into project_proposal_applications (proposal_id, project_id, institution_id, applied_by)
    values (p_proposal_id, p_project_id, p_institution_id, p_user_id);
  exception when unique_violation then
    return jsonb_build_object('ok', true, 'alreadyApplied', true,
                              'phasesAdded', 0, 'itemsAdded', 0, 'edits', 0);
  end;

  -- 3. Freeze state, read INSIDE the transaction (see header).
  -- Lock the project row first. Under READ COMMITTED each statement takes a fresh
  -- snapshot, so without this a score committed between the read below and the
  -- cascade delete further down would be invisible to the gate and destroyed by the
  -- delete. The lock makes the check and the writes it guards one serialized unit.
  perform 1 from projects where id = p_project_id for update;

  select exists (select 1 from project_item_scores where project_id = p_project_id)
    into v_frozen;
  select exists (select 1 from project_grade_releases where project_id = p_project_id)
    into v_released;
  v_frozen := v_frozen or v_released;

  select coalesce(max(position), -1) + 1 into v_next_pos
  from project_master_phases where project_id = p_project_id;

  -- 4. Replay the actions in order.
  for v_action in select * from jsonb_array_elements(p_actions)
  loop
    v_kind := v_action ->> 'kind';

    if v_kind = 'setBrief' then
      update projects set
        title       = coalesce(nullif(v_action ->> 'title', ''), title),
        description = coalesce(v_action ->> 'description', description),
        guidelines  = coalesce(v_action ->> 'guidelines', guidelines),
        updated_at  = now()
      where id = p_project_id;
      v_edits := v_edits + 1;

    elsif v_kind = 'addPhase' then
      insert into project_master_phases (project_id, institution_id, name, position, start_date, end_date)
      values (
        p_project_id, p_institution_id, v_action ->> 'name', v_next_pos,
        nullif(v_action ->> 'startDate', '')::date,
        nullif(v_action ->> 'endDate', '')::date
      )
      returning id into v_phase_id;
      v_next_pos := v_next_pos + 1;
      v_phases_added := v_phases_added + 1;
      -- `jsonb ||` is last-write-wins, so a REPEATED key would silently re-point an
      -- earlier phase and send a row to the wrong one — no error, and nothing the
      -- professor reviewed would show it. The adapter mints unique keys, but that
      -- protects exactly one caller; refuse here so any future caller that
      -- hand-assembles a proposal fails loudly instead of mis-filing coursework.
      if v_phase_keys ? (v_action ->> 'key') then
        raise exception 'A proposal reused the phase key %, which would attach rows to the wrong phase.', v_action ->> 'key';
      end if;
      -- Remember the batch key so rows proposed against a phase that did not exist
      -- when the model wrote them can still find it.
      v_phase_keys := v_phase_keys || jsonb_build_object(v_action ->> 'key', v_phase_id::text);

    elsif v_kind = 'updatePhase' then
      -- A phase's date window decides which sessions an attendance row counts, so
      -- moving it on a RELEASED project silently re-scores work students have seen.
      -- Renaming is always safe, so gate only the dates.
      if v_released and (v_action ? 'startDate' or v_action ? 'endDate') then
        raise exception 'FROZEN: grades are released, so a phase''s dates cannot be changed.';
      end if;
      update project_master_phases set
        name       = coalesce(nullif(v_action ->> 'name', ''), name),
        start_date = coalesce(nullif(v_action ->> 'startDate', '')::date, start_date),
        end_date   = coalesce(nullif(v_action ->> 'endDate', '')::date, end_date),
        updated_at = now()
      where id = (v_action ->> 'phaseId')::uuid and project_id = p_project_id;
      v_edits := v_edits + 1;

    elsif v_kind = 'removePhase' then
      if v_frozen then
        raise exception 'FROZEN: this project already has saved scores, so a phase cannot be removed.';
      end if;
      delete from project_master_phases
      where id = (v_action ->> 'phaseId')::uuid and project_id = p_project_id;
      v_edits := v_edits + 1;

    elsif v_kind = 'addItem' then
      v_ref := v_action ->> 'phaseRef';
      if v_ref like 'newPhase:%' then
        v_phase_id := (v_phase_keys ->> substring(v_ref from 10))::uuid;
      else
        v_phase_id := v_ref::uuid;
      end if;
      -- A row whose phase cannot be resolved aborts the whole apply rather than
      -- landing orphaned: phase_id is NOT NULL, and a silent skip would produce a
      -- board that does not match what the professor reviewed.
      if v_phase_id is null then
        raise exception 'A proposed rubric row referenced a phase that was not created.';
      end if;
      if not exists (select 1 from project_master_phases where id = v_phase_id and project_id = p_project_id) then
        raise exception 'A proposed rubric row referenced a phase outside this project.';
      end if;

      -- Levels arrive from the model as {label, points}; the stored shape needs a
      -- stable id per level, because project_item_scores records which level was
      -- picked BY id. Generated here so a re-apply cannot renumber saved scores.
      v_built_levels := '[]'::jsonb;
      v_levels := coalesce(v_action -> 'levels', '[]'::jsonb);
      v_idx := 0;
      for v_level in select * from jsonb_array_elements(v_levels)
      loop
        v_idx := v_idx + 1;
        v_built_levels := v_built_levels || jsonb_build_array(jsonb_build_object(
          'id', 'l' || v_idx::text || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8),
          'label', v_level ->> 'label',
          'points', (v_level ->> 'points')::numeric
        ));
      end loop;

      -- The ONE id in this function that is not otherwise bound to the caller's scope.
      -- A foreign key to assignments/quizzes proves the row exists SOMEWHERE on the
      -- platform, not that it is this course's. Without this, a staff member could
      -- place another institution's assignment on their own board and surface its
      -- title, points, status and due date to their own students — and the single-item
      -- sibling placePhaseItem already performs exactly this check.
      -- Raise rather than skip, to keep the all-or-nothing property intact.
      if v_action ->> 'itemType' = 'assignment' then
        if not exists (
          select 1 from assignments
          where id = (v_action ->> 'sourceId')::uuid and section_id = p_section_id
        ) then
          raise exception 'A proposed rubric row referenced work outside this course.';
        end if;
      elsif v_action ->> 'itemType' = 'quiz' then
        if not exists (
          select 1 from quizzes
          where id = (v_action ->> 'sourceId')::uuid and section_id = p_section_id
        ) then
          raise exception 'A proposed rubric row referenced work outside this course.';
        end if;
      end if;

      -- An auto-pulled row (assignment/quiz/attendance) resolves LIVE from each
      -- student's own record, so adding one to a RELEASED project changes the
      -- numerator and denominator of a grade students can already see. A manual row
      -- is safe: ungraded items are dropped from both sides until someone scores it.
      if v_released and v_action ->> 'itemType' <> 'manual' then
        raise exception 'FROZEN: grades are released, so a % row cannot be added — it would change grades students have already seen.', v_action ->> 'itemType';
      end if;

      insert into project_phase_items (
        phase_id, project_id, institution_id, item_type,
        assignment_id, quiz_id, manual_title, manual_max,
        weight, grain, scoring_mode, levels
      )
      values (
        v_phase_id, p_project_id, p_institution_id, v_action ->> 'itemType',
        case when v_action ->> 'itemType' = 'assignment' then (v_action ->> 'sourceId')::uuid end,
        case when v_action ->> 'itemType' = 'quiz'       then (v_action ->> 'sourceId')::uuid end,
        case when v_action ->> 'itemType' = 'manual'     then v_action ->> 'title' end,
        case when v_action ->> 'itemType' = 'manual' and v_action ? 'manualMax'
             then (v_action ->> 'manualMax')::numeric end,
        (v_action ->> 'weight')::numeric,
        v_action ->> 'grain',
        v_action ->> 'scoringMode',
        v_built_levels
      );
      v_items_added := v_items_added + 1;

    elsif v_kind = 'setItemGrading' then
      if v_frozen then
        raise exception 'FROZEN: this project already has saved scores, so weights cannot be changed.';
      end if;
      -- No updated_at here on purpose: project_phase_items carries created_at only
      -- (project_master_phases is the one with updated_at). Setting it raised
      -- "column does not exist" and failed every re-weight.
      -- Levels have to be persisted here too. Switching a row to 'levels' while
      -- leaving its level list empty silently makes every student's score on that
      -- row resolve as UNGRADED (see resolveContribution in src/lib/projects/grade.ts)
      -- — the row looks configured and scores nobody. Ids are minted the same way
      -- as on insert, so a re-apply cannot renumber ids already referenced by
      -- project_item_scores.
      v_built_levels := '[]'::jsonb;
      v_levels := coalesce(v_action -> 'levels', '[]'::jsonb);
      v_idx := 0;
      for v_level in select * from jsonb_array_elements(v_levels)
      loop
        v_idx := v_idx + 1;
        v_built_levels := v_built_levels || jsonb_build_array(jsonb_build_object(
          'id', 'l' || v_idx::text || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8),
          'label', v_level ->> 'label',
          'points', (v_level ->> 'points')::numeric
        ));
      end loop;

      update project_phase_items set
        weight       = coalesce((v_action ->> 'weight')::numeric, weight),
        grain        = coalesce(v_action ->> 'grain', grain),
        scoring_mode = coalesce(v_action ->> 'scoringMode', scoring_mode),
        levels       = case when jsonb_array_length(v_built_levels) > 0 then v_built_levels else levels end
      where id = (v_action ->> 'itemId')::uuid and project_id = p_project_id;
      v_edits := v_edits + 1;

    elsif v_kind = 'removeItem' then
      if v_frozen then
        raise exception 'FROZEN: this project already has saved scores, so a rubric row cannot be removed.';
      end if;
      delete from project_phase_items
      where id = (v_action ->> 'itemId')::uuid and project_id = p_project_id;
      v_edits := v_edits + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true, 'alreadyApplied', false,
    'phasesAdded', v_phases_added, 'itemsAdded', v_items_added, 'edits', v_edits
  );
end;
$$;

comment on function public.apply_project_proposal is
  'Applies one Athena-proposed project structure atomically. Re-verifies the project against the caller''s verified section+institution, re-reads the freeze state inside the transaction, and claims a proposal id for idempotency. Server-only: EXECUTE is revoked from client roles.';

-- Server-only. A new function is PUBLIC-executable by default, so both client roles
-- and PUBLIC have to be revoked explicitly, not just left ungranted.
revoke execute on function public.apply_project_proposal(uuid, uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_project_proposal(uuid, uuid, uuid, uuid, uuid, jsonb) to service_role;
