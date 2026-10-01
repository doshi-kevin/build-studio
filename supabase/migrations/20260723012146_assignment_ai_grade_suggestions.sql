-- AI-assisted grading draft suggestions (experimental, feature/ai-grading).
--
-- One row per submission: a staff-only DRAFT grade produced by the AI grading
-- pipeline (similarity signals + one Gemini call). It is never a real grade and
-- never student-visible; the professor reviews it and saves through the normal
-- gradeSubmission flow, at which point this row is marked 'superseded'.
--
-- RLS ships in this same migration (security-migrations rule). Staff SELECT only
-- (their own section), NO student policy of any kind, and NO write policy at all
-- (writes go exclusively through the server-side admin client; a FOR ALL policy
-- would be a write hole). institution_id is always set server-side, never by the
-- client. The upsert conflict key is submission_id, which is a globally-unique
-- UUID belonging to exactly one institution, so tenant scoping of the key is
-- inherent (data-access rule).

CREATE TABLE IF NOT EXISTS public.assignment_ai_grade_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES public.assignment_submissions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- ["qIdx:cIdx", ...] - drop-in for gradeSubmission.rubricScores
  suggested_rubric_scores jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_score numeric NOT NULL,
  -- SuggestedCriterion[] (key, tick, suggestedPoints, rationale, flagged)
  rationale jsonb NOT NULL DEFAULT '[]'::jsonb,
  feedback text NOT NULL DEFAULT '',
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  flagged_count int NOT NULL DEFAULT 0,
  -- question indexes with no locatable student answer (needs manual grading)
  unmapped_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL,
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_grade_suggestion_submission UNIQUE (submission_id)
);

COMMENT ON TABLE public.assignment_ai_grade_suggestions IS
  'Staff-only AI grading drafts. Never student-visible; superseded once the professor saves a real grade.';

CREATE INDEX IF NOT EXISTS idx_ai_grade_suggestions_assignment
  ON public.assignment_ai_grade_suggestions (assignment_id);
CREATE INDEX IF NOT EXISTS idx_ai_grade_suggestions_section
  ON public.assignment_ai_grade_suggestions (section_id);
CREATE INDEX IF NOT EXISTS idx_ai_grade_suggestions_institution
  ON public.assignment_ai_grade_suggestions (institution_id);
CREATE INDEX IF NOT EXISTS idx_ai_grade_suggestions_student
  ON public.assignment_ai_grade_suggestions (student_id);

ALTER TABLE public.assignment_ai_grade_suggestions ENABLE ROW LEVEL SECURITY;

-- Staff SELECT only. No student policy. No write policy (admin client only).
CREATE POLICY "Section owner/staff can read AI grade suggestions"
  ON public.assignment_ai_grade_suggestions
  FOR SELECT
  TO authenticated
  USING (public.is_section_owner_or_staff(section_id));

-- Table privileges. Supabase's default-privilege auto-grant to
-- anon/authenticated/service_role is not guaranteed to fire for these tables, so
-- grant explicitly and match the SELECT-only policy: authenticated may read
-- (further constrained to staff by the RLS policy above), while all writes go
-- through the service-role admin client. anon gets nothing.
GRANT SELECT ON public.assignment_ai_grade_suggestions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assignment_ai_grade_suggestions TO service_role;
