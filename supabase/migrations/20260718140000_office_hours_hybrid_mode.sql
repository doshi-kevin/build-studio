-- Allow the 'hybrid' office-hours mode. The app added hybrid (professor sets it, student
-- then picks In Person or Zoom at booking), but the office_hours CHECK still only permitted
-- in_person/zoom, so every hybrid create failed with a CHECK violation (23514) surfaced as a
-- generic "Failed to create office hours".
--
-- bookings.meeting_type stays ('in_person','zoom') on purpose — a booking is always a
-- CONCRETE mode (BOOKING_MEETING_TYPES) — so that constraint is left unchanged.

ALTER TABLE public.office_hours DROP CONSTRAINT IF EXISTS office_hours_meeting_type_check;
ALTER TABLE public.office_hours
  ADD CONSTRAINT office_hours_meeting_type_check
  CHECK (meeting_type IN ('in_person', 'zoom', 'hybrid'));
