-- Assignment Studio v2 — ungraded assignments, scheduled publish, MCQ question type.
-- Additive to 20260617024531_assignments.sql + 20260617044419_assignment_refinements.sql.
-- NO new tables: every new column inherits the existing table RLS. Students stay
-- SELECT-only on assignment_submissions (the v1 fix) — MCQ answers are written via the
-- admin client in submitAssignment, never client-side. So no new policies are needed.

-- ── assignments: ungraded flag + scheduled publish ─────────────
ALTER TABLE public.assignments
  ADD COLUMN IF NOT EXISTS is_graded boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS scheduled_publish_at timestamptz;

-- widen status (add 'scheduled') and submission_type (add 'mcq')
ALTER TABLE public.assignments DROP CONSTRAINT IF EXISTS assignments_status_check;
ALTER TABLE public.assignments ADD CONSTRAINT assignments_status_check
  CHECK (status IN ('draft', 'scheduled', 'published', 'closed', 'archived'));

ALTER TABLE public.assignments DROP CONSTRAINT IF EXISTS assignments_submission_type_check;
ALTER TABLE public.assignments ADD CONSTRAINT assignments_submission_type_check
  CHECK (submission_type IN ('written', 'link', 'files', 'code', 'mcq'));

CREATE INDEX IF NOT EXISTS idx_assignments_scheduled
  ON public.assignments(scheduled_publish_at) WHERE status = 'scheduled';

-- ── assignment_submissions: MCQ answers ────────────────────────
-- [{questionId, optionIds: []}] — selections only; the answer key (correctOptionIds)
-- lives in the assignment settings and is never written here.
ALTER TABLE public.assignment_submissions
  ADD COLUMN IF NOT EXISTS answers jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- rubric_scores: the criterion keys ("<qIdx>:<cIdx>") the professor ticked when grading
  -- against the rubric. The score is the sum of those criteria's points.
  ADD COLUMN IF NOT EXISTS rubric_scores jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ── auto-publish scheduled assignments (pg_cron, every 5 min) ──
CREATE OR REPLACE FUNCTION public.publish_scheduled_assignments() RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.assignments
     SET status = 'published', published_at = now(), updated_at = now()
   WHERE status = 'scheduled'
     AND scheduled_publish_at IS NOT NULL
     AND scheduled_publish_at <= now();
$$;

-- ── ungraded assignments never auto-zero (add a.is_graded guard) ──
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
     AND a.is_graded
     AND a.due_at IS NOT NULL
     AND a.due_at < now()
     AND NOT EXISTS (
       SELECT 1 FROM public.assignment_submissions s
        WHERE s.assignment_id = a.id AND s.student_id = e.student_id
     )
  ON CONFLICT (assignment_id, student_id) DO NOTHING;
$$;

-- cron.schedule upserts by job name on the deployed pg_cron, so this is safe to re-apply.
SELECT cron.schedule(
  'publish_scheduled_assignments',
  '*/5 * * * *',
  $$ SELECT public.publish_scheduled_assignments(); $$
);

-- PostgreSQL grants EXECUTE to PUBLIC by default on SECURITY DEFINER functions, meaning any
-- authenticated Supabase user could call these via the REST API and trigger cross-institution
-- side-effects. Restrict to postgres (superuser) only — pg_cron runs as postgres and continues
-- to work. finalize_overdue_assignments() is the critical one: without this revoke a student
-- from Institution A could auto-zero submissions across all institutions.
REVOKE EXECUTE ON FUNCTION public.finalize_overdue_assignments() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.publish_scheduled_assignments() FROM PUBLIC;
