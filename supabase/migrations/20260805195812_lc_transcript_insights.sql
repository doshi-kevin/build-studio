-- Live Classroom: the transcript extraction read model.
-- Design: docs/designs/roadmap-mastery/roadmap-engine.md §5.1 (slice 4) — the shared source for
-- the roadmap's transcript-derived annotations (P14/P16/P22-P24, S20-S23) and
-- Athena's student answers about what was said in class (athena-students.md
-- §12.1 U21-U24).
--
-- One row per ended room. `insights` holds ONLY quote-anchored claims — every
-- commitment / scope statement / emphasis carries the deck + slide it was said
-- on and the professor's verbatim words, verified in code against the actual
-- transcript before it is ever stored. An unanchored claim is dropped, not
-- softened: fabricating a professor's promise ("you said we could skip the
-- final") is the worst failure this feature has, so the storage layer only ever
-- sees claims that survived verification.
--
-- Why its own table, not a key on lc_class_insights_student: that blob is the
-- student study pack and is PII-free *by construction*; this one quotes the
-- professor and is gated differently (ended rooms + the lecture_summary_enabled
-- toggle). Different audience gate = different row, the same reasoning that
-- split the professor report from the student blob in 20260615013146.
--
-- Tenant scoping: lc_* tables carry no institution_id; isolation flows through
-- room_id -> lc_rooms -> (prof_id | section enrollments), matching every
-- existing lc_ policy (migrations 30/34/36/61, lc_session_reports in 72,
-- lc_class_insights_student in 20260615013146).

CREATE TABLE lc_transcript_insights (
  room_id      uuid PRIMARY KEY REFERENCES lc_rooms(id) ON DELETE CASCADE,
  insights     jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'ready', 'failed')),
  generated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lc_transcript_insights ENABLE ROW LEVEL SECURITY;

-- The room's professor reads their own extraction unconditionally — it is a
-- read-back of their own speech, and the professor-facing roadmap signals
-- (P14/P16/P22-P24) need it as soon as it exists.
CREATE POLICY "prof reads transcript insights for own rooms"
  ON lc_transcript_insights FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      WHERE r.id = lc_transcript_insights.room_id
        AND r.prof_id = (SELECT auth.uid())
    )
  );

-- Students read it only for ENDED rooms, and only when the professor has left
-- "Catch me up" on for that session. Both conditions are deliberate:
--   * ended-only — a live room's transcript is still being written, and
--     replaying the professor mid-sentence is a different feature (X5).
--   * lecture_summary_enabled — a professor who switched off having their
--     spoken words played back to students has already answered this question.
--     Defaults ON when the column is null (rooms predating the toggle),
--     matching getLectureSummary's own default.
-- Enforced here as well as in application code so a direct PostgREST call from
-- the browser cannot step around the toggle.
CREATE POLICY "enrolled student reads transcript insights for ended rooms"
  ON lc_transcript_insights FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      WHERE r.id = lc_transcript_insights.room_id
        AND r.status = 'ended'
        AND COALESCE(r.lecture_summary_enabled, true)
        AND EXISTS (
          SELECT 1 FROM enrollments e
          WHERE e.section_id = r.section_id
            AND e.student_id = (SELECT auth.uid())
            AND e.status IN ('enrolled', 'completed')
        )
    )
  );

-- SELECT-only on purpose. Writes go through the service role in the end-of-class
-- generation orchestrator, which verifies the room server-side first; a FOR ALL
-- policy here would let any enrolled student rewrite what their professor "said"
-- via a direct PostgREST call (.claude/rules/security-migrations.md).

COMMENT ON TABLE lc_transcript_insights IS
  'Quote-anchored structured extraction of a live class transcript: commitments, exam scope, spoken emphasis, off-deck topics, per-slide delivery depth. One row per ended room. Postgres stays the source of truth; fully regenerable from lc_transcriptions.';
