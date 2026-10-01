-- Student notetaker for the live classroom.
--
-- One freeform text document per (room, student): the student's private notes
-- typed during the session and editable afterward on the insights page. Not
-- slide-anchored, not AI — purely the student's own writing.
--
-- Security mirrors lc_attendance: students read only their own row; all writes
-- go through the saveNotes server action (service role, verifies enrollment
-- first), so there is no INSERT/UPDATE policy on purpose. The professor has no
-- read access — these notes are private to the student.

CREATE TABLE lc_notes (
  room_id    uuid NOT NULL REFERENCES lc_rooms(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, student_id)
);

ALTER TABLE lc_notes ENABLE ROW LEVEL SECURITY;

-- Students read only their own notes.
CREATE POLICY "students read own notes"
  ON lc_notes FOR SELECT TO authenticated
  USING (student_id = auth.uid());

-- Writes happen via the service role only (saveNotes verifies enrollment
-- server-side first) — no INSERT/UPDATE policies on purpose.
