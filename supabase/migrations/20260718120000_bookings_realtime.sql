-- Live-update the professor's calendar when a student books/cancels a slot.
--
-- The professor's calendar is a client component seeded once on load, so a booking made
-- by a *different* user (the student) doesn't appear until a manual refresh. Adding
-- `bookings` to the Realtime publication lets the professor's page subscribe to
-- postgres_changes and reflect bookings live. RLS still scopes which rows each client
-- receives ("Professors can manage bookings for their office hours" / "Students can view
-- own bookings"), so no cross-tenant exposure.
--
-- REPLICA IDENTITY FULL so UPDATE/DELETE events carry the full row for the RLS check.

ALTER TABLE public.bookings REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'bookings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bookings;
  END IF;
END $$;
