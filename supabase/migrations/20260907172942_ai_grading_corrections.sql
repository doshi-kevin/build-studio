-- Criterion-level professor corrections to AI grade suggestions (calibration flywheel, phase 1a).
--
-- One row per (submission, criterion) captured when a professor commits a rubric grade while a
-- live AI suggestion exists: the AI's verdict alongside the professor's decision. This is the
-- training signal for calibrating the grader to each professor (few-shot exemplars, agreement
-- telemetry) that was previously discarded when the suggestion row was superseded.
--
-- RLS ships in this same migration (security-migrations rule), copying the shape of
-- assignment_ai_grade_suggestions (20260723012146): staff SELECT only (their own section),
-- NO student policy of any kind, and NO client write policy at all — writes go exclusively
-- through the server-side admin client from gradeSubmission. institution_id is always set
-- server-side from the verified section, never by the client.
--
-- UNIQUE (submission_id, criterion_key): last decision wins on a re-grade (upsert). The
-- submission id is a globally-unique UUID belonging to exactly one institution, so tenant
-- scoping of the conflict key is inherent (data-access rule).

CREATE TABLE IF NOT EXISTS public.assignment_grading_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES public.assignment_submissions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  grader_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Positional criterion key "<qIdx>:<cIdx>", same keying as rubric_scores / suggestions.
  criterion_key text NOT NULL CHECK (char_length(criterion_key) <= 40),
  -- The AI draft's verdict for this criterion, as the professor reviewed it.
  ai_tick boolean NOT NULL,
  ai_points numeric NOT NULL DEFAULT 0,
  ai_flagged boolean NOT NULL DEFAULT false,
  ai_confidence text NOT NULL CHECK (ai_confidence IN ('high', 'medium', 'low')),
  ai_has_evidence boolean NOT NULL DEFAULT false,
  -- The professor's committed decision.
  professor_tick boolean NOT NULL,
  agreed boolean GENERATED ALWAYS AS (ai_tick = professor_tick) STORED,
  model text NOT NULL,
  -- aiGrading.embeddedAt at suggestion time — ties the row to the rubric version graded against.
  rubric_version text,
  -- updated_at of the suggestion row the professor reviewed (ghost-diff guard input).
  -- updated_at, not created_at: a re-suggest UPSERTS the row, so created_at survives
  -- the conflict update and cannot distinguish drafts — updated_at can.
  suggestion_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_grading_correction_submission_criterion UNIQUE (submission_id, criterion_key)
);

COMMENT ON TABLE public.assignment_grading_corrections IS
  'Staff-only criterion-level diff of AI grade drafts vs professor-committed grades. Calibration signal; never student-visible.';

CREATE INDEX IF NOT EXISTS idx_grading_corrections_assignment
  ON public.assignment_grading_corrections (assignment_id);
CREATE INDEX IF NOT EXISTS idx_grading_corrections_section
  ON public.assignment_grading_corrections (section_id);
CREATE INDEX IF NOT EXISTS idx_grading_corrections_institution
  ON public.assignment_grading_corrections (institution_id);

ALTER TABLE public.assignment_grading_corrections ENABLE ROW LEVEL SECURITY;

-- Staff SELECT only. No student policy. No client write policy (admin client only).
DROP POLICY IF EXISTS "Section owner/staff can read grading corrections"
  ON public.assignment_grading_corrections;
CREATE POLICY "Section owner/staff can read grading corrections"
  ON public.assignment_grading_corrections
  FOR SELECT
  TO authenticated
  USING (public.is_section_owner_or_staff(section_id));

-- Explicit grants matching the SELECT-only policy: authenticated may read (RLS narrows to
-- staff), all writes go through the service-role admin client. anon gets nothing.
GRANT SELECT ON public.assignment_grading_corrections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assignment_grading_corrections TO service_role;

-- ── Suggestion upsert RPC: return the stamped updated_at instead of a boolean ──────────────
--
-- The correction capture's ghost-diff guard compares the suggestion `updated_at` the grader's
-- page rendered against the live row. The client can only know that version if the suggest
-- flow hands it back, and reading it back AFTER the upsert is racy (a concurrent re-suggest
-- could bump it between the two statements). Returning the exact stamped timestamp from
-- inside the function is atomic. NULL keeps the old `false` meaning: stale, nothing written.

DROP FUNCTION IF EXISTS public.upsert_ai_grade_suggestion_if_current(uuid, timestamptz, text, jsonb);

CREATE OR REPLACE FUNCTION public.upsert_ai_grade_suggestion_if_current(
  p_submission_id uuid,
  p_expected_version timestamptz,
  p_expected_rubric_version text,
  p_row jsonb
) RETURNS timestamptz
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
  v_now timestamptz := now();
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
    RETURN NULL;  -- graded / returned / resubmitted / rubric re-saved since grading began → stale
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
    (p_row->>'model'), p_expected_version, 'suggested', v_now
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
    updated_at = v_now;

  RETURN v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ai_grade_suggestion_if_current(uuid, timestamptz, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_ai_grade_suggestion_if_current(uuid, timestamptz, text, jsonb) TO service_role;
