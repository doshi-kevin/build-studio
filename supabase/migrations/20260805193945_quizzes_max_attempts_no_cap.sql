-- Max Attempts: drop the 1..10 ceiling and let NULL mean "no limit".
-- Issue #43 — professors asked for high values (99) and for unlimited retakes;
-- the old CHECK (max_attempts BETWEEN 1 AND 10) also surfaced as a save error
-- ("Too big: expected number to be <=10") in Quiz Studio.

-- NULL previously carried no meaning: application code read it as `?? 1`.
-- Pin those rows to 1 BEFORE NULL starts meaning unlimited, so existing
-- single-attempt quizzes keep their behaviour.
UPDATE public.quizzes SET max_attempts = 1 WHERE max_attempts IS NULL;

ALTER TABLE public.quizzes DROP CONSTRAINT IF EXISTS quizzes_max_attempts_check;

-- 1000 is MAX_ATTEMPTS_CEILING in src/lib/validations/quiz.ts — NOT the old cap of 10
-- coming back. "Unlimited" is NULL, so a finite value past this is a fat-fingered entry,
-- and the column is an int4: without a ceiling a direct DB write could persist a value
-- the app's own schemas reject. Keep the two in sync if that constant ever moves.
ALTER TABLE public.quizzes
  ADD CONSTRAINT quizzes_max_attempts_check
  CHECK (max_attempts IS NULL OR max_attempts BETWEEN 1 AND 1000);

-- The column default STAYS 1, matching QuizStudio's form default and quizSchema's, so
-- all three creation paths agree on what a new quiz means (Quiz Studio writes the value
-- explicitly; the quick-create action sends title + description only and inherits this).
-- Unlimited is opt-in, never inherited: combined with the 'after_submission' explanations
-- default, a quiz nobody configured would otherwise let a student resubmit toward 100%.
-- Restated rather than left implicit so the intent survives the next schema change.
ALTER TABLE public.quizzes ALTER COLUMN max_attempts SET DEFAULT 1;

COMMENT ON COLUMN public.quizzes.max_attempts IS
  'Attempts a student may submit. NULL = no limit.';

-- RLS: unchanged and deliberate — public.quizzes already has RLS enabled with
-- its institution- and role-scoped policies. This migration alters a CHECK
-- constraint on an existing table; it creates no table and no new access path.
