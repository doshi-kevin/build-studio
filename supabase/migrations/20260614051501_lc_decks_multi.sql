-- Live Classroom #8 — multi-deck per room with resume + per-deck progress.
-- See docs/designs/live-classroom/live-classroom-multi-deck.md.
--
-- Today a room holds ONE deck via lc_rooms columns, and per-slide data
-- (lc_transcriptions, lc_slide_annotations) is keyed by ROOM, so switching
-- files corrupts progress. This migration:
--   1. Adds lc_decks (source of truth per deck).
--   2. Adds lc_rooms.active_deck_id; lc_rooms keeps its scalar deck columns
--      as a live MIRROR of the active deck (deck_url/deck_page_count/
--      current_slide) so the realtime triggers + snapshot path are unchanged.
--   3. Moves deck_extraction off lc_rooms onto lc_decks (large JSONB, no
--      realtime trigger — mirroring it would bloat the WAL on every switch).
--   4. Binds per-slide data to a deck via deck_id, re-keying transcriptions
--      to (deck_id, page_number) so two decks' page 1 never collide.
--   5. Mirrors native slide advances back to the active deck (for resume).
--
-- Tenant scoping: lc_* carries no institution_id; isolation flows through
-- room_id -> lc_rooms -> (prof_id | section enrollments), matching every
-- existing lc_ policy.

-- ── 1. lc_decks ──────────────────────────────────────────────────────

CREATE TABLE lc_decks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id          uuid NOT NULL REFERENCES lc_rooms(id) ON DELETE CASCADE,
  position         int  NOT NULL,             -- 1,2,3… order added (switcher list)
  title            text,                      -- filename / module title
  deck_url         text,                      -- versioned render path; null until rendered
  page_count       int,
  current_slide    int  NOT NULL DEFAULT 0,   -- per-deck resume position
  extraction       jsonb,                     -- per-deck slide text (moved off lc_rooms)
  module_item_id   uuid REFERENCES module_items(id) ON DELETE SET NULL,
  source_file_path text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_lc_decks_room ON lc_decks (room_id, position);

ALTER TABLE lc_decks ENABLE ROW LEVEL SECURITY;

-- Mirrors the lc_interactions policy shape (migration 36).
CREATE POLICY "prof manages decks in own rooms"
  ON lc_decks FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM lc_rooms r WHERE r.id = lc_decks.room_id AND r.prof_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM lc_rooms r WHERE r.id = lc_decks.room_id AND r.prof_id = auth.uid()));

CREATE POLICY "students read decks in enrolled rooms"
  ON lc_decks FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      JOIN enrollments e ON e.section_id = r.section_id
      WHERE r.id = lc_decks.room_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled','completed')
    )
  );

-- ── 2. active_deck_id mirror pointer ─────────────────────────────────

ALTER TABLE lc_rooms ADD COLUMN active_deck_id uuid REFERENCES lc_decks(id) ON DELETE SET NULL;

-- ── 3. deck_id on per-slide tables ───────────────────────────────────

ALTER TABLE lc_transcriptions   ADD COLUMN deck_id uuid REFERENCES lc_decks(id) ON DELETE CASCADE;
ALTER TABLE lc_slide_annotations ADD COLUMN deck_id uuid REFERENCES lc_decks(id) ON DELETE CASCADE;

-- ── 4. Backfill: one deck per existing room, bind its per-slide data ──

INSERT INTO lc_decks (room_id, position, title, deck_url, page_count, current_slide, extraction, module_item_id, source_file_path, created_at)
  SELECT id, 1, 'Deck 1', deck_url, deck_page_count, current_slide, deck_extraction, module_item_id, source_file_path, created_at
  FROM lc_rooms
  WHERE deck_url IS NOT NULL;

UPDATE lc_rooms r
  SET active_deck_id = d.id
  FROM lc_decks d
  WHERE d.room_id = r.id AND d.position = 1;

UPDATE lc_transcriptions t
  SET deck_id = r.active_deck_id
  FROM lc_rooms r
  WHERE t.room_id = r.id;

UPDATE lc_slide_annotations a
  SET deck_id = r.active_deck_id
  FROM lc_rooms r
  WHERE a.room_id = r.id;

-- Orphan cleanup: per-slide rows whose room never had a backfillable deck
-- (e.g. deck cleared) are left null. Drop them, then require deck_id so the
-- new model can't carry null per-slide rows into the report/snapshot.
DELETE FROM lc_transcriptions   WHERE deck_id IS NULL;
DELETE FROM lc_slide_annotations WHERE deck_id IS NULL;
ALTER TABLE lc_transcriptions   ALTER COLUMN deck_id SET NOT NULL;
ALTER TABLE lc_slide_annotations ALTER COLUMN deck_id SET NOT NULL;

-- Re-key transcriptions: was UNIQUE(room_id, page_number) -> now per deck.
ALTER TABLE lc_transcriptions DROP CONSTRAINT lc_transcriptions_room_id_page_number_key;
ALTER TABLE lc_transcriptions ADD CONSTRAINT lc_transcriptions_deck_page_key UNIQUE (deck_id, page_number);

CREATE INDEX idx_lc_slide_annotations_deck_slide
  ON lc_slide_annotations (deck_id, slide_index, created_at);

-- ── 5. deck_extraction moves to lc_decks; drop from lc_rooms ─────────

ALTER TABLE lc_rooms DROP COLUMN deck_extraction;

-- ── 6. Atomic append RPC — now deck-scoped ──────────────────────────
-- Replaces the (room_id, page_number) signature. room_id is still stored
-- (kept NOT NULL for the room-scoped RLS policy) but the conflict key is
-- the deck. Drop the old overload so only the deck-scoped one exists.

DROP FUNCTION IF EXISTS lc_append_transcription(uuid, int, text);

CREATE FUNCTION lc_append_transcription(
  p_room_id     uuid,
  p_deck_id     uuid,
  p_page_number int,
  p_text        text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO lc_transcriptions (room_id, deck_id, page_number, text, updated_at)
  VALUES (p_room_id, p_deck_id, p_page_number, TRIM(p_text), now())
  ON CONFLICT (deck_id, page_number)
  DO UPDATE SET
    text = CASE
      WHEN lc_transcriptions.text = '' THEN TRIM(EXCLUDED.text)
      ELSE lc_transcriptions.text || ' ' || TRIM(EXCLUDED.text)
    END,
    updated_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION lc_append_transcription(uuid, uuid, int, text) FROM public, authenticated, anon;

-- ── 7. Mirror native slide advances back to the active deck ─────────
-- advanceSlide still writes lc_rooms.current_slide (fires slide_changed).
-- This keeps the active deck's resume position in sync WITHOUT touching that
-- action. Guard on active_deck_id UNCHANGED so a deck SWITCH (which sets
-- current_slide to the new deck's resume value) doesn't redundantly write it
-- back — only native advances mirror.

CREATE OR REPLACE FUNCTION lc_mirror_current_slide()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.current_slide IS DISTINCT FROM OLD.current_slide
     AND NEW.active_deck_id IS NOT DISTINCT FROM OLD.active_deck_id
     AND NEW.active_deck_id IS NOT NULL THEN
    UPDATE lc_decks SET current_slide = NEW.current_slide WHERE id = NEW.active_deck_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER lc_rooms_mirror_slide
  AFTER UPDATE ON lc_rooms
  FOR EACH ROW EXECUTE FUNCTION lc_mirror_current_slide();
