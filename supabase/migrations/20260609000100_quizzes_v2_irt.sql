-- ============================================================
-- Quizzes v2 — CCAT / IRT engine (ENG-38)
-- ============================================================
-- Replaces the heuristic Elo adaptive quiz with a psychometric (IRT) engine.
-- See docs/designs/quizzes/ccat-system-design.md.
--
-- Adds, all with safe DEFAULTs so existing quizzes keep working:
--   - IRT item parameters (a, b, c) and a grading rubric on quiz_questions
--   - Two new first-class question types: 'explanation' and 'walkthrough'
--     (relaxes the question_type CHECK from 4 → 6 values)
--   - Ability estimate (theta, se) + stop reason + selection lambda config
--   - Per-response IRT trace (soft score g, theta before/after, grader nodes)
--   - New table: student_ability (per student per section: theta, se)
--
-- The legacy Elo columns from migration 5 (elo_rating, current_rating, …) are
-- left in place but unused; src/lib/quiz/adaptive-engine.ts is retired.
--
-- RLS: student_ability mirrors student_ratings (migration 5) — students read
-- their own row, professors read rows for their sections; writes go through the
-- service-role admin client in server actions.
-- ============================================================

-- ── 1. IRT parameters + rubric + two new question types ───────

ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS irt_a numeric;             -- discrimination
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS irt_b numeric;             -- difficulty (latent scale)
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS irt_c numeric;             -- guessing (derived from type)
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS rubric jsonb;              -- [{concept, match?}] for explanation/walkthrough
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS calibrated_at timestamptz; -- null until phase-2 batch calibration

-- Relax the question_type CHECK to add the two AI-graded constructed-response
-- types. The original four keep working unchanged. (Constraint name matches the
-- default Postgres naming from migration 2's inline CHECK.)
ALTER TABLE quiz_questions DROP CONSTRAINT IF EXISTS quiz_questions_question_type_check;
ALTER TABLE quiz_questions ADD CONSTRAINT quiz_questions_question_type_check
  CHECK (question_type IN
    ('multiple_choice','true_false','short_answer','fill_in_blank','explanation','walkthrough'));

-- ── 2. Adaptive config on quizzes ─────────────────────────────

-- Difficulty-matching strength for selection score = info · exp(−λ(b−θ̂)²).
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS select_lambda numeric DEFAULT 0.5
  CHECK (select_lambda BETWEEN 0 AND 2);
-- Stopping rule: fixed length (adaptive_question_count) or precision (SE < target_se).
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS stop_mode text DEFAULT 'fixed'
  CHECK (stop_mode IN ('fixed','precision'));
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS target_se numeric DEFAULT 0.30
  CHECK (target_se > 0 AND target_se <= 2);

-- ── 3. Ability estimate + stop reason on quiz_attempts ────────

ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS theta numeric;       -- θ̂ (EAP)
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS se numeric;          -- SE(θ̂)
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS stop_reason text
  CHECK (stop_reason IS NULL OR stop_reason IN ('length','se','max'));

-- ── 4. Per-response IRT trace on quiz_answers ─────────────────

ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS soft_score numeric;       -- g ∈ [0,1]
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS theta_before numeric;
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS theta_after numeric;
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS se_after numeric;
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS grader_mode text;        -- exact | gemini | keyword | walkthrough
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS nodes jsonb;            -- per-rubric verdicts + rationale
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS misconception_node text;
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS is_formative boolean DEFAULT false; -- formative (e.g. retry), excluded from θ

-- ── 5. New table: student_ability ─────────────────────────────
-- Per-student per-section latent ability, carried across adaptive attempts.

CREATE TABLE IF NOT EXISTS student_ability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  theta numeric NOT NULL DEFAULT 0,
  se numeric NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(student_id, section_id)
);

ALTER TABLE student_ability ENABLE ROW LEVEL SECURITY;

-- ── 6. Indexes ────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_student_ability_section ON student_ability(section_id);
CREATE INDEX IF NOT EXISTS idx_student_ability_student ON student_ability(student_id);

-- ── 7. RLS policies (mirror student_ratings, migration 5) ─────

-- Students read their own ability row.
DROP POLICY IF EXISTS "Students can view own ability" ON student_ability;
CREATE POLICY "Students can view own ability"
  ON student_ability FOR SELECT
  USING (auth.uid() = student_id);

-- Professors read ability rows for sections they teach.
DROP POLICY IF EXISTS "Professors can view section ability" ON student_ability;
CREATE POLICY "Professors can view section ability"
  ON student_ability FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM course_sections cs
      WHERE cs.id = student_ability.section_id
        AND cs.professor_id = auth.uid()
    )
  );

-- ── 8. RPC: upsert ability atomically after an attempt ────────
-- Mirrors increment_student_quizzes_taken: avoids races on concurrent upserts.
-- service_role only (called via the admin client in server actions).

CREATE OR REPLACE FUNCTION upsert_student_ability(
  p_student_id uuid,
  p_section_id uuid,
  p_theta numeric,
  p_se numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO student_ability (student_id, section_id, theta, se, attempts, updated_at)
  VALUES (p_student_id, p_section_id, p_theta, p_se, 1, now())
  ON CONFLICT (student_id, section_id)
  DO UPDATE SET
    theta = p_theta,
    se = p_se,
    attempts = student_ability.attempts + 1,
    updated_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION upsert_student_ability FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION upsert_student_ability TO service_role;

-- ── 9. Backfill IRT parameters for existing questions ─────────
-- Seed a/b/c from difficulty + question_type so any pre-v2 question can be
-- served by the IRT engine immediately (uncalibrated).

UPDATE quiz_questions SET irt_b =
  CASE difficulty
    WHEN 'easy' THEN -1.0
    WHEN 'medium' THEN 0.0
    WHEN 'hard' THEN 1.0
    ELSE 0.0
  END
WHERE irt_b IS NULL;

UPDATE quiz_questions SET irt_a = 1.2 WHERE irt_a IS NULL;

UPDATE quiz_questions SET irt_c =
  CASE question_type
    WHEN 'true_false' THEN 0.5
    WHEN 'multiple_choice' THEN 0.25
    ELSE 0.0
  END
WHERE irt_c IS NULL;
