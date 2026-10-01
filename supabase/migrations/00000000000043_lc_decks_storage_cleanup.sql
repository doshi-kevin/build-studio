-- Plug the storage leak: when lc_rooms_auto_end runs (or any other path
-- ends/deletes a room), the rendered slide images in
-- `live-classroom-decks/<roomId>/` were left behind. This migration
-- closes both leaks.
--
-- 1. Extends `lc_auto_end_stale_rooms()` to delete the room's deck folder
--    inline. Supabase Storage's internal handler picks up the
--    `storage.objects` DELETE and reaps the underlying S3 files.
-- 2. Adds `lc_reap_orphan_decks()` — a daily sweep that deletes any
--    deck folder whose lc_rooms row is gone OR has been `ended` for more
--    than 1 hour (grace period covers students whose UI is slow to
--    receive the room_ended broadcast).

-- ── Updated auto-end: also wipes the room's deck folder ──────────────

CREATE OR REPLACE FUNCTION lc_auto_end_stale_rooms() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id::text AS id
      FROM lc_rooms
     WHERE status = 'live'
       AND created_at < now() - interval '12 hours'
  LOOP
    -- Flip status first so the room_ended trigger broadcasts to any
    -- still-connected clients.
    UPDATE lc_rooms
       SET status = 'ended',
           ended_at = now()
     WHERE id = r.id::uuid;

    -- Best-effort delete of the deck images. Path layout is
    -- `<roomId>/page-<n>.webp` per the render-deck route.
    DELETE FROM storage.objects
     WHERE bucket_id = 'live-classroom-decks'
       AND name LIKE r.id || '/%';
  END LOOP;
END $$;

-- ── Orphan reaper: catches anything the inline cleanup missed ────────
-- Triggers when:
--   • lc_rooms row was deleted (cascade from section/professor cleanup,
--     or any future hard delete)
--   • room transitioned to 'ended' via a path that didn't clean storage
--     (legacy rooms from before this fix, manual SQL updates, etc.)
--   • room has been ended for >1 hour (grace period — see header)

CREATE OR REPLACE FUNCTION lc_reap_orphan_decks() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM storage.objects o
   WHERE o.bucket_id = 'live-classroom-decks'
     AND NOT EXISTS (
       SELECT 1
         FROM lc_rooms r
        WHERE o.name LIKE r.id::text || '/%'
          AND (
            r.status = 'live'
            OR (r.ended_at IS NOT NULL AND r.ended_at > now() - interval '1 hour')
          )
     );
END $$;

-- Daily at 03:00 UTC. Off-peak so the deletes don't compete with class
-- sessions.
SELECT cron.schedule(
  'lc_decks_orphan_reaper',
  '0 3 * * *',
  $$ SELECT lc_reap_orphan_decks(); $$
);
