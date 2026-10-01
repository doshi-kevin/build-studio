-- Live Classroom: Real-time transcription storage + deck extraction snapshot.
-- Adds lc_transcriptions table for per-slide speech transcription (ElevenLabs Scribe v2)
-- and deck_extraction JSONB column on lc_rooms for unified quiz generation context.

-- ── lc_transcriptions: per-slide transcript accumulation ─────────

CREATE TABLE lc_transcriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      uuid NOT NULL REFERENCES lc_rooms(id) ON DELETE CASCADE,
  page_number  int  NOT NULL CHECK (page_number >= 0),
  text         text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, page_number)
);

CREATE INDEX idx_lc_transcriptions_room
  ON lc_transcriptions (room_id);

-- ── RLS ──────────────────────────────────────────────────────────

ALTER TABLE lc_transcriptions ENABLE ROW LEVEL SECURITY;

-- Professor: full CRUD on own rooms
CREATE POLICY "prof manages transcriptions in own rooms"
  ON lc_transcriptions FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      WHERE r.id = lc_transcriptions.room_id
        AND r.prof_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      WHERE r.id = lc_transcriptions.room_id
        AND r.prof_id = auth.uid()
    )
  );

-- Students: read-only for rooms in enrolled sections (post-session review)
CREATE POLICY "students view transcriptions in enrolled rooms"
  ON lc_transcriptions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      JOIN enrollments e ON e.section_id = r.section_id
      WHERE r.id = lc_transcriptions.room_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled', 'completed')
    )
  );

-- ── Atomic append RPC ────────────────────────────────────────────
-- Called by the appendTranscription server action after verifying
-- room ownership. SECURITY DEFINER bypasses RLS (matches lc_send_event pattern).

CREATE OR REPLACE FUNCTION lc_append_transcription(
  p_room_id    uuid,
  p_page_number int,
  p_text       text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO lc_transcriptions (room_id, page_number, text, updated_at)
  VALUES (p_room_id, p_page_number, TRIM(p_text), now())
  ON CONFLICT (room_id, page_number)
  DO UPDATE SET
    text = CASE
      WHEN lc_transcriptions.text = '' THEN TRIM(EXCLUDED.text)
      ELSE lc_transcriptions.text || ' ' || TRIM(EXCLUDED.text)
    END,
    updated_at = now();
END;
$$;

-- Revoke public execute so only the service-role (admin client) can
-- call this function. The appendTranscription server action verifies
-- room ownership before invoking via adminDb.
REVOKE EXECUTE ON FUNCTION lc_append_transcription FROM public, authenticated, anon;

-- ── deck_extraction column on lc_rooms ───────────────────────────
-- Stores the full ExtractionResult JSONB so quiz generation has a
-- single source of truth regardless of how the deck was loaded.

ALTER TABLE lc_rooms ADD COLUMN deck_extraction jsonb;
