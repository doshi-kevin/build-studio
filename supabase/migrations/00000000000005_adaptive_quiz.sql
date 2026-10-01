-- ============================================================
-- Adaptive Quiz Migration — Adds SkillSignal-AI adaptive quiz
-- capabilities on top of Scholera's existing quiz system.
-- ============================================================
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- Adds:
--   - Adaptive columns to quizzes, quiz_questions, quiz_attempts, quiz_answers
--   - New table: student_ratings (persistent Elo per student per section)
--   - New table: cohort_assignments (adaptive/control cohort per student)
--   - Backfill existing questions with Elo ratings and expected times
--
-- All new columns have DEFAULT values — existing quizzes are unaffected.
-- ============================================================

-- ── 1. New columns on quizzes ─────────────────────────────────

-- Adaptive mode toggle (opt-in, default OFF for backward compat)
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS adaptive_mode boolean DEFAULT false;

-- Cohort split percentage (what % goes to adaptive group, rest is control)
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS adaptive_ratio integer DEFAULT 60
  CHECK (adaptive_ratio BETWEEN 0 AND 100);

-- Number of questions served per adaptive attempt (default 10, like SkillSignal)
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS adaptive_question_count integer DEFAULT 10
  CHECK (adaptive_question_count BETWEEN 1 AND 100);

-- Fixed distribution for control group (e.g., 3 easy, 3 medium, 4 hard)
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS control_distribution jsonb
  DEFAULT '{"easy": 3, "medium": 3, "hard": 4}';

-- Whether students see their Elo rating change on the results page
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS show_rating_to_students boolean DEFAULT false;

-- ── 2. New columns on quiz_questions ──────────────────────────

-- Numerical Elo rating for adaptive difficulty matching (800-2400 range)
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS elo_rating integer DEFAULT 1200;

-- Expected time in seconds (used for behavioral penalty calculation)
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS expected_time_seconds integer;

-- ── 3. New columns on quiz_attempts ───────────────────────────

-- Cohort assignment for this attempt
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS cohort text
  CHECK (cohort IS NULL OR cohort IN ('adaptive', 'control'));

-- Elo rating tracking per attempt
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS start_rating integer DEFAULT 1200;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS current_rating integer DEFAULT 1200;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS final_rating integer;

-- Tracks how many adaptive questions have been answered (for resume)
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS adaptive_question_index integer DEFAULT 0;

-- ── 4. New columns on quiz_answers ────────────────────────────

-- Per-question behavioral signals (for Elo penalty calculation)
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS option_changes integer DEFAULT 0;
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS tab_switches integer DEFAULT 0;
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS copy_attempts integer DEFAULT 0;

-- ── 5. New table: student_ratings ─────────────────────────────
-- Persistent per-student per-section Elo rating that carries across quizzes

CREATE TABLE IF NOT EXISTS student_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  rating integer NOT NULL DEFAULT 1200,
  quizzes_taken integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(student_id, section_id)
);

ALTER TABLE student_ratings ENABLE ROW LEVEL SECURITY;

-- ── 6. New table: cohort_assignments ──────────────────────────
-- Stable per-student per-section cohort with professor override support

CREATE TABLE IF NOT EXISTS cohort_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  cohort text NOT NULL CHECK (cohort IN ('adaptive', 'control')),
  assigned_by text NOT NULL DEFAULT 'auto' CHECK (assigned_by IN ('auto', 'professor')),
  assigned_at timestamptz DEFAULT now(),
  UNIQUE(student_id, section_id)
);

ALTER TABLE cohort_assignments ENABLE ROW LEVEL SECURITY;

-- ── 7. Indexes ────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_student_ratings_section ON student_ratings(section_id);
CREATE INDEX IF NOT EXISTS idx_student_ratings_student ON student_ratings(student_id);
CREATE INDEX IF NOT EXISTS idx_cohort_assignments_section ON cohort_assignments(section_id);
CREATE INDEX IF NOT EXISTS idx_cohort_assignments_student ON cohort_assignments(student_id);

-- Index for adaptive quiz queries (filter by adaptive_mode)
CREATE INDEX IF NOT EXISTS idx_quizzes_adaptive ON quizzes(adaptive_mode) WHERE adaptive_mode = true;

-- Index for cohort-based attempt queries
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_cohort ON quiz_attempts(cohort) WHERE cohort IS NOT NULL;

-- ── 8. RLS Policies ─────────────────────────────────────────

-- Students can read their own ratings
CREATE POLICY "Students can view own ratings"
  ON student_ratings FOR SELECT
  USING (auth.uid() = student_id);

-- Students can read their own cohort assignment
CREATE POLICY "Students can view own cohort"
  ON cohort_assignments FOR SELECT
  USING (auth.uid() = student_id);

-- Professors can view ratings for their sections
CREATE POLICY "Professors can view section ratings"
  ON student_ratings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM course_sections cs
      WHERE cs.id = student_ratings.section_id
        AND cs.professor_id = auth.uid()
    )
  );

-- Professors can view cohort assignments for their sections
CREATE POLICY "Professors can view section cohorts"
  ON cohort_assignments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM course_sections cs
      WHERE cs.id = cohort_assignments.section_id
        AND cs.professor_id = auth.uid()
    )
  );

-- ── 9. RPC: Increment quizzes_taken atomically ─────────────────
-- Used after a student completes an adaptive quiz to safely increment
-- the counter without race conditions from concurrent upserts.

CREATE OR REPLACE FUNCTION increment_student_quizzes_taken(
  p_student_id uuid,
  p_section_id uuid,
  p_new_rating integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO student_ratings (student_id, section_id, rating, quizzes_taken, updated_at)
  VALUES (p_student_id, p_section_id, p_new_rating, 1, now())
  ON CONFLICT (student_id, section_id)
  DO UPDATE SET
    rating = p_new_rating,
    quizzes_taken = student_ratings.quizzes_taken + 1,
    updated_at = now();
END;
$$;

-- Restrict RPC execution to service_role only (called via admin client in server actions).
-- Prevents authenticated users from calling supabase.rpc() directly to manipulate ratings.
REVOKE EXECUTE ON FUNCTION increment_student_quizzes_taken FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_student_quizzes_taken TO service_role;

-- ── 10. Backfill existing questions with Elo ratings ──────────
-- Sets elo_rating and expected_time_seconds based on existing difficulty labels

UPDATE quiz_questions SET expected_time_seconds =
  CASE difficulty
    WHEN 'easy' THEN 30
    WHEN 'medium' THEN 45
    WHEN 'hard' THEN 60
  END
WHERE expected_time_seconds IS NULL;

UPDATE quiz_questions SET elo_rating =
  CASE difficulty
    WHEN 'easy' THEN 800
    WHEN 'medium' THEN 1200
    WHEN 'hard' THEN 1600
  END
WHERE elo_rating = 1200 AND difficulty != 'medium';
