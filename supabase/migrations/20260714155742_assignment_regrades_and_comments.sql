-- Assignment regrade requests + per-subquestion comment threads (issue #365, v1: assignments only).
--
-- Two new tables:
--   • assignment_regrade_requests — a student's appeal against a released grade, targeting one or
--     more rubric subquestions (or reason-only when the assignment has no rubric). This is an
--     AUDIT LOG of the appeal, NEVER a source of truth for the score. The score lives on
--     assignment_submissions and changes only via gradeSubmission(); a resolved request just
--     snapshots old_score/new_score for the record.
--   • assignment_submission_comments — a comment thread per rubric subquestion that both the
--     student and section staff post to (the conversation that anchors a regrade).
--
-- Client RLS is SELECT-only on BOTH tables (same rationale as assignment_submissions in
-- 20260617024531_assignments.sql): all writes run through server actions with the admin client
-- (service_role bypasses RLS). A student INSERT/UPDATE policy would be a write hole — a student
-- could forge status / old_score / institution_id straight through PostgREST. There is no
-- client-side write path. Tenant columns (institution_id, section_id, assignment_id) are always
-- set server-side from the verified assignment row, never from the client.
--
-- auth.uid() is wrapped in a scalar subquery per the auth_rls_initplan advisor (planner runs it
-- once per query, not once per row). section_id is denormalized onto both tables so the staff
-- predicate checks section ownership directly instead of joining through assignments.

-- Every statement is written to be re-runnable: this migration is hand-applied to remote
-- environments, and a bare CREATE POLICY halting a re-run part-way would leave RLS enabled with
-- policies missing (= silently unreadable tables).
--
-- ── assignment_regrade_requests ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assignment_regrade_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.assignment_submissions(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Snapshot of targeted subquestions: [{ "index": 1, "label": "Q2(a)" }, ...]. Empty array on a
  -- rubric-less assignment (reason-only appeal). Labels are re-snapshotted server-side from the
  -- assignment's rubric at request time — client-supplied labels never reach this column.
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'withdrawn')),
  old_score numeric(6,2),                 -- submission.score at request time
  new_score numeric(6,2),                 -- submission.score at resolve time
  resolution_note text NOT NULL DEFAULT '',
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One OPEN request per submission (atomic dedup — the insert branches on the 23505 violation
-- rather than doing a prior existence SELECT). Resolving/withdrawing frees the slot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_regrade_open_per_submission
  ON public.assignment_regrade_requests (submission_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_regrade_assignment_status ON public.assignment_regrade_requests (assignment_id, status);
CREATE INDEX IF NOT EXISTS idx_regrade_section_status ON public.assignment_regrade_requests (section_id, status);
CREATE INDEX IF NOT EXISTS idx_regrade_student ON public.assignment_regrade_requests (student_id);
CREATE INDEX IF NOT EXISTS idx_regrade_submission ON public.assignment_regrade_requests (submission_id);

ALTER TABLE public.assignment_regrade_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students can read own regrade requests" ON public.assignment_regrade_requests;
CREATE POLICY "Students can read own regrade requests"
  ON public.assignment_regrade_requests FOR SELECT
  USING (student_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff can read section regrade requests" ON public.assignment_regrade_requests;
CREATE POLICY "Staff can read section regrade requests"
  ON public.assignment_regrade_requests FOR SELECT
  USING (
    section_id IN (
      SELECT id FROM public.course_sections WHERE professor_id = (SELECT auth.uid())
    )
    OR section_id IN (
      SELECT section_id FROM public.section_staff
      WHERE staff_id = (SELECT auth.uid()) AND status = 'active' AND ends_at > now()
    )
  );

-- Table privileges. Supabase's default-privilege auto-grant to anon/authenticated/service_role is
-- not guaranteed to fire for these tables, so grant explicitly and match the SELECT-only policy
-- design: authenticated only ever READS (the policies above gate which rows); every write runs
-- through the admin client, so service_role gets DML. No INSERT/UPDATE/DELETE for authenticated —
-- there is no client-side write path.
GRANT SELECT ON public.assignment_regrade_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assignment_regrade_requests TO service_role;

-- ── assignment_submission_comments ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.assignment_submission_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.assignment_submissions(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  question_index int NOT NULL CHECK (question_index >= 0),
  question_label text NOT NULL DEFAULT '',   -- snapshot from the rubric; survives later rubric edits
  author_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  author_role text NOT NULL CHECK (author_role IN ('student', 'staff')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_comments_submission_q
  ON public.assignment_submission_comments (submission_id, question_index, created_at);
CREATE INDEX IF NOT EXISTS idx_sub_comments_section ON public.assignment_submission_comments (section_id);
CREATE INDEX IF NOT EXISTS idx_sub_comments_author ON public.assignment_submission_comments (author_id);

ALTER TABLE public.assignment_submission_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students can read comments on own submissions" ON public.assignment_submission_comments;
CREATE POLICY "Students can read comments on own submissions"
  ON public.assignment_submission_comments FOR SELECT
  USING (
    submission_id IN (
      SELECT id FROM public.assignment_submissions WHERE student_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Staff can read section submission comments" ON public.assignment_submission_comments;
CREATE POLICY "Staff can read section submission comments"
  ON public.assignment_submission_comments FOR SELECT
  USING (
    section_id IN (
      SELECT id FROM public.course_sections WHERE professor_id = (SELECT auth.uid())
    )
    OR section_id IN (
      SELECT section_id FROM public.section_staff
      WHERE staff_id = (SELECT auth.uid()) AND status = 'active' AND ends_at > now()
    )
  );

-- Table privileges (see rationale on assignment_regrade_requests above): authenticated reads only,
-- service_role does all writes via the admin client.
GRANT SELECT ON public.assignment_submission_comments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assignment_submission_comments TO service_role;
