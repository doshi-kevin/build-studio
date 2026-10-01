-- Student personal calendar events (design: docs/designs/notifications-calendar/student-personal-calendar-events.md).
--
-- Lets a student add their own events (study blocks, reminders) to /student/calendar, shown
-- alongside course items and included in the ICS feed. Student-owned; the app writes ONLY via
-- the server action + admin client, so the table is SELECT-only for the client (mirrors
-- feed_items / bookings). institution_id is the tenant key and comes from the verified session.

CREATE TABLE IF NOT EXISTS public.personal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  title text NOT NULL,
  date date NOT NULL,
  start_time text,          -- "HH:MM" (America/New_York wall-clock), null when all_day
  end_time text,            -- "HH:MM", null when all_day
  all_day boolean NOT NULL DEFAULT false,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.personal_events ENABLE ROW LEVEL SECURITY;

-- Read: the owner only. Writes go through the admin client behind the authz'd server action,
-- so there is deliberately NO client INSERT/UPDATE/DELETE policy (a FOR ALL would let a student
-- write arbitrary rows/columns via PostgREST). auth.uid() wrapped in a scalar subquery per the
-- RLS init-plan advisor.
CREATE POLICY "Students read own personal events"
  ON public.personal_events FOR SELECT TO authenticated
  USING (student_id = (select auth.uid()));

-- The calendar aggregator + editor both filter by (student_id, date-window).
CREATE INDEX IF NOT EXISTS idx_personal_events_student_date
  ON public.personal_events(student_id, date);
