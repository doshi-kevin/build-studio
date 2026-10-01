-- Migration: Quiz Proctoring
-- Adds proctoring support to the quiz system: per-quiz toggle, event logging table,
-- and summary column on attempts for fast professor-side reads.

-- ── 1. Add proctoring toggle to quizzes ─────────────────────────
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS proctoring_enabled boolean DEFAULT false;

-- ── 2. Add proctoring summary to attempts (computed at submission) ──
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS proctoring_summary jsonb;

-- ── 3. Create batched proctoring event logs table ───────────────
CREATE TABLE IF NOT EXISTS quiz_proctoring_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id),
  quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  batch_index integer NOT NULL DEFAULT 0,
  events jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz DEFAULT now()
);

-- ── 4. Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_proctoring_logs_attempt ON quiz_proctoring_logs(attempt_id);
CREATE INDEX IF NOT EXISTS idx_proctoring_logs_quiz_student ON quiz_proctoring_logs(quiz_id, student_id);

-- ── 5. Row Level Security ───────────────────────────────────────
ALTER TABLE quiz_proctoring_logs ENABLE ROW LEVEL SECURITY;

-- Students can insert their own proctoring logs
CREATE POLICY "Students can insert own proctoring logs"
  ON quiz_proctoring_logs FOR INSERT
  WITH CHECK (auth.uid() = student_id);

-- Students can read their own proctoring logs
CREATE POLICY "Students can read own proctoring logs"
  ON quiz_proctoring_logs FOR SELECT
  USING (auth.uid() = student_id);
