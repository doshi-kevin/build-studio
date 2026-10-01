-- Assignment refinements:
--   1. A `returned` submission status so a professor can re-open a submitted or
--      graded submission for changes; the student can then resubmit.
--   2. An auto-zero pg_cron job: any enrolled student who never submitted to a
--      published, past-due assignment is recorded as graded 0. Matches the
--      existing scheduled-job pattern (see lc_rooms_auto_end).

-- ── 1. add 'returned' to the status check ────────────────────────
ALTER TABLE public.assignment_submissions
  DROP CONSTRAINT IF EXISTS assignment_submissions_status_check;

ALTER TABLE public.assignment_submissions
  ADD CONSTRAINT assignment_submissions_status_check
  CHECK (status IN ('draft', 'submitted', 'graded', 'returned'));

-- ── 2. auto-zero non-submitters past the deadline ────────────────
-- Inserts a graded-0 row for every enrolled student with no submission row on a
-- published assignment whose due date has passed. ON CONFLICT guards against
-- double-running; students who later get re-opened ('returned') already have a
-- row, so they're never re-zeroed.
CREATE OR REPLACE FUNCTION public.finalize_overdue_assignments() RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public'
AS $$
  INSERT INTO public.assignment_submissions
    (assignment_id, student_id, institution_id, status, score, feedback, graded_at)
  SELECT a.id, e.student_id, a.institution_id, 'graded', 0,
         'No submission received before the deadline (auto-graded 0).', now()
    FROM public.assignments a
    JOIN public.enrollments e
      ON e.section_id = a.section_id
     AND e.status IN ('enrolled', 'active', 'completed')
   WHERE a.status = 'published'
     AND a.due_at IS NOT NULL
     AND a.due_at < now()
     AND NOT EXISTS (
       SELECT 1 FROM public.assignment_submissions s
        WHERE s.assignment_id = a.id AND s.student_id = e.student_id
     )
  ON CONFLICT (assignment_id, student_id) DO NOTHING;
$$;

-- Run every 15 minutes (pg_cron already enabled in migration 34).
SELECT cron.schedule(
  'finalize_overdue_assignments',
  '*/15 * * * *',
  $$ SELECT public.finalize_overdue_assignments(); $$
);
