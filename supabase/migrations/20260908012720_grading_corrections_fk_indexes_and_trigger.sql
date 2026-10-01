-- Follow-ups on assignment_grading_corrections from an external code review.
--
-- 1. Index the two remaining FK columns. Postgres does NOT auto-index foreign keys, and
--    every FK here is ON DELETE CASCADE: deleting a profile (a student erasure request, a
--    grader offboarding) forces a sequential scan and a lock on this table for each
--    unindexed referencing column. assignment_id / section_id / institution_id were
--    indexed in the creating migration; student_id and grader_id were missed.
--
-- 2. Attach the house updated_at trigger. The write path sets updated_at explicitly, so
--    this changes nothing for the app — it keeps the column honest under manual DB
--    intervention or any future bulk update. Safe HERE precisely because nothing guards on
--    this table's updated_at; the same trigger must NEVER be added to
--    assignment_ai_grade_suggestions, whose updated_at is the ghost-diff guard token and
--    must stay exactly the value the upsert RPC stamped and returned.

CREATE INDEX IF NOT EXISTS idx_grading_corrections_student
  ON public.assignment_grading_corrections (student_id);
CREATE INDEX IF NOT EXISTS idx_grading_corrections_grader
  ON public.assignment_grading_corrections (grader_id);

DROP TRIGGER IF EXISTS update_assignment_grading_corrections_updated_at
  ON public.assignment_grading_corrections;
CREATE TRIGGER update_assignment_grading_corrections_updated_at
  BEFORE UPDATE ON public.assignment_grading_corrections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
