-- Assignments: professor-created coursework with student submissions.
--
-- Submission model (Assignment Studio v1 — text + file upload):
--   * assignments.settings.accepts = { fileTypes: string[], text: 'optional' }
--     fileTypes is a list of file-type KINDS (pdf, image, doc, ppt, txt, …).
--     Empty fileTypes => text-only assignment. The text box is always optional.
--   * one submission row per (assignment, student): optional text_content + files[].
--
-- Files live in the dedicated private `assignment-submissions` bucket (created in
-- migration 20260617050624_assignment_submissions_bucket.sql) under
--   <sectionId>/<assignmentId>/<studentId>/<file>
-- read/written server-side via the admin client (signed URLs at read time). A
-- dedicated bucket — not shared `course-materials` — so its owner/staff RLS can't
-- leak a classmate's submission. This migration itself adds no storage policies.

-- ── assignments ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  module_id uuid REFERENCES public.modules(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  guidelines text NOT NULL DEFAULT '',
  submission_type text NOT NULL DEFAULT 'written'
    CHECK (submission_type IN ('written', 'link', 'files', 'code')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'closed', 'archived')),
  points numeric(6, 2) NOT NULL DEFAULT 100 CHECK (points >= 0 AND points <= 1000),
  rubric jsonb NOT NULL DEFAULT '[]'::jsonb,
  reference_materials jsonb NOT NULL DEFAULT '[]'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  start_at timestamptz,
  due_at timestamptz,
  end_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assignments_section ON public.assignments(section_id);
CREATE INDEX IF NOT EXISTS idx_assignments_section_status ON public.assignments(section_id, status);
CREATE INDEX IF NOT EXISTS idx_assignments_section_due ON public.assignments(section_id, due_at);

ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;

-- ── assignment_submissions ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.assignment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'graded')),
  text_content text,
  url text,
  code_content text,
  code_language text,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  score numeric(6, 2) CHECK (score IS NULL OR (score >= 0 AND score <= 1000)),
  feedback text NOT NULL DEFAULT '',
  graded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  graded_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_assignment_submissions_assignment ON public.assignment_submissions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignment_submissions_assignment_status ON public.assignment_submissions(assignment_id, status);
CREATE INDEX IF NOT EXISTS idx_assignment_submissions_student ON public.assignment_submissions(student_id);

ALTER TABLE public.assignment_submissions ENABLE ROW LEVEL SECURITY;

-- ── RLS: assignments ─────────────────────────────────────────────
-- Professors own their section's assignments; active TAs may manage them.
-- Membership predicates transitively scope by institution (a section belongs
-- to exactly one institution), matching the sibling quiz/project policies.

CREATE POLICY "Professors and TAs can manage section assignments"
  ON public.assignments FOR ALL
  USING (
    section_id IN (
      SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
    )
    OR section_id IN (
      SELECT section_id FROM public.section_staff
      WHERE staff_id = auth.uid() AND status = 'active' AND ends_at > now()
        AND role = 'ta'
    )
  );

CREATE POLICY "Enrolled students can read published assignments"
  ON public.assignments FOR SELECT
  USING (
    status IN ('published', 'closed')
    AND section_id IN (
      SELECT section_id FROM public.enrollments
      WHERE student_id = auth.uid() AND status IN ('enrolled', 'completed', 'active')
    )
  );

-- ── RLS: assignment_submissions ────────────────────────────────
-- Section staff read; professors/TAs/graders grade; students READ their own only.
-- Students never write this table from the browser — submit / resubmit / grade all run
-- through the admin client (service_role bypasses RLS). Supabase grants DML to the
-- `authenticated` role by default, so a FOR ALL student policy would let a student
-- self-UPSERT status='graded', score=<max> straight through PostgREST and grade
-- themselves. This is intentionally SELECT-only; there is no client-side write path.

CREATE POLICY "Staff can read section assignment submissions"
  ON public.assignment_submissions FOR SELECT
  USING (
    assignment_id IN (
      SELECT a.id FROM public.assignments a
      WHERE a.section_id IN (
        SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
      )
      OR a.section_id IN (
        SELECT section_id FROM public.section_staff
        WHERE staff_id = auth.uid() AND status = 'active' AND ends_at > now()
      )
    )
  );

CREATE POLICY "Staff can grade section assignment submissions"
  ON public.assignment_submissions FOR UPDATE
  USING (
    assignment_id IN (
      SELECT a.id FROM public.assignments a
      WHERE a.section_id IN (
        SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
      )
      OR a.section_id IN (
        SELECT section_id FROM public.section_staff
        WHERE staff_id = auth.uid() AND status = 'active' AND ends_at > now()
          AND role IN ('ta', 'grader')
      )
    )
  );

CREATE POLICY "Students can read own assignment submissions"
  ON public.assignment_submissions FOR SELECT
  USING (student_id = auth.uid());
