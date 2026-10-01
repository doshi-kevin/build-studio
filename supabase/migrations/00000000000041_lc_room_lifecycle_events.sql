-- Hotfix: broadcast the two lifecycle transitions that previously only
-- propagated via postgres_changes (which we dropped in migration 35).
--
-- Symptoms before this migration:
--   1. Prof starts a new live class. Students already on the section's
--      Live Classroom landing page sit on "No active class right now"
--      forever — they only see the new room after a manual refresh.
--   2. Prof uploads a deck after students have joined the room URL.
--      Students see "Waiting for slides" forever — the snapshot they
--      fetched on join had deck_url=NULL and nothing tells them when
--      it gets set.
--
-- Fixes:
--   • New section-wide private topic `section:<uuid>:lc` carrying a
--     `room_started` event when an lc_rooms row is INSERTed. RLS lets
--     the section's enrolled students + its professor read it.
--   • The existing lc_rooms_after_update trigger now also emits a
--     `deck_ready` event on the per-room topic when deck_url
--     transitions NULL → set.

-- ── Trigger: room_started on INSERT ────────────────────────────────

CREATE OR REPLACE FUNCTION lc_rooms_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_payload jsonb;
BEGIN
  -- Section-wide broadcast so every enrolled student's landing page
  -- learns about the new room without polling. seq=null: the recipient
  -- doesn't replay these (they re-fetch the active-room query instead).
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
  RETURN NEW;
END $$;

CREATE TRIGGER trg_lc_rooms_after_insert
  AFTER INSERT ON lc_rooms
  FOR EACH ROW EXECUTE FUNCTION lc_rooms_after_insert();

-- ── Trigger: deck_ready on UPDATE (extend existing) ────────────────

CREATE OR REPLACE FUNCTION lc_rooms_after_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.current_slide IS DISTINCT FROM OLD.current_slide THEN
    PERFORM lc_send_event(NEW.id, 'slide_changed',
      jsonb_build_object('slideIndex', NEW.current_slide));
  END IF;

  -- New: tell joined clients the deck just landed (transition NULL → set).
  IF NEW.deck_url IS NOT NULL AND OLD.deck_url IS NULL THEN
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

-- ── RLS: allow enrolled students + the section's professor to read
--        the section-wide LC topic ───────────────────────────────────

CREATE POLICY "lc section read access" ON realtime.messages FOR SELECT TO authenticated
  USING (
    realtime.topic() ~ '^section:[0-9a-f-]{36}:lc$'
    AND (
      EXISTS (
        SELECT 1 FROM enrollments e
        WHERE e.section_id = (regexp_match(realtime.topic(), '^section:([0-9a-f-]{36}):lc$'))[1]::uuid
          AND e.student_id = auth.uid()
          AND e.status IN ('enrolled', 'completed')
      )
      OR EXISTS (
        SELECT 1 FROM course_sections cs
        WHERE cs.id = (regexp_match(realtime.topic(), '^section:([0-9a-f-]{36}):lc$'))[1]::uuid
          AND cs.professor_id = auth.uid()
      )
    )
  );

-- No INSERT policy on section:%:lc — only triggers (SECURITY DEFINER) write here.
