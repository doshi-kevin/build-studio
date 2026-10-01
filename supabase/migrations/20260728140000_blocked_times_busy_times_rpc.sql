-- Fix: a professor's blocked_times.note (and reason) leaked to every student enrolled in
-- ANY of that professor's sections. The old policy "Students can view blocked times for slot
-- generation" was FOR SELECT over the whole row, but the student office-hours page only needs
-- busy TIME RANGES to grey out overlapping slots — never the free-text note or the reason.
-- With richer notes now likely (the "Add event" flow), that exposure matters more.
--
-- Fix in two parts:
--   1. Drop the student SELECT policy, so blocked_times is professor-only at the row level
--      (the professor's existing "... FOR ALL" policy on their own rows is untouched).
--   2. Expose a note-free / reason-free busy-times feed via a SECURITY DEFINER function,
--      gated to the professor themselves or a student enrolled in one of their sections
--      (same audience the dropped policy allowed). The student read switches to this
--      function (see calendarQueries.getProfessorBusyTimes). It returns recurrence fields so
--      recurring lectures also block overlapping bookings.

DROP POLICY IF EXISTS "Students can view blocked times for slot generation" ON public.blocked_times;

CREATE OR REPLACE FUNCTION public.professor_busy_times(p_professor_id uuid)
RETURNS TABLE (
  date DATE,
  start_time TEXT,
  end_time TEXT,
  recurrence TEXT,
  recurrence_until DATE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Defense-in-depth: an unauthenticated call (no JWT → NULL uid) returns nothing. Without
  -- this, `NULL = p_professor_id` is NULL and the NOT(...) guard below evaluates to NULL,
  -- which plpgsql treats as false — falling through and returning the professor's rows.
  IF (SELECT auth.uid()) IS NULL THEN
    RETURN;
  END IF;

  -- Authorize the caller: the professor, or a student enrolled in one of their sections
  -- (mirrors the audience of the dropped SELECT policy). Anyone else gets zero rows.
  IF NOT (
    (SELECT auth.uid()) = p_professor_id
    OR EXISTS (
      SELECT 1
      FROM public.course_sections cs
      JOIN public.enrollments e ON e.section_id = cs.id
      WHERE cs.professor_id = p_professor_id
        AND e.student_id = (SELECT auth.uid())
        AND e.status IN ('enrolled', 'completed')
    )
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT bt.date, bt.start_time, bt.end_time, bt.recurrence, bt.recurrence_until
    FROM public.blocked_times bt
    WHERE bt.professor_id = p_professor_id;
END;
$$;

-- Only signed-in users may call it; the body's own check narrows further to the right people.
REVOKE ALL ON FUNCTION public.professor_busy_times(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.professor_busy_times(uuid) TO authenticated;
