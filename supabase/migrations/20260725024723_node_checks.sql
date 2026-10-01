-- Roadmap Part II — node checks, slice 2b.
--
-- A short auto-generated check inside a supplementary node's modal, so a
-- student can show they went through a paper or a video
-- (docs/designs/roadmap-mastery/roadmap-engine.md §14). Two small tables rather than a flag on
-- `quizzes`, because a flag has to be remembered by EVERY existing consumer —
-- the gradebook, item-discrimination (P6), draft tallies (P7), due dates (P10),
-- the quiz list — and the first one that forgets silently corrupts real
-- analytics (§14.3). Its own tables cannot leak by construction.
--
-- ⚠️ This tick evidences EFFORT, not comprehension: five fixed questions with
-- unlimited retries means a student can toggle until it passes. That is
-- deliberate — the goal is to get the material opened — so the result must
-- never be treated as an assessment or shown as a grade, and nothing here
-- joins to quizzes or grades.
-- (Amended 2026-08: since the optional-check redesign a FIRST pass does feed
-- skill_mastery — one deliberately tiny event per (student, item), capped
-- structurally by the UNIQUE constraint below plus never-regressing `passed`.
-- See NODE_CHECK_MASTERY_WEIGHT in src/lib/skills/scoring.ts. Comment-only
-- amendment; the SQL in this migration is unchanged.)

-- ── 1. The generated pool, one row per question ──────────────────────

CREATE TABLE node_check_questions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  section_id      uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  module_item_id  uuid NOT NULL REFERENCES module_items(id) ON DELETE CASCADE,
  prompt          text NOT NULL,
  -- Four option strings, in display order.
  choices         jsonb NOT NULL,
  -- Index into `choices`. The ANSWER KEY — never selected on a student path.
  answer_index    int  NOT NULL CHECK (answer_index BETWEEN 0 AND 3),
  -- Which generation produced this row. Regenerating after the professor
  -- replaces the file bumps this, so a stale pool is easy to retire.
  pool_version    int  NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_node_check_questions_item ON node_check_questions (module_item_id, pool_version);
-- The staff SELECT policy filters section_id, so it needs its own index
-- (.claude/rules/data-access.md: index any column an RLS policy filters on).
CREATE INDEX idx_node_check_questions_section ON node_check_questions (section_id);

ALTER TABLE node_check_questions ENABLE ROW LEVEL SECURITY;

-- Professors/TAs of the owning section may read the pool (they can review a
-- student's five questions and answers). SELECT-only, and NO student policy at
-- all: a student must never be able to read `answer_index`. The five bodies
-- they need are handed out by an enrolment-verified server action, which omits
-- the key. Writes come solely from the generation job via the admin client.
CREATE POLICY "section staff read node check pool"
  ON node_check_questions FOR SELECT TO authenticated
  USING (
    section_id IN (SELECT id FROM course_sections WHERE professor_id = (SELECT auth.uid()))
    OR section_id IN (
      SELECT section_id FROM section_staff
      WHERE staff_id = (SELECT auth.uid()) AND status = 'active' AND ends_at > now()
    )
  );

-- ── 2. One row per (student, item) — the deal, the answers, the result ──

CREATE TABLE node_check_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  section_id      uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  module_item_id  uuid NOT NULL REFERENCES module_items(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- The five question ids this student was dealt, in order. Fixed once dealt:
  -- random PER STUDENT solves answer-sharing, fixed per student keeps it a
  -- nudge rather than an exam (§14.2).
  question_ids    uuid[] NOT NULL,
  -- Their latest answer per dealt question: array of chosen indices (or null).
  answers         jsonb NOT NULL DEFAULT '[]'::jsonb,
  passed          boolean NOT NULL DEFAULT false,
  tries           int NOT NULL DEFAULT 0,
  -- The pool generation these ids came from; a regenerated pool re-deals.
  pool_version    int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (module_item_id, student_id)
);

CREATE INDEX idx_node_check_attempts_section ON node_check_attempts (section_id, student_id);
-- The students-read-own policy filters student_id ALONE, which the composite
-- above cannot serve (wrong leading column).
CREATE INDEX idx_node_check_attempts_student ON node_check_attempts (student_id);

ALTER TABLE node_check_attempts ENABLE ROW LEVEL SECURITY;

-- Students read their OWN row only. Deliberately SELECT-only for clients: every
-- write goes through the grading server action, which scores against the pool.
-- A FOR ALL policy here would let a student PATCH `passed = true` straight
-- through PostgREST and skip the questions entirely.
CREATE POLICY "students read own node check attempt"
  ON node_check_attempts FOR SELECT TO authenticated
  USING (student_id = (SELECT auth.uid()));

CREATE POLICY "section staff read node check attempts"
  ON node_check_attempts FOR SELECT TO authenticated
  USING (
    section_id IN (SELECT id FROM course_sections WHERE professor_id = (SELECT auth.uid()))
    OR section_id IN (
      SELECT section_id FROM section_staff
      WHERE staff_id = (SELECT auth.uid()) AND status = 'active' AND ends_at > now()
    )
  );

-- ── 3. Generation bookkeeping on the item itself ─────────────────────
--
-- Lazy generation (§14.2): the first student to open the node triggers it, so
-- material nobody opens costs nothing. These two columns let the action tell
-- "never asked" from "asked, still running" from "asked, and the generator said
-- there is nothing worth testing here".

ALTER TABLE module_items
  ADD COLUMN node_check_state text NOT NULL DEFAULT 'none'
    CHECK (node_check_state IN ('none', 'pending', 'ready', 'not_quizzable', 'failed')),
  ADD COLUMN node_check_pool_version int NOT NULL DEFAULT 0;

COMMENT ON COLUMN module_items.node_check_state IS
  'Roadmap node check (docs/designs/roadmap-mastery/roadmap-engine.md §14): none = never requested, pending = generating, ready = pool exists, not_quizzable = the generator judged there is no comprehension to test (falls back to a self check-off), failed = generation errored.';
