-- Blank screen for the Live Classroom projector (presenter-remote support).
--
-- The professor can blank the broadcasting screen (Projector View) mid-class —
-- e.g. via the "." key a Logitech presenter remote sends. Blank affects ONLY
-- the projector: students keep their normal view and the professor keeps
-- theirs (with a "blanked" banner).
--
-- lc_rooms.is_blanked is live room state (like current_slide), not config:
-- new rooms always start unblanked. The setScreenBlank server action updates
-- it after the same ownership checks as advanceSlide; this trigger clause
-- broadcasts screen_blank_changed on the per-room topic. Persisted via
-- lc_send_event (default) so a projector that reconnects mid-blank catches up
-- through replay; fresh opens read the column off the room snapshot.
--
-- Function body copied from 20260714175520 (the current prod definition) —
-- only the is_blanked clause is new. No RLS change: the column rides
-- lc_rooms' existing policies and is not sensitive.

ALTER TABLE lc_rooms ADD COLUMN is_blanked boolean NOT NULL DEFAULT false;

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
    DELETE FROM lc_events WHERE room_id = NEW.id;
  END IF;
  RETURN NEW;
END $function$;
