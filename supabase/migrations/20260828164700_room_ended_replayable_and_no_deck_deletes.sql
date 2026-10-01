-- #764: a room that ends must end on every device, and nothing may be silently deleted.
--
-- THE REAL CAUSE, which is not what I first put on the issue. I reported that the cron reaper
-- emitted no `room_ended`. It does emit one. `lc_rooms_after_update` fires on any live -> ended
-- transition and calls `lc_send_event(room_ended)`, which BOTH inserts into `lc_events` and
-- broadcasts over realtime. The bug is the very next statement:
--
--     DELETE FROM lc_events WHERE room_id = NEW.id;
--
-- It deletes every event for the room, including the `room_ended` row it just wrote. So the
-- ephemeral broadcast is the ONLY notification, and any client that was asleep, offline, or
-- mid-reconnect at that instant replays into an empty buffer and never learns the class is over.
--
-- That is exactly the reported evidence: a professor tab logged 104 `lc.replay.empty` against 2
-- `lc.replay.applied` and kept rendering live controls for ~4 hours. Replay was working perfectly
-- and correctly finding nothing, because the table had been emptied.
--
-- Confirmed against production: `lc_events` holds 0 rows across 231 ended rooms. Every session's
-- replay buffer has been purged, 231 times.
--
-- It also affects the MANUAL path, not just the cron. A professor ending class normally strands any
-- student who happens to be reconnecting at that moment, which makes this wider than the issue.
--
-- THE FIX. Preserve the terminal event and drop the rest. A reconnecting client replays, sees
-- `room_ended`, and ends the room. Growth stays bounded at one row per ended room rather than a
-- whole session's drawing and transcription batches.
--
-- Deliberately NOT removing the purge entirely: the buffer carries batched drawing strokes and
-- transcription, so an unbounded table on a busy term is a real cost, and whether that session
-- history should be retained is a retention decision rather than a bug fix. Raised separately.

create or replace function public.lc_rooms_after_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  IF NEW.current_slide IS DISTINCT FROM OLD.current_slide THEN
    PERFORM lc_send_event(NEW.id, 'slide_changed',
      jsonb_build_object('slideIndex', NEW.current_slide));
  END IF;

  IF NEW.is_blanked IS DISTINCT FROM OLD.is_blanked THEN
    PERFORM lc_send_event(NEW.id, 'screen_blank_changed',
      jsonb_build_object('isBlanked', NEW.is_blanked));
  END IF;

  IF NEW.deck_url IS DISTINCT FROM OLD.deck_url AND NEW.deck_url IS NOT NULL THEN
    PERFORM lc_send_event(NEW.id, 'deck_ready', jsonb_build_object(
      'deckUrl', NEW.deck_url,
      'deckPageCount', NEW.deck_page_count
    ));
  END IF;

  IF NEW.status = 'live' AND OLD.status = 'scheduled' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'seq', NULL,
        'ts', now(),
        'type', 'room_started',
        'data', jsonb_build_object(
          'roomId', NEW.id,
          'sectionId', NEW.section_id,
          'profId', NEW.prof_id,
          'createdAt', NEW.created_at
        )
      ),
      'room_started',
      'section:' || NEW.section_id || ':lc',
      true
    );
  END IF;

  IF NEW.status = 'ended' AND OLD.status = 'live' THEN
    /* Purge FIRST, then write the terminal event, so the delete cannot remove it. Ordering it the
       other way is the bug this migration fixes. */
    DELETE FROM lc_events WHERE room_id = NEW.id AND event_type <> 'room_ended';

    PERFORM lc_send_event(NEW.id, 'room_ended', jsonb_build_object());

    -- Also tell the student section hub so it swaps back to "Waiting" without a reload.
    PERFORM realtime.send(
      jsonb_build_object(
        'seq', NULL,
        'ts', now(),
        'type', 'room_ended',
        'data', jsonb_build_object(
          'roomId', NEW.id,
          'sectionId', NEW.section_id
        )
      ),
      'room_ended',
      'section:' || NEW.section_id || ':lc',
      true
    );
  END IF;
  RETURN NEW;
END $function$;

comment on function public.lc_rooms_after_update() is
  'Emits authoritative LC events on room state changes. The room_ended event is written AFTER the '
  'replay-buffer purge and is excluded from it (#764): it used to be deleted immediately after '
  'being written, so only the ephemeral broadcast reached anyone and a client that was offline at '
  'that instant never learned the class had ended.';

-- The reaper stops destroying decks.
--
-- It was deleting the room's objects out of the `live-classroom-decks` bucket inside an
-- `EXCEPTION WHEN OTHERS THEN NULL`, which is a silent delete of durable user content and directly
-- contradicts the app's own documented policy. endRoom says, in as many words: "deck images are
-- deliberately NOT deleted on room end, Class Insights is generated from this session's data, and
-- the student quiz review links back to slide images."
--
-- Worse, a deck uploaded in Live Classroom is promoted to course material (`lc_decks.module_item_id`
-- points at the module item), so the reaper was deleting the file behind a professor's shared module
-- material while leaving the row that references it.
--
-- Ending a session is a state change. Destroying durable assets is a separate lifecycle with its own
-- retention policy, and it does not belong in a 15-minute reaper.
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
     AND created_at < now() - interval '12 hours';

  UPDATE lc_rooms
     SET status = 'ended',
         ended_at = now()
   WHERE status = 'scheduled'
     AND scheduled_at IS NOT NULL
     AND scheduled_at < now() - interval '24 hours';
END $function$;

comment on function public.lc_auto_end_stale_rooms() is
  'Ends rooms left live for 12h or scheduled-but-unstarted for 24h. Called by the lc_rooms_auto_end '
  'pg_cron job every 15 minutes. Deliberately does NOT touch storage (#764): it used to delete the '
  'room deck objects inside a swallowed exception, which contradicted endRoom''s retention policy '
  'and destroyed files behind promoted module material.';
