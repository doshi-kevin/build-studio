-- Harden upsert_ai_grade_suggestion_if_current: DERIVE the tenant ids from the locked
-- submission row instead of trusting the caller's JSON, and reject a draft graded against
-- a rubric that has since changed.
--
-- Reviewer + CodeRabbit: the function is SECURITY DEFINER and previously inserted whatever
-- institution_id/section_id/assignment_id/student_id the caller put in p_row. Not exploitable
-- today (the one caller threads verified ids), but it's a cross-tenant-write seam the moment a
-- second caller is added without the same discipline. Now those four come only from the row
-- itself (submission + its assignment); p_row supplies ONLY the grade payload.
--
-- Also adds a rubric-version guard: the caller passes the aiGrading.embeddedAt token captured
-- when grading began; if the rubric was re-saved since (new embeddedAt), the draft is stale and
-- rejected — closing the "graded against the old rubric/vectors" race the same way the
-- submission-version guard closes the graded/resubmit race.

-- Signature changes (adds p_expected_rubric_version), so drop the old overload first.
DROP FUNCTION IF EXISTS public.upsert_ai_grade_suggestion_if_current(uuid, timestamptz, jsonb);

CREATE OR REPLACE FUNCTION public.upsert_ai_grade_suggestion_if_current(
  p_submission_id uuid,
  p_expected_version timestamptz,
  p_expected_rubric_version text,
  p_row jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated_at timestamptz;
  v_status text;
  v_institution_id uuid;
  v_assignment_id uuid;
  v_student_id uuid;
  v_section_id uuid;
  v_rubric_version text;
BEGIN
  -- Lock the submission and read its tenant identity + the assignment's section/rubric version.
  SELECT s.updated_at, s.status, s.institution_id, s.assignment_id, s.student_id,
         a.section_id, a.settings->'aiGrading'->>'embeddedAt'
    INTO v_updated_at, v_status, v_institution_id, v_assignment_id, v_student_id,
         v_section_id, v_rubric_version
    FROM public.assignment_submissions s
    JOIN public.assignments a ON a.id = s.assignment_id
    WHERE s.id = p_submission_id
    FOR UPDATE OF s;

  IF NOT FOUND
     OR v_status IS DISTINCT FROM 'submitted'
     OR v_updated_at IS DISTINCT FROM p_expected_version
     OR v_rubric_version IS DISTINCT FROM p_expected_rubric_version THEN
    RETURN false;  -- graded / returned / resubmitted / rubric re-saved since grading began → stale
  END IF;

  INSERT INTO public.assignment_ai_grade_suggestions (
    institution_id, section_id, assignment_id, submission_id, student_id,
    suggested_rubric_scores, suggested_score, rationale, feedback, confidence,
    flagged_count, unmapped_questions, model, submission_version, status, updated_at
  ) VALUES (
    v_institution_id, v_section_id, v_assignment_id, p_submission_id, v_student_id,
    COALESCE(p_row->'suggested_rubric_scores', '[]'::jsonb), (p_row->>'suggested_score')::numeric,
    COALESCE(p_row->'rationale', '[]'::jsonb), COALESCE(p_row->>'feedback', ''), (p_row->>'confidence'),
    COALESCE((p_row->>'flagged_count')::int, 0), COALESCE(p_row->'unmapped_questions', '[]'::jsonb),
    (p_row->>'model'), p_expected_version, 'suggested', now()
  )
  ON CONFLICT (submission_id) DO UPDATE SET
    suggested_rubric_scores = EXCLUDED.suggested_rubric_scores,
    suggested_score = EXCLUDED.suggested_score,
    rationale = EXCLUDED.rationale,
    feedback = EXCLUDED.feedback,
    confidence = EXCLUDED.confidence,
    flagged_count = EXCLUDED.flagged_count,
    unmapped_questions = EXCLUDED.unmapped_questions,
    model = EXCLUDED.model,
    submission_version = EXCLUDED.submission_version,
    status = 'suggested',
    updated_at = now();

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ai_grade_suggestion_if_current(uuid, timestamptz, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_ai_grade_suggestion_if_current(uuid, timestamptz, text, jsonb) TO service_role;
