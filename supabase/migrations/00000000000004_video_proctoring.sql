-- Video Proctoring Migration
-- Adds browser-based face detection support to the quiz proctoring system.
-- Face detection runs client-side via face-api.js (TensorFlow.js).
-- Snapshots are captured only on violations and stored in Supabase Storage.

-- 1. Add video proctoring toggle to quizzes (independent from keystroke proctoring)
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS video_proctoring_enabled boolean DEFAULT false;

-- 2. Create proctoring_snapshots table for violation snapshot metadata
CREATE TABLE IF NOT EXISTS proctoring_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id),
  quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  violation_type text NOT NULL,           -- 'mf' (multiple faces) | 'ph' (phone detected)
  storage_path text NOT NULL,             -- path in proctoring-snapshots bucket
  snapshot_url text NOT NULL,             -- public URL for display
  timestamp_offset integer NOT NULL,      -- ms offset from attempt start
  question_index integer,                 -- which question was active
  face_count integer DEFAULT 0,           -- number of faces detected (0 = no face, >1 = multiple)
  created_at timestamptz DEFAULT now()
);

-- 3. Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_proctoring_snapshots_attempt
  ON proctoring_snapshots(attempt_id);
CREATE INDEX IF NOT EXISTS idx_proctoring_snapshots_quiz_student
  ON proctoring_snapshots(quiz_id, student_id);

-- 4. Enable RLS
ALTER TABLE proctoring_snapshots ENABLE ROW LEVEL SECURITY;

-- 5. RLS policies — students can only insert and read their own snapshots
CREATE POLICY "Students can insert own proctoring snapshots"
  ON proctoring_snapshots FOR INSERT
  WITH CHECK (auth.uid() = student_id);

CREATE POLICY "Students can read own proctoring snapshots"
  ON proctoring_snapshots FOR SELECT
  USING (auth.uid() = student_id);
