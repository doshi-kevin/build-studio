-- lc_auto_end_stale_rooms: don't let storage cleanup wedge the row update.
--
-- Pre-this-migration: the function looped UPDATE lc_rooms ... then
-- DELETE FROM storage.objects in the SAME transaction. After mig 51 dropped
-- the legacy "Allow authenticated deletes" policy on storage.objects,
-- the supabase-installed trigger now rejects direct deletes from that
-- table ("Direct deletion from storage tables is not allowed. Use the
-- Storage API instead."). That error rolls back the whole transaction,
-- so the room never flipped to 'ended' and the cron has been failing
-- silently every 15 minutes — surfacing as multi-day-old "LIVE NOW"
-- cards on the student page.
--
-- Fix: do the row update in its own iteration commit, and try the
-- storage cleanup separately wrapped in a BEGIN/EXCEPTION block so a
-- delete failure can no longer wedge the status flip. The deck-file
-- reaper (lc_reap_orphan_decks, cron job 11) is a daily fallback that
-- removes any decks orphaned by this softer cleanup.

CREATE OR REPLACE FUNCTION public.lc_auto_end_stale_rooms()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $function$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id::text AS id
      FROM lc_rooms
     WHERE status = 'live'
       AND created_at < now() - interval '12 hours'
  LOOP
    UPDATE lc_rooms
       SET status = 'ended',
           ended_at = now()
     WHERE id = r.id::uuid;

    -- Best-effort storage cleanup. The supabase storage trigger blocks
    -- direct deletes since mig 51 (use the Storage API instead). Catch
    -- the exception so the row update isn't rolled back with it.
    BEGIN
      DELETE FROM storage.objects
       WHERE bucket_id = 'live-classroom-decks'
         AND name LIKE r.id || '/%';
    EXCEPTION WHEN OTHERS THEN
      -- swallow; lc_reap_orphan_decks (daily) handles leftovers
      NULL;
    END;
  END LOOP;
END $function$;
