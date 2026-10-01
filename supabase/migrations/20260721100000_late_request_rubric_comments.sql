-- Item 1: late_request_at — students never write this table;
--         stamped via admin client only; no RLS change needed.
ALTER TABLE assignment_submissions
  ADD COLUMN IF NOT EXISTS late_request_at timestamptz;

-- Item 5: rubric_comments — per-rubric-question inline comments from the professor.
--         Shape: { "<questionIndex>": "text" }.
--         Rides existing row RLS (admin-client writes, student-authenticated SELECT); no policy change.
ALTER TABLE assignment_submissions
  ADD COLUMN IF NOT EXISTS rubric_comments jsonb NOT NULL DEFAULT '{}'::jsonb;
