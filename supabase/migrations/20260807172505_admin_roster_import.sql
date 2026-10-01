-- Admin roster import: admin-driven rostering replaces student self-enrollment.
-- Design: docs/designs/platform/admin-roster-import.md
--
-- 1. enrollments.source — which mechanism created the row ('manual' = admin UI,
--    'import' = bulk roster import). Future SIS/CSV sync will only touch rows it owns.
-- 2. institutions.settings — institution-level policy JSONB; today only
--    { "selfUnenroll": { "enabled": bool, "days": int } }.
-- 3. Drop enrollment_requests — the application/approval pipeline is removed.
-- 4. Strip the orphaned settings->'enrollment' config (approvalRequired / questions)
--    from course_sections; nothing reads it anymore.
--
-- Deliberately NOT dropped: course_sections.enrollment_start_date / enrollment_end_date
-- (dormant legacy columns; UI removed, columns kept to avoid touching their read sites).

ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'enrollments_source_check' AND conrelid = 'public.enrollments'::regclass
  ) THEN
    ALTER TABLE public.enrollments
      ADD CONSTRAINT enrollments_source_check CHECK (source IN ('manual', 'import'));
  END IF;
END $$;

ALTER TABLE public.institutions
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.institutions.settings IS
  'Institution-level policy config (e.g. selfUnenroll). READABLE BY EVERY AUTHENTICATED USER of the tenant via the row-level "view own institution" SELECT policy — never park secrets (SSO keys, LTI credentials, API keys) here; use a separate server-only table instead.';

DROP TABLE IF EXISTS public.enrollment_requests CASCADE;

UPDATE public.course_sections
SET settings = settings - 'enrollment'
WHERE settings ? 'enrollment';
