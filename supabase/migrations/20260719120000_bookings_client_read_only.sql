-- ============================================================
-- Migration: Make `bookings` client-read-only (close the write hole)
--
-- `bookings` is written ONLY through the admin client in server actions
-- (student/office-hours/actions.ts, professor/calendar/actions.ts), each of which
-- runs the full authz + slot-validation + atomic-guard sequence. The base policies
-- in 00000000000010_remaining_features.sql granted direct client write access that
-- bypasses every one of those checks:
--
--   • "Students can insert own bookings" — WITH CHECK only pinned `student_id`, so a
--     student could POST a row straight to PostgREST with an arbitrary `office_hours_id`
--     (including one from a DIFFERENT institution — the write-path twin of the
--     office_hours SELECT leak that 20260718130000 just closed), `professor_id`, or
--     `status`.
--   • "Students can update own bookings" — no WITH CHECK at all, so a student could
--     rewrite ANY column on their own row (`status`, `professor_note`, `cancelled_by`),
--     sidestepping the atomic `status = 'booked'` guards that cancelBooking /
--     markBookingStatus rely on.
--   • "Professors can manage bookings for their office hours" — FOR ALL, the same
--     write hole on the professor side.
--
-- This is the ".claude/rules/security-migrations.md" — FOR ALL / no-column-scoped
-- WITH CHECK is a write hole" pattern (real incident: PR #198), surfaced again in the
-- PR #437 review. Since the app has NO client write path to this table (verified: the
-- only client-side access is the Realtime postgres_changes *read* subscription on both
-- the professor and student calendars), the correct fix is to drop client write access
-- entirely and keep SELECT so Realtime still delivers.
--
-- Writes are unaffected — they go through the service-role admin client, which bypasses
-- RLS.
-- Created: 2026-07-19
-- ============================================================

-- Remove the three client-writable policies.
DROP POLICY IF EXISTS "Students can insert own bookings" ON public.bookings;
DROP POLICY IF EXISTS "Students can update own bookings" ON public.bookings;
DROP POLICY IF EXISTS "Professors can manage bookings for their office hours" ON public.bookings;

-- Professors keep READ access to bookings for their own office hours (needed for the
-- Realtime subscription + reads); all writes go through the admin client in server actions.
-- auth.uid() is wrapped in a scalar subquery so the planner evaluates it once per query,
-- not once per row (auth_rls_initplan advisor).
CREATE POLICY "Professors can view bookings for their office hours"
  ON public.bookings FOR SELECT
  USING (professor_id = (select auth.uid()));

-- The existing "Students can view own bookings" (FOR SELECT USING student_id = auth.uid())
-- policy from the base migration is retained and continues to scope the student read path.
