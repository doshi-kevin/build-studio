-- ============================================================
-- insert_project_phase RPC
--
-- Creates a project phase with transactional position handling.
-- Replaces the JS-side loop that shifted positions row-by-row,
-- which left gaps/overlaps if any step failed mid-flight.
--
-- Modes:
--   'append' → new phase lands at MAX(position) + 1
--   'top'    → new phase lands at 0; all existing phases shift +1
--   'after'  → new phase lands at anchor.position + 1; every phase
--              at or above that position shifts +1
--
-- Returns the new phase id. Raises an error if the anchor is
-- missing or not in the same team. The entire operation — read
-- anchor, bump rows, insert — runs in the implicit function
-- transaction, so partial failure rolls back cleanly.
--
-- Authorization lives in the server action (verifyTeamAccess).
-- We deliberately do NOT re-check role here because the action
-- calls via the admin client; the RPC trusts the caller.
-- ============================================================

CREATE OR REPLACE FUNCTION public.insert_project_phase(
  p_project_id UUID,
  p_team_id UUID,
  p_title TEXT,
  p_description TEXT,
  p_status TEXT,
  p_start_date DATE,
  p_due_date DATE,
  p_insert_mode TEXT,
  p_anchor_phase_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_position INTEGER;
  v_anchor_position INTEGER;
  v_new_id UUID;
BEGIN
  IF p_insert_mode = 'append' THEN
    SELECT COALESCE(MAX(position) + 1, 0)
      INTO v_new_position
      FROM public.project_phases
     WHERE team_id = p_team_id;

  ELSIF p_insert_mode = 'top' THEN
    v_new_position := 0;
    UPDATE public.project_phases
       SET position = position + 1
     WHERE team_id = p_team_id;

  ELSIF p_insert_mode = 'after' THEN
    IF p_anchor_phase_id IS NULL THEN
      RAISE EXCEPTION 'anchor_phase_id is required when insert_mode = after';
    END IF;

    SELECT position
      INTO v_anchor_position
      FROM public.project_phases
     WHERE id = p_anchor_phase_id
       AND team_id = p_team_id;

    IF v_anchor_position IS NULL THEN
      RAISE EXCEPTION 'anchor phase not found in this team';
    END IF;

    v_new_position := v_anchor_position + 1;

    UPDATE public.project_phases
       SET position = position + 1
     WHERE team_id = p_team_id
       AND position >= v_new_position;

  ELSE
    RAISE EXCEPTION 'invalid insert_mode: %', p_insert_mode;
  END IF;

  INSERT INTO public.project_phases (
    project_id,
    team_id,
    title,
    description,
    status,
    start_date,
    due_date,
    position
  ) VALUES (
    p_project_id,
    p_team_id,
    p_title,
    p_description,
    p_status,
    p_start_date,
    p_due_date,
    v_new_position
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

-- service_role is what the admin client uses from server actions.
GRANT EXECUTE ON FUNCTION public.insert_project_phase(
  UUID, UUID, TEXT, TEXT, TEXT, DATE, DATE, TEXT, UUID
) TO service_role;
