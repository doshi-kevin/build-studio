-- enrollments had RLS enabled but zero policies, which means the authenticated
-- role was denied by default. Every student-facing policy on other tables
-- (live_polls, session_questions, classroom_sessions, live_quizzes, projects,
-- challenges, badges, announcement_reactions, roadmap_node_status, …) checks
-- enrollment with
--   EXISTS (SELECT 1 FROM enrollments WHERE student_id = auth.uid() …)
-- Those subqueries silently returned empty under RLS, so students saw nothing
-- via the browser client. Server actions were unaffected because they use
-- createAdminClient() which bypasses RLS.
--
-- Naive "professor can view enrollments" policy that selects course_sections
-- would recurse once we add a symmetric policy on course_sections in
-- migration 33. Use a SECURITY DEFINER helper to short-circuit RLS.

CREATE OR REPLACE FUNCTION public.is_professor_of_section(s_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.course_sections
    WHERE id = s_id AND professor_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_professor_of_section(uuid) TO authenticated;

DROP POLICY IF EXISTS "Students can view own enrollments" ON public.enrollments;
CREATE POLICY "Students can view own enrollments"
  ON public.enrollments FOR SELECT
  TO authenticated
  USING (student_id = auth.uid());

DROP POLICY IF EXISTS "Professors view enrollments in their sections" ON public.enrollments;
CREATE POLICY "Professors view enrollments in their sections"
  ON public.enrollments FOR SELECT
  TO authenticated
  USING (public.is_professor_of_section(section_id));
