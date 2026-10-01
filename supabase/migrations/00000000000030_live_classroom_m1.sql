-- Live Classroom M1 Migration — PDF Sync
-- Creates lc_rooms table for real-time slide synchronization.
-- Only lc_rooms ships in M1; lc_interactions and lc_responses are M2/M3.

-- ── lc_rooms: core "live classroom session" entity ────────────────

CREATE TABLE lc_rooms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id      uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  prof_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('live','ended')) DEFAULT 'live',
  deck_url        text,                      -- Storage prefix, e.g., live-classroom-decks/{roomId}
  deck_page_count int,
  current_slide   int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);

-- Index for finding live rooms in a section
CREATE INDEX idx_lc_rooms_section_status
  ON lc_rooms (section_id, status)
  WHERE status = 'live';

-- Index for finding a professor's live rooms
CREATE INDEX idx_lc_rooms_prof_status
  ON lc_rooms (prof_id, status);

-- ── RLS Policies ──────────────────────────────────────────────────

ALTER TABLE lc_rooms ENABLE ROW LEVEL SECURITY;

-- Professors: full control over rooms they created
CREATE POLICY "prof manages own rooms"
  ON lc_rooms FOR ALL TO authenticated
  USING (prof_id = auth.uid())
  WITH CHECK (prof_id = auth.uid());

-- Students: SELECT only rooms for sections they're enrolled in.
-- Scholera convention: active enrollment = status IN ('enrolled', 'completed').
CREATE POLICY "students view rooms in enrolled sections"
  ON lc_rooms FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.student_id = auth.uid()
        AND e.section_id = lc_rooms.section_id
        AND e.status IN ('enrolled', 'completed')
    )
  );

-- ── Enable Realtime ───────────────────────────────────────────────

ALTER PUBLICATION supabase_realtime ADD TABLE lc_rooms;

-- ── Storage Bucket: live-classroom-decks ──────────────────────────
-- Public read for MVP (ephemeral slide images); professor writes via admin client.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'live-classroom-decks',
  'live-classroom-decks',
  true,
  52428800,  -- 50 MB
  ARRAY['image/webp', 'image/png', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Anyone can read (public bucket)
DROP POLICY IF EXISTS "Public read live-classroom-decks" ON storage.objects;
CREATE POLICY "Public read live-classroom-decks"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'live-classroom-decks');

-- Professors upload via admin client (RLS bypassed), but add a policy for direct uploads if needed
DROP POLICY IF EXISTS "Professors upload to live-classroom-decks" ON storage.objects;
CREATE POLICY "Professors upload to live-classroom-decks"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'live-classroom-decks'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'professor'
    )
  );

-- Professors can delete their own uploads
DROP POLICY IF EXISTS "Professors delete from live-classroom-decks" ON storage.objects;
CREATE POLICY "Professors delete from live-classroom-decks"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'live-classroom-decks'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'professor'
    )
  );
