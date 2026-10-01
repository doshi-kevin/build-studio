-- Storage lockdown — Phase 3a: live-classroom-decks bucket.
--
-- Pre-Phase-3a state: public bucket. Slides served via /object/public/...
-- with no auth check. Anyone with a room UUID could enumerate slides.
--
-- Post-Phase-3a:
--   • Bucket flipped public=false
--   • Storage RLS gates SELECT to professor + enrolled students of the
--     room's section, via the existing lc_user_can_access_room() helper
--   • App reads mint short-lived signed URLs at room-snapshot time
--     (server action), with a 6h TTL for long sessions and a re-snapshot
--     refresh well before expiry
--   • Upload paths are now VERSIONED:
--       live-classroom-decks/{roomId}/{deckVersion}/page-N.webp
--     Re-uploads write to a fresh `{deckVersion}` subfolder so
--     Supabase's CDN cache (keyed on path) doesn't serve stale bytes.
--   • The lc_rooms_after_update trigger now broadcasts `deck_ready` on
--     ANY deck_url change (not just NULL→set), so re-uploads land in
--     joined clients without a refresh.

BEGIN;

-- ── 1. Flip bucket to private ──────────────────────────────────────
UPDATE storage.buckets
   SET public = false
 WHERE id = 'live-classroom-decks';

-- ── 2. Storage RLS policies on storage.objects ─────────────────────
-- Path schema: {roomId}/{deckVersion}/page-N.webp
-- (storage.foldername(name))[1] = roomId — the part we authorize on.

DROP POLICY IF EXISTS "Live classroom decks: read access" ON storage.objects;
CREATE POLICY "Live classroom decks: read access"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'live-classroom-decks'
    AND public.lc_user_can_access_room(
      auth.uid(),
      ((storage.foldername(name))[1])::uuid
    )
  );

-- INSERT: belt-and-suspenders. Actual uploads come from the admin client
-- (service role bypasses RLS), so this only matters for browser SDK calls.
-- Restricted to the room's professor.
DROP POLICY IF EXISTS "Live classroom decks: room owner upload" ON storage.objects;
CREATE POLICY "Live classroom decks: room owner upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'live-classroom-decks'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.lc_rooms r
       WHERE r.id = ((storage.foldername(name))[1])::uuid
         AND r.prof_id = auth.uid()
    )
  );

-- DELETE: only the room's professor. Used when garbage-collecting old
-- deck versions during a re-upload.
DROP POLICY IF EXISTS "Live classroom decks: room owner delete" ON storage.objects;
CREATE POLICY "Live classroom decks: room owner delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'live-classroom-decks'
    AND EXISTS (
      SELECT 1 FROM public.lc_rooms r
       WHERE r.id = ((storage.foldername(name))[1])::uuid
         AND r.prof_id = auth.uid()
    )
  );

-- ── 3. Re-fire `deck_ready` on any deck_url change ─────────────────
-- The previous trigger only fired on NULL→set. With versioned paths,
-- a re-upload changes deck_url from one non-null value to another, and
-- joined clients must re-snapshot to pick up fresh signed URLs for the
-- new version. Broaden the condition.

CREATE OR REPLACE FUNCTION public.lc_rooms_after_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.current_slide IS DISTINCT FROM OLD.current_slide THEN
    PERFORM lc_send_event(NEW.id, 'slide_changed',
      jsonb_build_object('slideIndex', NEW.current_slide));
  END IF;

  -- Fire on ANY deck_url change: NULL→set OR re-upload (set→set').
  -- Clients respond by re-snapshotting to pick up fresh signed URLs.
  IF NEW.deck_url IS DISTINCT FROM OLD.deck_url AND NEW.deck_url IS NOT NULL THEN
    PERFORM lc_send_event(NEW.id, 'deck_ready', jsonb_build_object(
      'deckUrl', NEW.deck_url,
      'deckPageCount', NEW.deck_page_count
    ));
  END IF;

  IF NEW.status = 'ended' AND OLD.status = 'live' THEN
    PERFORM lc_send_event(NEW.id, 'room_ended', jsonb_build_object());
    DELETE FROM lc_events WHERE room_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

COMMIT;
