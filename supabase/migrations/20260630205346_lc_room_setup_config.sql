-- Live Classroom: pre-class setup step (session name + "Catch me up" toggle)
-- and a setup-lifecycle flag.
--
--   • name                    — professor-given session title (optional).
--   • lecture_summary_enabled — per-session "Catch me up" toggle. Default TRUE
--     so the student feature is never hidden by default (project rule); the
--     professor turns it off per session in the pre-class setup step.
--   • setup_completed         — false while the professor is on the pre-class
--     setup screen (picking a deck, naming, configuring). startLiveClass flips
--     it true, which is when the deck is activated (lc_rooms.deck_url set) and
--     the existing deck_ready trigger fires for students/projector.
--
-- These are non-tenant-key columns on lc_rooms, which already has RLS — no new
-- policy needed.

BEGIN;

ALTER TABLE public.lc_rooms
  ADD COLUMN name                    text,
  ADD COLUMN lecture_summary_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN setup_completed         boolean NOT NULL DEFAULT false;

-- Backfill: every pre-existing room predates the setup step (it's either live
-- and already presenting, or ended). Mark them all setup_completed so this
-- migration never strands an in-flight session on the new setup screen. New
-- rooms created after this point inherit the FALSE column default.
UPDATE public.lc_rooms SET setup_completed = true;

COMMIT;
