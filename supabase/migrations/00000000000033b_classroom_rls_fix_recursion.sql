-- Back-port of a hotfix that was applied directly to production on
-- 2026-04-24 (timestamp: 20260424170256_classroom_rls_fix_recursion) but
-- never committed to the repo. Pulled into the repo so a future
-- `supabase db reset` doesn't lose it.
--
-- Numbered 33b so it sequences AFTER 33 (course_sections_select_policies)
-- and BEFORE 34 (lc_events_and_broadcast). The "b" suffix avoids
-- renumbering downstream migrations and stays close to the original
-- prod ordering.
--
-- Fix: the enrollments and course_sections SELECT policies referenced
-- each other and produced infinite recursion under certain queries.
-- Replaces the recursive shape with SECURITY DEFINER helper functions
-- that short-circuit the lookup.

DROP POLICY IF EXISTS "Professors can view enrollments in their sections" ON public.enrollments;
DROP POLICY IF EXISTS "Professors view own sections" ON public.course_sections;
DROP POLICY IF EXISTS "Students view sections they are enrolled in" ON public.course_sections;
DROP POLICY IF EXISTS "Staff view assigned sections" ON public.course_sections;

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

GRANT EXECUTE ON FUNCTION public.is_professor_of_section(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_enrolled_in_section(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff_of_section(uuid) TO authenticated;

-- course_sections: professor sees own, students see enrolled, staff see assigned
CREATE POLICY "Professors view own sections"
  ON public.course_sections FOR SELECT
  TO authenticated
  USING (professor_id = auth.uid());

CREATE POLICY "Students view enrolled sections"
  ON public.course_sections FOR SELECT
  TO authenticated
  USING (public.is_enrolled_in_section(id));

CREATE POLICY "Staff view assigned sections"
  ON public.course_sections FOR SELECT
  TO authenticated
  USING (public.is_staff_of_section(id));

-- enrollments: professors see their sections' enrollments (via helper, no recursion)
CREATE POLICY "Professors view enrollments in their sections"
  ON public.enrollments FOR SELECT
  TO authenticated
  USING (public.is_professor_of_section(section_id));
