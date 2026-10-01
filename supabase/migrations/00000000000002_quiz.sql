-- ============================================================
-- Quiz System Migration — Supabase-backed quiz persistence
-- ============================================================
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- Creates 5 tables:
--   1. quiz_questions     — question bank per section
--   2. quizzes            — quiz configuration per section
--   3. quiz_question_assignments — many-to-many: quiz ↔ questions
--   4. quiz_attempts      — one row per student attempt
--   5. quiz_answers       — one row per question per attempt
--
-- All tables use RLS disabled (admin client handles auth).
-- ============================================================

-- ── 1. quiz_questions ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS quiz_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  question_text text NOT NULL,
  question_type text NOT NULL CHECK (question_type IN ('multiple_choice','true_false','short_answer','fill_in_blank')),
  content jsonb NOT NULL,
  difficulty text NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  blooms_level text CHECK (blooms_level IN ('remember','understand','apply','analyze','evaluate','create')),
  tags text[] DEFAULT '{}',
  points integer NOT NULL DEFAULT 1 CHECK (points BETWEEN 1 AND 100),
  explanation text DEFAULT '',
  is_bonus boolean DEFAULT false,
  is_extra_credit boolean DEFAULT false,
  image_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE quiz_questions ENABLE ROW LEVEL SECURITY;

-- ── 2. quizzes ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES profiles(id),
  title text NOT NULL,
  description text DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  time_limit_minutes integer CHECK (time_limit_minutes IS NULL OR time_limit_minutes BETWEEN 1 AND 480),
  shuffle_questions boolean DEFAULT false,
  shuffle_answers boolean DEFAULT false,
  max_attempts integer DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 10),
  pass_threshold numeric DEFAULT 60 CHECK (pass_threshold BETWEEN 0 AND 100),
  due_date timestamptz,
  show_explanations text DEFAULT 'after_submission' CHECK (show_explanations IN ('after_submission','after_due_date','never')),
  show_leaderboard boolean DEFAULT false,
  allow_calculator boolean DEFAULT false,
  allow_formula_sheet boolean DEFAULT false,
  negative_marking boolean DEFAULT false,
  negative_marking_penalty numeric DEFAULT 0.25 CHECK (negative_marking_penalty BETWEEN 0 AND 1),
  question_pools jsonb DEFAULT '[]',
  difficulty_distribution jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;

-- ── 3. quiz_question_assignments ────────────────────────────
CREATE TABLE IF NOT EXISTS quiz_question_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  UNIQUE(quiz_id, question_id)
);

ALTER TABLE quiz_question_assignments ENABLE ROW LEVEL SECURITY;

-- ── 4. quiz_attempts ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES profiles(id),
  section_id uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  mode text DEFAULT 'graded' CHECK (mode IN ('graded','practice')),
  status text DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted')),
  resolved_question_ids uuid[] DEFAULT '{}',
  score numeric,
  total_points numeric,
  earned_points numeric,
  started_at timestamptz DEFAULT now(),
  submitted_at timestamptz,
  time_spent_seconds integer DEFAULT 0
);

ALTER TABLE quiz_attempts ENABLE ROW LEVEL SECURITY;

-- ── 5. quiz_answers ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quiz_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  selected_choice_ids text[],
  boolean_answer boolean,
  text_answer text,
  blank_answers jsonb,
  is_flagged boolean DEFAULT false,
  confidence text CHECK (confidence IS NULL OR confidence IN ('low','medium','high')),
  time_spent_seconds integer DEFAULT 0,
  is_correct boolean,
  earned_points numeric,
  UNIQUE(attempt_id, question_id)
);

ALTER TABLE quiz_answers ENABLE ROW LEVEL SECURITY;

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_quiz_questions_section ON quiz_questions(section_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_section ON quizzes(section_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_created_by ON quizzes(created_by);
CREATE INDEX IF NOT EXISTS idx_quiz_assignments_quiz ON quiz_question_assignments(quiz_id);
CREATE INDEX IF NOT EXISTS idx_quiz_assignments_question ON quiz_question_assignments(question_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz_student ON quiz_attempts(quiz_id, student_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_section ON quiz_attempts(section_id);
CREATE INDEX IF NOT EXISTS idx_quiz_answers_attempt ON quiz_answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_quiz_answers_question ON quiz_answers(question_id);

-- ── Formula Sheet Columns ─────────────────────────────────
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS formula_sheet_url text;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS formula_sheet_path text;
