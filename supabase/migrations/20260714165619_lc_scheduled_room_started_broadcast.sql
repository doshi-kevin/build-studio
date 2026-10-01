-- Fix: a SCHEDULED session going live didn't notify the student section hub.
--
-- room_started (which the student hub's SectionRoomWatcher listens for to auto-
-- swap to "LIVE NOW" without a reload) was only broadcast by lc_rooms_after_insert.
-- Start-now rooms are INSERTed already 'live', so they announce on insert.
-- Scheduled rooms are INSERTed 'scheduled' and only UPDATEd to 'live' at start —
-- and the AFTER UPDATE trigger never emitted room_started. So a student waiting
-- on the hub for a scheduled class never saw it start (needed a manual reload).
--
-- Two changes (bodies copied from the current prod definitions, so nothing else
-- these functions do is lost):
--   1. INSERT trigger: only announce room_started when the new row is already
--      'live' (start-now). This also drops the premature, no-op room_started that
--      previously fired at schedule time (student refresh that found no live room).
--   2. UPDATE trigger: announce room_started on the scheduled→live transition,
--      mirroring the insert path. The realtime.send is transaction-bound, so it
--      only reaches clients after the commit that also set status='live' + the
--      deck_url — the student's router.refresh() is guaranteed to see the live room.

CREATE OR REPLACE FUNCTION public.lc_rooms_after_insert()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE v_payload jsonb;
BEGIN
  -- Only a room born 'live' (start-now) announces itself on INSERT. A scheduled
  -- room stays quiet until it transitions to 'live' (handled on UPDATE below).
  IF NEW.status = 'live' THEN
    v_payload := jsonb_build_object(
      'seq', NULL,
      'ts', now(),
      'type', 'room_started',
      'data', jsonb_build_object(
        'roomId', NEW.id,
        'sectionId', NEW.section_id,
        'profId', NEW.prof_id,
        'createdAt', NEW.created_at
      )
    );
    PERFORM realtime.send(
      v_payload,
      'room_started',
      'section:' || NEW.section_id || ':lc',
      true
    );
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.lc_rooms_after_update()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
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

  -- A scheduled room going live is an UPDATE, not an INSERT — announce it on the
  -- section topic here (same payload as lc_rooms_after_insert) so students
  -- waiting on the section hub see it go LIVE without a manual reload.
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
    PERFORM lc_send_event(NEW.id, 'room_ended', jsonb_build_object());
    DELETE FROM lc_events WHERE room_id = NEW.id;
  END IF;
  RETURN NEW;
END $function$;
