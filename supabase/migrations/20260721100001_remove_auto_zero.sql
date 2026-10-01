-- Item 2: Remove auto-zero cron + repair phantom rows.

-- 1. Idempotently unschedule the finalize_overdue_assignments cron.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'finalize_overdue_assignments') THEN
    PERFORM cron.unschedule('finalize_overdue_assignments');
  END IF;
END;
$$;

-- 2. Drop the function if it still exists.
DROP FUNCTION IF EXISTS public.finalize_overdue_assignments();

-- 3. Repair phantom auto-zero rows back to un-submitted stubs.
--    These are rows graded as 0 by the cron (never actually submitted):
--    status='graded', submitted_at IS NULL, feedback = 'No submission received before the deadline (auto-graded 0).'
--    Preserve resubmit_until so any reopen windows stay intact.
--
--    score = 0 AND graded_by IS NULL are load-bearing, not redundant: they are the only things
--    separating a cron phantom from a row a professor has since graded FOR REAL. The grader
--    pre-fills its feedback box from the existing row, so a professor who scores an auto-zeroed
--    student (late paper, extenuating circumstances) without clearing that pre-filled text leaves
--    a row matching status/submitted_at/feedback exactly — gradeSubmission stamps score and
--    graded_by but never touches feedback. Without these two predicates this UPDATE would null a
--    real, student-visible grade with no recovery short of PITR.
UPDATE assignment_submissions
SET
  status    = 'draft',
  score     = NULL,
  graded_at = NULL,
  graded_by = NULL,
  feedback  = ''
WHERE status = 'graded'
  AND submitted_at IS NULL
  AND feedback = 'No submission received before the deadline (auto-graded 0).'
  AND score = 0
  AND graded_by IS NULL;
