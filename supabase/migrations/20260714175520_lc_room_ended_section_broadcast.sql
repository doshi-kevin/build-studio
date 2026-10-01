-- Fix: ending a class didn't clear the student SECTION hub.
--
-- Companion to the room_started section broadcast. When a live class ends,
-- lc_rooms_after_update broadcast room_ended only on the PER-ROOM topic
-- (lc_send_event → room:<id>), which notifies students already inside the
-- classroom. Students sitting on the SECTION hub (SectionRoomWatcher, topic
-- section:<id>:lc) never heard it and stayed stuck on "LIVE NOW / Join Class"
-- until a manual reload. Mirror the room_started fix: also broadcast room_ended
-- on the section topic so the hub swaps back to "Waiting" without a reload.
--
-- Body copied from the current prod definition (which already carries the
-- room_started scheduled→live branch) so nothing else is dropped. Only the
-- ended branch changes. No new RLS: migration 041 already grants enrolled
-- students READ on section:<id>:lc.

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
