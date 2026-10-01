-- Assignment Assessment Mode — proctoring storage
--
-- Adds timed + proctored "assessment" support to assignments, mirroring the quiz
-- proctoring system but keyed to assignment_submissions.
--
--   * Assessment CONFIG lives in assignments.settings.assessment (existing jsonb blob):
--       { enabled, workMinutes, uploadMinutes, proctoring: { keystroke, tabSwitch,
--         clipboard, fullscreen, video } }
--     No new column on assignments — it's just JSON, validated app-side.
--   * assignment_submissions gains assessment_started_at (server-anchored clock —
--     the single source of truth for which phase the student is in) and
--     proctoring_summary (aggregated flags, computed at submit).
--   * Two new tables hold the raw proctoring evidence per submission.
--
-- SECURITY: like assignment_submissions, students NEVER write these tables from the
-- browser. Event batches + snapshots are written server-side via the admin client
-- (service_role bypasses RLS). Student policies are therefore SELECT-only (own rows);
-- a FOR ALL / client-INSERT policy would let a student forge or wipe their own
-- proctoring record straight through PostgREST. Staff read their section's rows.

-- ── 1. Server-anchored assessment state on submissions ───────────
--   assessment_started_at   — when the student pressed Start (the phase clock anchor)
--   assessment_work_ended_at— set only if the student ends the work phase EARLY; the
--                             upload window then runs uploadMinutes from this instant.
--                             Always <= started_at + workMinutes, so it can only shrink
--                             the total window, never extend it.
--   proctoring_summary      — aggregated flags computed at submit
ALTER TABLE public.assignment_submissions
  ADD COLUMN IF NOT EXISTS assessment_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS assessment_work_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS proctoring_summary jsonb;

-- ── 2. Batched proctoring event logs ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.assignment_proctoring_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.assignment_submissions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  batch_index integer NOT NULL DEFAULT 0,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  keystroke_count integer NOT NULL DEFAULT 0,  -- plain typing tally (not stored as events)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asg_proctoring_logs_submission
  ON public.assignment_proctoring_logs(submission_id);
CREATE INDEX IF NOT EXISTS idx_asg_proctoring_logs_assignment_student
  ON public.assignment_proctoring_logs(assignment_id, student_id);
-- student SELECT policy filters on student_id (leading column not covered by the composite).
CREATE INDEX IF NOT EXISTS idx_asg_proctoring_logs_student
  ON public.assignment_proctoring_logs(student_id);

-- ── 3. Violation snapshots (metadata; images live in the shared
--        proctoring-snapshots bucket under an assignments/ prefix) ──
CREATE TABLE IF NOT EXISTS public.assignment_proctoring_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.assignment_submissions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  violation_type text NOT NULL,           -- 'mf' (multiple faces) | 'ph' (phone) | 'bl' (baseline)
  storage_path text NOT NULL,             -- path in proctoring-snapshots bucket
  snapshot_url text NOT NULL,             -- signed/public URL for display
  timestamp_offset integer NOT NULL,      -- ms offset from assessment start
  face_count integer NOT NULL DEFAULT 0,  -- faces detected (0 = none, >1 = multiple)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asg_proctoring_snapshots_submission
  ON public.assignment_proctoring_snapshots(submission_id);
CREATE INDEX IF NOT EXISTS idx_asg_proctoring_snapshots_assignment_student
  ON public.assignment_proctoring_snapshots(assignment_id, student_id);
-- student SELECT policy filters on student_id (leading column not covered by the composite).
CREATE INDEX IF NOT EXISTS idx_asg_proctoring_snapshots_student
  ON public.assignment_proctoring_snapshots(student_id);

-- ── 4. Row Level Security ────────────────────────────────────────
ALTER TABLE public.assignment_proctoring_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignment_proctoring_snapshots ENABLE ROW LEVEL SECURITY;

-- Students read only their own proctoring evidence (no client write path).
DROP POLICY IF EXISTS "Students can read own assignment proctoring logs" ON public.assignment_proctoring_logs;
CREATE POLICY "Students can read own assignment proctoring logs"
  ON public.assignment_proctoring_logs FOR SELECT
  USING (student_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Students can read own assignment proctoring snapshots" ON public.assignment_proctoring_snapshots;
CREATE POLICY "Students can read own assignment proctoring snapshots"
  ON public.assignment_proctoring_snapshots FOR SELECT
  USING (student_id = (SELECT auth.uid()));

-- Section staff (professor + active TAs/graders) read their section's evidence,
-- mirroring the "Staff can read section assignment submissions" policy.
DROP POLICY IF EXISTS "Staff can read section assignment proctoring logs" ON public.assignment_proctoring_logs;
CREATE POLICY "Staff can read section assignment proctoring logs"
  ON public.assignment_proctoring_logs FOR SELECT
  USING (
    assignment_id IN (
      SELECT a.id FROM public.assignments a
      WHERE a.section_id IN (
        SELECT id FROM public.course_sections WHERE professor_id = (SELECT auth.uid())
      )
      OR a.section_id IN (
        SELECT section_id FROM public.section_staff
        WHERE staff_id = (SELECT auth.uid()) AND status = 'active' AND ends_at > now()
      )
    )
  );

DROP POLICY IF EXISTS "Staff can read section assignment proctoring snapshots" ON public.assignment_proctoring_snapshots;
CREATE POLICY "Staff can read section assignment proctoring snapshots"
  ON public.assignment_proctoring_snapshots FOR SELECT
  USING (
    assignment_id IN (
      SELECT a.id FROM public.assignments a
      WHERE a.section_id IN (
        SELECT id FROM public.course_sections WHERE professor_id = (SELECT auth.uid())
      )
      OR a.section_id IN (
        SELECT section_id FROM public.section_staff
        WHERE staff_id = (SELECT auth.uid()) AND status = 'active' AND ends_at > now()
      )
    )
  );

-- ── 6. Table privileges ──────────────────────────────────────────
-- The admin client (service_role) writes + reads these; authenticated reads its own/section
-- rows through the RLS policies above. Granted explicitly so the migration works regardless of
-- how it's applied (Supabase's pipeline normally auto-grants, but a raw apply does not). RLS
-- still governs authenticated — a grant without a matching policy denies.
GRANT SELECT, INSERT ON public.assignment_proctoring_logs TO service_role;
GRANT SELECT, INSERT ON public.assignment_proctoring_snapshots TO service_role;
GRANT SELECT ON public.assignment_proctoring_logs TO authenticated;
GRANT SELECT ON public.assignment_proctoring_snapshots TO authenticated;
