-- Placeholder / incomplete questions.
--
-- A professor can add a blank question to a quiz draft and it now PERSISTS
-- (survives navigation), so they can lay out placeholder questions and fill
-- them in later. An incomplete question is tagged is_complete = false: it is
-- excluded from the "Pick from question bank" picker and blocks publish until
-- it's valid (a non-empty stem + gradeable content). Existing rows are all
-- treated as complete via the default.
--
-- quiz_questions has RLS enabled with NO policies (deny-all to anon/auth); all
-- access is through the admin/service-role client after server-action authz, so
-- this column needs no policy change. Completeness is enforced in the server
-- actions (bulkCreateQuestions / bulkUpdateQuestionContent / publishQuiz).
ALTER TABLE quiz_questions
  ADD COLUMN IF NOT EXISTS is_complete boolean NOT NULL DEFAULT true;
