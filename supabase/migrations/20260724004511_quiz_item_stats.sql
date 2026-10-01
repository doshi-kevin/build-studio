-- quiz_item_stats — cached empirical item-analysis for standard quizzes, used by
-- the roadmap triage engine's "Q5 discriminates poorly" (P6) signal. One row per
-- (quiz, question): discrimination is the point-biserial correlation between
-- getting that item right and the attempt's total score, so it is specific to the
-- quiz's population (a shared question in two quizzes gets two rows). This is the
-- EMPIRICAL discrimination, distinct from the AI-authored latent quiz_questions.irt_a.
--
-- Refreshed lazily (compute-on-read with a TTL) from quiz_attempts + quiz_answers;
-- staleness of a few hours is fine for analytics, so no worker/cron is warranted.
--
-- RLS: enabled with NO policies — DELIBERATE, matching the quiz-domain convention.
-- quizzes / quiz_questions / quiz_attempts / quiz_answers are all RLS-enabled
-- deny-all (00000000000002_quiz.sql:13, "admin client handles auth"): every read
-- goes through an admin client behind app-layer ownership checks, never the
-- browser's anon/authenticated client. This table is professor-analytics only,
-- read via an ownership-verified admin action, so deny-all-to-clients is the
-- correct, safest posture (no client can read it at all) — not a missing policy.
-- Scoped by section_id; institution derives via course_sections, exactly as the
-- sibling quiz tables do (they carry no institution_id column).

CREATE TABLE IF NOT EXISTS quiz_item_stats (
  quiz_id        uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  question_id    uuid NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  section_id     uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  discrimination numeric,                       -- point-biserial, -1..1; NULL when not estimable
  difficulty     numeric,                       -- proportion correct, 0..1
  n_attempts     integer NOT NULL DEFAULT 0,    -- submitted attempts that answered this item
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quiz_id, question_id)
);

ALTER TABLE quiz_item_stats ENABLE ROW LEVEL SECURITY;
-- No policies: admin-client-only, matching the quiz-domain convention documented above.
