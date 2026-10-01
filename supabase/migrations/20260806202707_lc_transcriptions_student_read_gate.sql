-- Enforce the "Catch me up" gate on raw transcripts at the DB, not only in the
-- app code of every consumer.
--
-- The original student policy (00000000000061) was enrollment-only: any
-- enrolled student could read verbatim professor speech via a direct PostgREST
-- call with the public anon key — including from a room still IN PROGRESS, and
-- from a room whose professor switched replay OFF. Four consumers now
-- re-implement the real rule in application code (Athena's transcript tool, the
-- roadmap's spoken annotations, the N1 vector hydration, the class recap), and
-- athena-students.md states the guarantee outright: "a professor who declined
-- to have their speech played back has declined it everywhere". That was true
-- of every path through the app and false of the table itself.
--
-- The predicate is the one `lc_transcript_insights` already uses
-- (20260805195812), so the raw rows and the structured extraction of those same
-- rows are now gated identically:
--   * ended-only — a live room's transcript is still being written, and
--     replaying the professor mid-sentence is a different feature (X5).
--   * lecture_summary_enabled — defaults ON when null (rooms predating the
--     toggle), matching getLectureSummary and the insights policy.
--
-- App impact: none. Every reader of this table runs server-side on the admin
-- client behind its own ownership/enrollment check (searchMaterialPages,
-- professor-report, getLectureSummary, getRoomTranscriptions, live-quiz
-- generation) — verified before writing this. The professor policy is
-- untouched: a professor reads back their own speech unconditionally.

DROP POLICY "students view transcriptions in enrolled rooms" ON lc_transcriptions;

CREATE POLICY "students view transcriptions in enrolled rooms"
  ON lc_transcriptions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      JOIN enrollments e ON e.section_id = r.section_id
      WHERE r.id = lc_transcriptions.room_id
        AND r.status = 'ended'
        AND COALESCE(r.lecture_summary_enabled, true)
        AND e.student_id = (SELECT auth.uid())
        AND e.status IN ('enrolled', 'completed')
    )
  );
