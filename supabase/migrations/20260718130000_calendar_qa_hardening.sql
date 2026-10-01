-- QA hardening for the calendar / office-hours feature.

-- C2 (cross-tenant leak): the student office_hours view policy was `USING (is_active =
-- true)` — every authenticated student could read (and, via createBooking, book) EVERY
-- institution's office hours (professor names, emails, locations, zoom links). Scope it to
-- the student's own institution. office_hours has no institution_id, so resolve it through
-- profiles. Professors still read/write their own via the separate
-- "Professors can manage own office hours" ALL policy.
DROP POLICY IF EXISTS "Students can view active office hours" ON public.office_hours;
CREATE POLICY "Students view active office hours in their institution"
ON public.office_hours FOR SELECT TO authenticated
USING (
  is_active = true
  AND EXISTS (
    SELECT 1
    FROM public.profiles me
    JOIN public.profiles prof ON prof.institution_id = me.institution_id
    WHERE me.id = (SELECT auth.uid())
      AND prof.id = office_hours.professor_id
      AND me.institution_id IS NOT NULL
  )
);

-- M1 (double-booking): the app-layer "is this slot taken?" check is a non-atomic TOCTOU
-- (SELECT-then-INSERT across awaits) with no DB guard, so two students booking the same
-- slot in the same tick both succeed. Enforce one active booking per slot at the database;
-- createBooking now branches on the unique-violation.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_booking_active_slot
  ON public.bookings (office_hours_id, date, start_time)
  WHERE status = 'booked';

NOTIFY pgrst, 'reload schema';
