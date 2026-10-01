-- Phase 4 follow-up: surface deck-render lifecycle to all clients in real
-- time, not just at the terminal "deck_ready" boundary.
--
-- Adds two new event types broadcast by the render-deck route directly
-- (no DB row change involved — the route calls lc_send_event with
-- p_persist=false so they don't bloat lc_events):
--
--   • deck_render_progress  — emitted after each page upload succeeds.
--                             Drives the prof's progress bar.
--   • deck_failed           — emitted on terminal failure (page upload
--                             error, render error). Lets students drop
--                             out of "Waiting for slides" gracefully
--                             instead of waiting forever.
--
-- No schema change. The route imports lc_send_event via supabase RPC.
-- This migration just exists as a documentation marker so dev DBs and
-- prod stay in lockstep about the event surface.

-- Make sure lc_send_event can be called from the server (it already can —
-- the function is SECURITY DEFINER and lives in public — this is a no-op
-- assertion that doubles as a self-test if someone runs `supabase db reset`.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'lc_send_event' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'lc_send_event not found — apply migration 34 first';
  END IF;
END $$;
