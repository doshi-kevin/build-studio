-- Auto-end live rooms left open by the professor.
--
-- Without this, a forgotten room stays status='live' indefinitely:
--   • lc_events prune cron skips live rooms → events accumulate
--   • lc_slide_annotations has no TTL → strokes pile up
--   • realtime channel keeps metering against the plan
--   • snapshot grows linearly for late joiners
--   • ghost "live" rooms in a section confuse the join CTA
--
-- Hard cap: any room older than 12 hours that's still 'live' gets flipped
-- to 'ended'. The existing lc_rooms_after_update trigger will broadcast
-- 'room_ended' to all subscribed clients and the lc_events purge will
-- catch up on the next prune tick.

CREATE OR REPLACE FUNCTION lc_auto_end_stale_rooms() RETURNS void
LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE lc_rooms
     SET status = 'ended',
         ended_at = now()
   WHERE status = 'live'
     AND created_at < now() - interval '12 hours';
$$;

SELECT cron.schedule(
  'lc_rooms_auto_end',
  '*/15 * * * *',  -- every 15 min
  $$ SELECT lc_auto_end_stale_rooms(); $$
);
