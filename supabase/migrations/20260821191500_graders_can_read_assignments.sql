-- Let active graders READ their section's assignments (#746 follow-through).
--
-- Found by browser QA of the #746 change, not by reading code: signed in as a grader,
-- /professor/courses/<id>/assignments renders the first-run empty state ("Create your
-- first assignment") while the professor sees 21 — but the gradebook's Assignments tab
-- lists all 21, and deep-linking an assignment works. So a grader's only route to the
-- submissions they exist to grade was via Grades, or a pasted URL.
--
-- Cause: the assignments page reads with the USER client, so RLS scopes it, and
-- "Professors and TAs can manage section assignments" (20260617024531_assignments.sql)
-- restricts the staff branch to `role = 'ta'`. That was correct when graders were
-- read-only everywhere. Now that canGrade() admits them to score writes, "can grade but
-- cannot find anything to grade" is the decision only half-applied.
--
-- Deliberately a SEPARATE, SELECT-ONLY policy rather than widening the existing FOR ALL
-- one. Policies are OR'd, so this grants read without granting a grader any of the
-- authoring writes that policy also covers — which is the same split as the discussion
-- helpers in 20260821174702: reads admit TA and grader, authoring admits TA only.
--
-- ends_at > now() and status = 'active' mirror verifySectionAccess, so a revoked or
-- expired grader loses this read in the same instant they lose application access.

DROP POLICY IF EXISTS "Active graders can read section assignments" ON public.assignments;

CREATE POLICY "Active graders can read section assignments"
  ON public.assignments FOR SELECT
  USING (
    section_id IN (
      SELECT section_id FROM public.section_staff
      WHERE staff_id = auth.uid()
        AND status = 'active'
        AND ends_at > now()
        AND role = 'grader'
    )
  );
