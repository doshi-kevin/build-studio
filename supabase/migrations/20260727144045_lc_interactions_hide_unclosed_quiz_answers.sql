-- Stop students reading live-quiz ANSWER KEYS straight out of the table.
--
-- The problem
-- -----------
-- `lc_interactions.payload` holds the whole quiz, `correctChoiceId` and
-- `explanation` included (quizPayloadSchema). The student SELECT policy from
-- migration 36 grants the WHOLE ROW for every interaction in an enrolled room,
-- at every status. Row-level security cannot withhold one column, so an
-- enrolled student holding the browser anon key could simply ask for it:
--
--   supabase.from('lc_interactions').select('payload').eq('kind','quiz')
--
-- That returns the answers to every live quiz in their section — including ones
-- still in 'draft', staged for a class that has not happened yet.
--
-- The app itself never had this hole: the snapshot strips answers for students
-- (stripQuizAnswers), the broadcast trigger was sanitized in
-- 20260610051747_lc_interactions_sanitize_broadcast.sql, and getQuizReveal
-- gates the reveal server-side with the admin client. That migration says in
-- its own header "No table/RLS change — this only replaces the trigger
-- function", so the direct PostgREST read stayed open. This closes it.
--
-- The fix
-- -------
-- Students keep full read access to polls and Q&A (neither carries an answer
-- key) and to CLOSED quizzes — revealing those is deliberate: the post-quiz
-- review shows a student what they got wrong, and getSectionQuizHistory reads
-- closed quizzes through the RLS client to build it. Draft and open quizzes
-- become invisible to the student role, which is the same anti-cheat rule the
-- snapshot already enforces one layer up.
--
-- Nothing else depends on the dropped access: every other student-facing read
-- of this table goes through the admin client behind an explicit entitlement
-- check (getQuizReveal documents exactly this — "so it stays correct
-- independent of row-level read policies"). Professors are unaffected; their
-- own FOR ALL policy is untouched.
--
-- Still SELECT-only for students, as before — no write path is opened here.

DROP POLICY IF EXISTS "students view interactions in enrolled rooms" ON lc_interactions;

CREATE POLICY "students view interactions in enrolled rooms"
  ON lc_interactions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      JOIN enrollments e ON e.section_id = r.section_id
      WHERE r.id = lc_interactions.room_id
        -- Scalar subquery so the planner evaluates auth.uid() once per query
        -- rather than once per row (the auth_rls_initplan advisor).
        AND e.student_id = (SELECT auth.uid())
        AND e.status IN ('enrolled','completed')
    )
    -- A quiz row carries its own answer key, so it is readable only once the
    -- professor has closed it. Polls and questions have no answers to leak.
    AND (lc_interactions.kind <> 'quiz' OR lc_interactions.status = 'closed')
  );
