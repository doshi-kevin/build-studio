-- Migration: Add late submission tracking to quiz_attempts
-- Adds is_late flag and late_by_seconds for due date enforcement.

ALTER TABLE quiz_attempts
  ADD COLUMN IF NOT EXISTS is_late boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS late_by_seconds integer NOT NULL DEFAULT 0;

-- Index for filtering late submissions in gradebook queries
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_is_late
  ON quiz_attempts (quiz_id, is_late) WHERE is_late = true;

COMMENT ON COLUMN quiz_attempts.is_late IS 'True if the attempt was submitted after the quiz due date (with grace period)';
COMMENT ON COLUMN quiz_attempts.late_by_seconds IS 'Number of seconds past the due date the attempt was submitted (0 if on time)';
