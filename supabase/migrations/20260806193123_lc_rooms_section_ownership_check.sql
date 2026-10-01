-- Tighten lc_rooms writes: a room must belong to a section its creator teaches.
--
-- The original policy (00000000000030) checked only `prof_id = auth.uid()`, so
-- any authenticated user could POST a room via PostgREST with their own prof_id
-- and a VICTIM's section_id. That forged room was inert until the slice-4
-- transcript pipeline made it load-bearing: end the room and the end-of-class
-- job extracts attacker-authored `lc_transcriptions` into
-- `lc_transcript_insights`, which now renders as "the professor said —
-- “<quote>”" on every enrolled student's roadmap and in Athena's answers.
-- Impersonating a professor to their whole class is the exact failure the
-- quote-verification design exists to prevent, so the door it walks through
-- closes here.
--
-- App code is unaffected: every legitimate room insert runs on the service
-- role AFTER verifying section ownership (createRoomDraft / goLive /
-- scheduleLiveClass), and `canWriteAsProfessor` restricts those to the exact
-- professor of the section — so prof_id = section professor already holds for
-- every real row. This policy makes the direct-PostgREST path agree.
--
-- USING stays prof-own (read/update/delete your own rooms); WITH CHECK now also
-- pins the row's section to a section the caller actually teaches — covering
-- both a forged INSERT and an UPDATE that re-homes a room to another section.

DROP POLICY "prof manages own rooms" ON lc_rooms;

CREATE POLICY "prof manages own rooms"
  ON lc_rooms FOR ALL TO authenticated
  USING (prof_id = (SELECT auth.uid()))
  WITH CHECK (
    prof_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM course_sections cs
      WHERE cs.id = lc_rooms.section_id
        AND cs.professor_id = (SELECT auth.uid())
    )
  );
