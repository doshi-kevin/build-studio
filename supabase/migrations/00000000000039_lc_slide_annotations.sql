-- Phase 4 follow-up: permanent per-slide annotation storage.
--
-- Replaces the 60-second `drawing_stroke_batch` buffer in lc_events with a
-- proper table that persists for the room's lifetime. Live broadcasts on
-- the ephemeral topic still carry strokes sub-100ms; this table is what
-- makes them survive across reloads, late joiners after the buffer
-- window, and post-class review (when we add it).
--
-- One row per stroke. Author tracked separately so we can render different
-- colors per author later (and audit "who drew that").

CREATE TABLE lc_slide_annotations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      uuid NOT NULL REFERENCES lc_rooms(id) ON DELETE CASCADE,
  slide_index  int NOT NULL,
  -- Full Stroke object as JSON: { id, slideIndex, points[], color, width, authorId }
  stroke       jsonb NOT NULL,
  author_id    uuid NOT NULL REFERENCES profiles(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Hot path: load all strokes for a given slide of a room, in insertion order.
CREATE INDEX idx_lc_slide_annotations_room_slide
  ON lc_slide_annotations (room_id, slide_index, created_at);

-- Lookup all strokes for a room (snapshot bulk fetch).
CREATE INDEX idx_lc_slide_annotations_room_created
  ON lc_slide_annotations (room_id, created_at);

-- ── RLS ─────────────────────────────────────────────────────────────

ALTER TABLE lc_slide_annotations ENABLE ROW LEVEL SECURITY;

-- Professor manages everything in their own rooms.
CREATE POLICY "prof manages annotations in own rooms"
  ON lc_slide_annotations FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      WHERE r.id = lc_slide_annotations.room_id
        AND r.prof_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      WHERE r.id = lc_slide_annotations.room_id
        AND r.prof_id = auth.uid()
    )
  );

-- Enrolled students can READ all annotations in their rooms (so they see
-- what the prof drew).
CREATE POLICY "students read annotations in enrolled rooms"
  ON lc_slide_annotations FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      JOIN enrollments e ON e.section_id = r.section_id
      WHERE r.id = lc_slide_annotations.room_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled','completed')
    )
  );

-- Enrolled students can INSERT their OWN annotations (forward-compat for
-- "students draw too" — feature not enabled today, but the policy is in
-- place so we don't have to migrate later).
CREATE POLICY "students insert own annotations"
  ON lc_slide_annotations FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM lc_rooms r
      JOIN enrollments e ON e.section_id = r.section_id
      WHERE r.id = lc_slide_annotations.room_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled','completed')
    )
  );
