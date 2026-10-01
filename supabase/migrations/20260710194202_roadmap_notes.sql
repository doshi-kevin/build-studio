-- Roadmap notes: sticky notes pinned under a module on the roadmap canvas.
-- Students write PRIVATE notes (only they can read them). Professors write
-- notes that are private by default and can be shared with the whole section
-- via visible_to_students.
--
-- All writes go through server actions (admin client), so client-facing RLS is
-- deliberately SELECT-only — a FOR ALL/INSERT/UPDATE policy here would let a
-- browser rewrite arbitrary columns (visible_to_students, section_id, …) via
-- PostgREST, bypassing the server-side checks.

CREATE TABLE roadmap_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  section_id UUID NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL CHECK (author_role IN ('professor', 'student')),
  -- Roadmap node key the note is pinned under (e.g. 'module:<uuid>').
  module_key TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  -- Professor notes only: share with every student in the section.
  visible_to_students BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_roadmap_notes_section ON roadmap_notes(section_id);
CREATE INDEX idx_roadmap_notes_author ON roadmap_notes(author_id);
CREATE INDEX idx_roadmap_notes_institution ON roadmap_notes(institution_id);

ALTER TABLE roadmap_notes ENABLE ROW LEVEL SECURITY;

-- Authors can read their own notes.
CREATE POLICY "Authors read own roadmap notes"
  ON roadmap_notes FOR SELECT
  USING ((SELECT auth.uid()) = author_id);

-- Enrolled students can read professor notes shared with their section.
CREATE POLICY "Students read shared professor roadmap notes"
  ON roadmap_notes FOR SELECT
  USING (
    author_role = 'professor'
    AND visible_to_students
    AND EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.section_id = roadmap_notes.section_id
        AND e.student_id = (SELECT auth.uid())
        AND e.status IN ('enrolled', 'completed', 'active')
    )
  );

-- No INSERT/UPDATE/DELETE policies on purpose: mutations are server-action-only
-- (admin client). Student notes are never readable by the professor (private
-- journal by design).
