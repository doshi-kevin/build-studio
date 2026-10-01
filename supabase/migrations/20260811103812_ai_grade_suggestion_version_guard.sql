-- E5/E6: version-guard AI grade suggestions against a race with grade-commit / resubmit.
--
-- A suggestion is computed against a specific submission snapshot. The LLM call takes
-- seconds; in that window the professor can commit a real grade (supersede fires) or the
-- student can resubmit. Today the in-flight upsert lands AFTER and re-inserts the draft at
-- status='suggested' — resurrecting a stale grade over a committed one. supabase-js can't
-- condition an upsert on another table, so this does the check + write atomically in one
-- function: the suggestion is written ONLY if the submission is still 'submitted' and its
-- updated_at still matches the version captured when grading began.

ALTER TABLE public.assignment_ai_grade_suggestions
  ADD COLUMN IF NOT EXISTS submission_version timestamptz;

COMMENT ON COLUMN public.assignment_ai_grade_suggestions.submission_version IS
  'assignment_submissions.updated_at captured when this draft was graded; the write is rejected if the submission has moved past it (graded/returned/resubmitted).';

-- Atomic guarded upsert. Returns true when the draft was written, false when the submission
-- moved on (stale draft dropped). SECURITY DEFINER + service_role-only so it is reachable
-- solely through the server-side admin client, matching the table's no-client-write posture.
CREATE OR REPLACE FUNCTION public.upsert_ai_grade_suggestion_if_current(
  p_submission_id uuid,
  p_expected_version timestamptz,
  p_row jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated_at timestamptz;
  v_status text;
BEGIN
  SELECT updated_at, status INTO v_updated_at, v_status
    FROM public.assignment_submissions
    WHERE id = p_submission_id
    FOR UPDATE;

  IF NOT FOUND
     OR v_status IS DISTINCT FROM 'submitted'
     OR v_updated_at IS DISTINCT FROM p_expected_version THEN
    RETURN false;  -- graded / returned / resubmitted since grading began → stale, drop it
  END IF;

  INSERT INTO public.assignment_ai_grade_suggestions (
    institution_id, section_id, assignment_id, submission_id, student_id,
    suggested_rubric_scores, suggested_score, rationale, feedback, confidence,
    flagged_count, unmapped_questions, model, submission_version, status, updated_at
  ) VALUES (
    (p_row->>'institution_id')::uuid, (p_row->>'section_id')::uuid, (p_row->>'assignment_id')::uuid,
    p_submission_id, (p_row->>'student_id')::uuid,
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

REVOKE ALL ON FUNCTION public.upsert_ai_grade_suggestion_if_current(uuid, timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_ai_grade_suggestion_if_current(uuid, timestamptz, jsonb) TO service_role;
