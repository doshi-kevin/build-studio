-- Narrow the node-check answer-key policy from "any active section_staff" to
-- professors and TAs only.
--
-- `node_check_questions` holds `answer_index` — the answer key for every quick
-- check in the section. The original policy's staff clause (migration
-- 20260725024723) had no `role` filter, so ANY active `section_staff` row
-- matched it, including a **grader**. Graders are read-only helpers on submitted
-- work; handing them the key to every check in the course is broader than
-- intended, and this is the one table in the feature where an over-broad SELECT
-- is a real leak rather than a nuisance.
--
-- The sibling policy on `skill_mastery_snapshots`
-- (20260624194443_topic_mastery_topics.sql) deliberately requires `role = 'ta'`;
-- this brings the pool in line with it.
--
-- Still SELECT-only (never FOR ALL), and still NO student policy at all: a
-- student must never read `answer_index`. Writes continue to come solely from
-- the generation job via the admin client.
--
-- `auth.uid()` stays wrapped in a scalar subquery so the planner evaluates it
-- once per query rather than once per row (the auth_rls_initplan advisor).
--
-- RLS is already enabled on the table; this replaces a policy rather than
-- creating one, so there is nothing to backfill and no window where the table
-- sits policy-less for reads (DROP and CREATE run in the same transaction).

DROP POLICY IF EXISTS "section staff read node check pool" ON node_check_questions;

CREATE POLICY "professors and tas read node check pool"
  ON node_check_questions FOR SELECT TO authenticated
  USING (
    section_id IN (SELECT id FROM course_sections WHERE professor_id = (SELECT auth.uid()))
    OR section_id IN (
      SELECT section_id FROM section_staff
      WHERE staff_id = (SELECT auth.uid())
        AND status = 'active'
        AND ends_at > now()
        AND role = 'ta'
    )
  );
