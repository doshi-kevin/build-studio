-- Migration: Add timer enforcement tracking to quiz_attempts
-- Tracks when a timed quiz submission exceeded the time limit.

ALTER TABLE quiz_attempts
  ADD COLUMN IF NOT EXISTS time_limit_exceeded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overtime_seconds integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN quiz_attempts.time_limit_exceeded IS 'True if the attempt was submitted after the time limit expired (with grace period)';
COMMENT ON COLUMN quiz_attempts.overtime_seconds IS 'Number of seconds past the time limit the attempt was submitted (0 if on time)';
