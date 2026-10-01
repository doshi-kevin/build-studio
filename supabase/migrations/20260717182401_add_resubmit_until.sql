-- Allow a professor to grant a late-submission window for a specific student.
-- When now() < resubmit_until the deadline gate is bypassed, letting the student
-- submit past due_at. The column is stamped by reopenSubmission() and requestChanges().
ALTER TABLE assignment_submissions
  ADD COLUMN IF NOT EXISTS resubmit_until timestamptz;

COMMENT ON COLUMN assignment_submissions.resubmit_until IS
  'Professor-granted late-submission window. Submission is allowed past due_at while now() < resubmit_until. Null means no active window.';
