-- The 12h auto-end clock was starting at the wrong moment.
--
-- lc_auto_end_stale_rooms ends rooms that have been live for 12 hours, measured
-- from created_at. For a start-now room those are minutes apart, so the sweep
-- behaved. For a SCHEDULED room they are not: created_at is when the professor
-- scheduled the session, which is routinely days before it runs.
--
-- So a class scheduled more than 12 hours in advance satisfied
-- `status='live' AND created_at < now() - 12h` the instant it was started, and
-- the next 15-minute tick ended it. The lc_rooms_after_update trigger then
-- broadcast room_ended to every student. The class died mid-lecture, in front
-- of the room, about a quarter hour after it began.
--
-- Never observed in production only because the scheduled-start path had not
-- been used for a real class yet: across 35 ended rooms carrying a started_at,
-- the largest created_at -> started_at gap was 0.1 hours, and none came from a
-- recurring series. It was armed, not firing.
--
-- started_at is the column that means "the class actually started" — see the
-- comment on it in the live-classroom actions, which is explicit that
-- created_at is merely when the room shell was opened. coalesce keeps the
-- original intent for rooms that predate the column (100% of September rooms
-- have it, coverage thins before August) and for room shells that were opened
-- and abandoned without ever starting, which is the case this sweep was built
-- for in the first place: those still expire 12h after creation.
--
-- The scheduled-but-never-started sweep below is unchanged.

create or replace function public.lc_auto_end_stale_rooms()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  /* Set-based and idempotent: the WHERE clause is the guard, so two overlapping runs cannot
     double-end a room, and the trigger above only fires on a genuine live -> ended transition. */
  UPDATE lc_rooms
     SET status = 'ended',
         ended_at = now()
   WHERE status = 'live'
     AND coalesce(started_at, created_at) < now() - interval '12 hours';

  UPDATE lc_rooms
     SET status = 'ended',
         ended_at = now()
   WHERE status = 'scheduled'
     AND scheduled_at IS NOT NULL
     AND scheduled_at < now() - interval '24 hours';
END $function$;

comment on function public.lc_auto_end_stale_rooms() is
  'Ends rooms left live for 12h (measured from started_at, falling back to created_at for rooms '
  'that never started or predate that column) or scheduled-but-unstarted for 24h. Called by the '
  'lc_rooms_auto_end pg_cron job every 15 minutes. Deliberately does NOT touch storage (#764): it '
  'used to delete the room deck objects inside a swallowed exception, which contradicted endRoom''s '
  'retention policy and destroyed files behind promoted module material.';
