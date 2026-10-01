-- Two project policies never matched a single row, because they use a status
-- vocabulary the enrollments table no longer writes.
--
-- Found while QA-ing the PR #656 release gate. A student could not read their own
-- released project grade through PostgREST, and the trail led here rather than to
-- anything in #656:
--
--   projects      "Enrolled students can read course-visible projects"  status IN ('active','completed')
--   project_teams "Enrolled students can read teams"                    status IN ('active','completed')
--
-- Every enrollment in production has status 'enrolled'. All 16 of them. So both
-- policies match nothing, for every student, on every section.
--
-- These two are outliers, not the convention. Of the 24 policies that gate on
-- enrollment status, 22 already accept 'enrolled' — including every policy #656
-- itself added. These were simply missed when the vocabulary moved.
--
-- ── This is fail-CLOSED, so it is not a leak ────────────────────────────────────
-- An over-restrictive policy denies; it does not expose. Nothing was readable that
-- should not have been. Two things are wrong anyway:
--
--   1. RLS is doing NO work for projects or project_teams. The student-facing
--      Projects UI works only because its server actions go through the admin
--      client, which bypasses RLS by design. The database is currently more
--      restrictive than the application, which means the "last line of defence"
--      is not a line at all — it is a wall with nothing behind it. The moment any
--      surface reads these tables with the user client, it silently returns empty.
--
--   2. It defeats the #656 release gate as a DB-level control. That gate reads
--      `project_grade_releases` from inside the `project_item_scores` policy, and a
--      policy subquery runs as the CALLER — so it is itself RLS-filtered. The
--      release policy joins through `projects`, which denies, so the gate evaluates
--      false whether or not a release exists. Verified against production: a student
--      saw 0 score rows before release AND 0 after. The gate looked like it worked
--      and was in fact inert.
--
-- The application-side gate is correct and unaffected: the student grades action
-- refuses any project without a release row (`if (!st || !releasedAt.has(p.id))
-- return null`) and hands the engine a one-student roster, so no teammate's score
-- is computed. This migration restores the second lock, it does not create the first.
--
-- Only the status list changes. Visibility, tenancy and the join shape are kept
-- exactly as they were.

DROP POLICY IF EXISTS "Enrolled students can read course-visible projects" ON public.projects;
CREATE POLICY "Enrolled students can read course-visible projects"
  ON public.projects FOR SELECT
  USING (
    visibility = ANY (ARRAY['course'::text, 'public'::text])
    AND section_id IN (
      SELECT e.section_id FROM public.enrollments e
      WHERE e.student_id = (SELECT auth.uid())
        AND e.status = ANY (ARRAY['enrolled'::text, 'active'::text, 'completed'::text])
    )
  );

DROP POLICY IF EXISTS "Enrolled students can read teams" ON public.project_teams;
CREATE POLICY "Enrolled students can read teams"
  ON public.project_teams FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      JOIN public.enrollments e ON e.section_id = p.section_id
      WHERE p.id = project_teams.project_id
        AND e.student_id = (SELECT auth.uid())
        AND e.status = ANY (ARRAY['enrolled'::text, 'active'::text, 'completed'::text])
    )
  );
