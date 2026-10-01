-- Persist the AI grader's student-facing rationale (issue #174).
-- gradeExplanation/gradeWalkthrough already return a 1–2 sentence rationale
-- ("the same call's rationale doubles as student-facing feedback") and
-- getAdaptiveResults already reads answer.rationale — but the column never
-- existed and submitAdaptiveAnswer never wrote it. RLS is already enabled on
-- quiz_answers (00000000000002_quiz.sql); adding a column inherits it.
ALTER TABLE quiz_answers ADD COLUMN IF NOT EXISTS rationale text;
