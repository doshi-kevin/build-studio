-- Migration: Add missing RLS policies for project_teams and project_grades
-- These tables had RLS enabled (migration 10) but zero policies defined.
-- This is a critical security fix — without policies, RLS blocks ALL access
-- via the client (anon/authenticated) but admin client bypasses it.
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- project_teams RLS POLICIES
-- ════════════════════════════════════════════════════════════

-- SELECT: Enrolled students can see all teams in their section (for browsing/joining)
-- and professors can see teams in sections they own.
CREATE POLICY "Enrolled students can read teams"
  ON public.project_teams FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.enrollments e ON e.section_id = p.section_id
      WHERE p.id = project_teams.project_id
        AND e.student_id = auth.uid()
        AND e.status IN ('active', 'completed')
    )
  );

CREATE POLICY "Professors can read section teams"
  ON public.project_teams FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE p.id = project_teams.project_id
        AND cs.professor_id = auth.uid()
    )
  );

-- INSERT: Enrolled students can create teams (created_by must be self)
-- Professors can also create teams in their sections.
CREATE POLICY "Enrolled students can create teams"
  ON public.project_teams FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.enrollments e ON e.section_id = p.section_id
      WHERE p.id = project_teams.project_id
        AND e.student_id = auth.uid()
        AND e.status = 'active'
    )
  );

CREATE POLICY "Professors can create teams"
  ON public.project_teams FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE p.id = project_teams.project_id
        AND cs.professor_id = auth.uid()
    )
  );

-- UPDATE: Only team creator or section professor can update team details.
CREATE POLICY "Team creators can update own teams"
  ON public.project_teams FOR UPDATE
  USING (created_by = auth.uid());

CREATE POLICY "Professors can update section teams"
  ON public.project_teams FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE p.id = project_teams.project_id
        AND cs.professor_id = auth.uid()
    )
  );

-- DELETE: Only team creator or section professor can delete teams.
CREATE POLICY "Team creators can delete own teams"
  ON public.project_teams FOR DELETE
  USING (created_by = auth.uid());

CREATE POLICY "Professors can delete section teams"
  ON public.project_teams FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE p.id = project_teams.project_id
        AND cs.professor_id = auth.uid()
    )
  );

-- ════════════════════════════════════════════════════════════
-- project_grades RLS POLICIES
-- ════════════════════════════════════════════════════════════

-- SELECT: Team members can read their own team's grade.
-- Professors can read all grades in their sections.
CREATE POLICY "Team members can read own grade"
  ON public.project_grades FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.team_id = project_grades.team_id
        AND pm.user_id = auth.uid()
    )
  );

CREATE POLICY "Professors can read section grades"
  ON public.project_grades FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE p.id = project_grades.project_id
        AND cs.professor_id = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE: Professor only (grading is a professor action).
CREATE POLICY "Professors can insert grades"
  ON public.project_grades FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE p.id = project_grades.project_id
        AND cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Professors can update grades"
  ON public.project_grades FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE p.id = project_grades.project_id
        AND cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Professors can delete grades"
  ON public.project_grades FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE p.id = project_grades.project_id
        AND cs.professor_id = auth.uid()
    )
  );

-- ════════════════════════════════════════════════════════════
-- PERFORMANCE INDEXES for RLS subqueries
-- ════════════════════════════════════════════════════════════

-- These indexes support the EXISTS subqueries in the policies above.
-- Most already exist from migration 10, but adding any missing ones.
CREATE INDEX IF NOT EXISTS idx_project_grades_graded_by
  ON public.project_grades(graded_by);

CREATE INDEX IF NOT EXISTS idx_enrollments_section_student
  ON public.enrollments(section_id, student_id);
