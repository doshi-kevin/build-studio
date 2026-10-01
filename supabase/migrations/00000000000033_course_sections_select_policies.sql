-- course_sections had RLS enabled with zero policies, so every classroom /
-- course-scoped policy that checks course_sections via EXISTS silently
-- returned false for the authenticated client. Server actions worked because
-- they use createAdminClient() (service role bypasses RLS), but browser-client
-- reads and realtime postgres_changes subscriptions were broken for both roles.
--
-- Symptom: professor's Live Classroom results panel showed 0 poll responses
-- even though responses existed in the DB; participants, session_questions,
-- live_polls and live_quizzes RLS were all failing on the professor's client
-- because each of them EXISTS-checks course_sections.
--
-- We use SECURITY DEFINER helpers for the enrollment / staff checks so that
-- policies on enrollments and course_sections don't cross-recurse.

CREATE OR REPLACE FUNCTION public.is_enrolled_in_section(s_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.enrollments
    WHERE section_id = s_id
      AND student_id = auth.uid()
      AND status IN ('enrolled', 'completed')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_staff_of_section(s_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.section_staff
    WHERE section_id = s_id AND staff_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_enrolled_in_section(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff_of_section(uuid) TO authenticated;

DROP POLICY IF EXISTS "Professors view own sections" ON public.course_sections;
CREATE POLICY "Professors view own sections"
  ON public.course_sections FOR SELECT
  TO authenticated
  USING (professor_id = auth.uid());

DROP POLICY IF EXISTS "Students view enrolled sections" ON public.course_sections;
CREATE POLICY "Students view enrolled sections"
  ON public.course_sections FOR SELECT
  TO authenticated
  USING (public.is_enrolled_in_section(id));

DROP POLICY IF EXISTS "Staff view assigned sections" ON public.course_sections;
CREATE POLICY "Staff view assigned sections"
  ON public.course_sections FOR SELECT
  TO authenticated
  USING (public.is_staff_of_section(id));
