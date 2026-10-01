-- ============================================================
-- Quiz walkthrough transcripts — server-authored (ENG-38, PR #148)
-- ============================================================
-- The guided-walkthrough item type grades a student's reasoning from a multi-turn
-- tutor transcript. Previously that transcript lived only on the client and was
-- re-sent at grade time, so both the (authoritative) tutor turns and the per-question
-- turn cap were forgeable — a student could fabricate the conversation that gets
-- graded into θ̂.
--
-- This column makes the SERVER the source of truth:
--   - adaptiveTutorTurn appends each student message + the tutor reply here,
--   - the per-question turn cap counts stored student turns (not the client payload),
--   - gradeWalkthrough scores THIS stored transcript, ignoring the client transcript.
--
-- Shape: { "<questionId uuid>": [ { "role": "student"|"tutor", "text": "…" }, … ] }
--
-- RLS: quiz_attempts already has row-level security (migration 2) scoping rows to the
-- owning student / section professor; this is an additive column, so those existing
-- policies cover it — no new policy needed.
-- ============================================================

ALTER TABLE quiz_attempts
  ADD COLUMN IF NOT EXISTS walkthrough_transcripts jsonb NOT NULL DEFAULT '{}'::jsonb;
