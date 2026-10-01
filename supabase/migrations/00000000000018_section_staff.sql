-- Migration: Section Staff (Teaching Assistants + Graders)
--
-- Why: Professors need help running their sections each semester. This adds a
-- two-table workflow:
--   1. Professors submit candidate TA/graders → section_staff_requests (queue)
--   2. Institution admins approve → invite is sent, section_staff row created
--
-- Design decisions (see CLAUDE.md "Key Patterns"):
--   * Profile role = identity ('staff' for dedicated TAs/graders); per-assignment
--     role ('ta' | 'grader') lives on section_staff so one person can be a TA
--     in one section and a grader in another.
--   * Access is scoped by section_staff membership + ends_at > now(); no cron
--     needed — when the semester ends, access naturally expires.
--   * section_staff_requests persists after approval/rejection as an audit log.
--
-- Must be deployed together with the matching code change (hard cutover).

BEGIN;

-- ── 1. Extend profile role identity ──────────────────────────────
-- Drop existing CHECK, replace legacy 'ta' (unused in any rows) with 'staff'.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('institution_admin', 'professor', 'student', 'staff'));

-- ── 2. Drop unused column (replaced by section_staff table) ──────
ALTER TABLE public.course_sections DROP COLUMN IF EXISTS ta_ids;

-- ── 3. section_staff — active assignments ────────────────────────
CREATE TABLE IF NOT EXISTS public.section_staff (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id   uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  staff_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('ta', 'grader')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'removed')),
  starts_at    timestamptz NOT NULL DEFAULT now(),
  ends_at      timestamptz NOT NULL,
  approved_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (section_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_section_staff_section     ON public.section_staff(section_id);
CREATE INDEX IF NOT EXISTS idx_section_staff_staff       ON public.section_staff(staff_id, status);
CREATE INDEX IF NOT EXISTS idx_section_staff_active      ON public.section_staff(section_id, status, ends_at);

-- ── 4. section_staff_requests — pending approval queue ───────────
CREATE TABLE IF NOT EXISTS public.section_staff_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id            uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  requested_by          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  candidate_email       text NOT NULL,
  candidate_first_name  text NOT NULL,
  candidate_last_name   text NOT NULL,
  requested_role        text NOT NULL CHECK (requested_role IN ('ta', 'grader')),
  starts_at             timestamptz NOT NULL DEFAULT now(),
  ends_at               timestamptz NOT NULL,
  message               text,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at           timestamptz,
  review_note           text,
  section_staff_id      uuid REFERENCES public.section_staff(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_requests_status          ON public.section_staff_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_requests_section         ON public.section_staff_requests(section_id);
CREATE INDEX IF NOT EXISTS idx_staff_requests_requested_by    ON public.section_staff_requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_staff_requests_email_lower     ON public.section_staff_requests(lower(candidate_email));

-- Only one pending request per (section, email) at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_requests_pending_unique
  ON public.section_staff_requests(section_id, lower(candidate_email))
  WHERE status = 'pending';

-- ── 5. Helper: is the caller active staff on this section? ───────
-- Used by other tables' RLS to grant TA/grader read/write on a section.
CREATE OR REPLACE FUNCTION public.is_section_staff(p_section_id uuid, p_role text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.section_staff
    WHERE section_id = p_section_id
      AND staff_id = auth.uid()
      AND status = 'active'
      AND ends_at > now()
      AND (p_role IS NULL OR role = p_role)
  );
$$;

-- ── 6. RLS — section_staff ───────────────────────────────────────
ALTER TABLE public.section_staff ENABLE ROW LEVEL SECURITY;

-- The staff member can read their own assignment rows.
CREATE POLICY "Staff can read own assignments"
  ON public.section_staff FOR SELECT
  USING (staff_id = auth.uid());

-- The section's professor can read all staff on their section.
CREATE POLICY "Professors can read staff on owned sections"
  ON public.section_staff FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = section_staff.section_id
        AND cs.professor_id = auth.uid()
    )
  );

-- Institution admins can read every row.
CREATE POLICY "Admins can read all staff"
  ON public.section_staff FOR SELECT
  USING (public.is_admin());

-- Only institution admins may insert/update/delete — all writes go through
-- the approval flow, which runs server-side with the service-role key.
CREATE POLICY "Admins can manage staff"
  ON public.section_staff FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ── 7. RLS — section_staff_requests ──────────────────────────────
ALTER TABLE public.section_staff_requests ENABLE ROW LEVEL SECURITY;

-- Professors can read requests they themselves submitted.
CREATE POLICY "Professors can read own requests"
  ON public.section_staff_requests FOR SELECT
  USING (requested_by = auth.uid());

-- Admins can read every request.
CREATE POLICY "Admins can read all requests"
  ON public.section_staff_requests FOR SELECT
  USING (public.is_admin());

-- Professors can insert requests for sections they own.
CREATE POLICY "Professors can submit requests for own sections"
  ON public.section_staff_requests FOR INSERT
  WITH CHECK (
    requested_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = section_staff_requests.section_id
        AND cs.professor_id = auth.uid()
    )
  );

-- Professors can withdraw their own pending requests.
CREATE POLICY "Professors can withdraw own pending requests"
  ON public.section_staff_requests FOR DELETE
  USING (requested_by = auth.uid() AND status = 'pending');

-- Admins can approve/reject (update).
CREATE POLICY "Admins can review requests"
  ON public.section_staff_requests FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ── 8. updated_at trigger ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_section_staff_touch ON public.section_staff;
CREATE TRIGGER trg_section_staff_touch
  BEFORE UPDATE ON public.section_staff
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_staff_requests_touch ON public.section_staff_requests;
CREATE TRIGGER trg_staff_requests_touch
  BEFORE UPDATE ON public.section_staff_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMIT;
