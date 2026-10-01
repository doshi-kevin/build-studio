-- Multi-tenant Phase 1: foundational schema for the super_admin / hand-off flow.
--
-- This migration introduces the `institutions` table and tags every top-level
-- tenant-scoped table with an `institution_id` column. It does NOT yet:
--   • tighten RLS to filter by tenant on the 5 tagged tables (Phase 1.5 — separate
--     follow-up commit after the create-institution flow is verified)
--   • add institution_id to transitive tables (modules, quizzes, etc. inherit
--     via FK chains and don't need their own column until RLS performance demands it)
--
-- Two institutions are seeded:
--   • Stevens (UUID …01) — production customer
--   • Scholera Dev (UUID …02) — internal test accounts (any *@scholera.dev email)
--
-- Backfill strategy (Gemini-reviewed; no DEFAULT sentinel left in place):
--   1. Add columns NULLABLE.
--   2. Backfill profiles by email pattern.
--   3. Backfill course_sections from the section's professor's institution.
--   4. Backfill departments / programs / courses default to Stevens (institutional
--      resources currently shared, not per-user).
--   5. SET NOT NULL.
--   6. NO DEFAULT — future inserts MUST explicitly declare their owner. This is
--      the safety net against silent cross-tenant writes.
--
-- Re-introduces the `super_admin` role that was reserved by migration 17.

BEGIN;

-- ── 1. institutions table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institutions_slug_format CHECK (slug ~ '^[a-z0-9-]+$'),
  CONSTRAINT institutions_status_check CHECK (status IN ('active', 'suspended', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_institutions_slug ON institutions(slug);
CREATE INDEX IF NOT EXISTS idx_institutions_status ON institutions(status);

ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;

-- ── 2. Seed institutions ───────────────────────────────────────────────────
-- Hardcoded sentinel UUIDs so we can reference them in the backfill below.
-- Easy to grep for; will never collide with gen_random_uuid().
INSERT INTO institutions (id, name, slug, status)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Stevens Institute of Technology', 'stevens', 'active'),
  ('00000000-0000-0000-0000-000000000002', 'Scholera Dev', 'dev', 'active')
ON CONFLICT (id) DO NOTHING;

-- ── 3. Re-introduce the super_admin role + rename 'staff' → 'course_assistant' ─
-- Two changes to profiles_role_check:
--   1. Add 'super_admin' (reserved by migration 17, now claimed).
--   2. Rename 'staff' → 'course_assistant'. The legacy 'staff' label was
--      ambiguous with future "institution admin staff" / IT staff concepts;
--      'course_assistant' explicitly conveys the section-level TA/grader role.
--
-- Order matters: drop the constraint first so the UPDATE can run freely, then
-- rename existing rows, then reapply the constraint with the new allowed set.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

UPDATE public.profiles
SET role = 'course_assistant'
WHERE role = 'staff';

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('super_admin', 'institution_admin', 'professor', 'student', 'course_assistant'));

-- Helper for RLS / server-side role checks. Mirrors is_admin() from migration 17.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'super_admin'
  );
$$;

-- ── 4. Add institution_id columns (nullable for now; backfill below) ───────
-- Five tables get the column directly. Everything else (enrollments, modules,
-- quizzes, announcements, etc.) inherits its tenant via FK chain and doesn't
-- need a column until Phase 2.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS institution_id uuid
    REFERENCES institutions(id) ON DELETE RESTRICT;

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS institution_id uuid
    REFERENCES institutions(id) ON DELETE RESTRICT;

ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS institution_id uuid
    REFERENCES institutions(id) ON DELETE RESTRICT;

ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS institution_id uuid
    REFERENCES institutions(id) ON DELETE RESTRICT;

ALTER TABLE course_sections
  ADD COLUMN IF NOT EXISTS institution_id uuid
    REFERENCES institutions(id) ON DELETE RESTRICT;

-- ── 5. Backfill ────────────────────────────────────────────────────────────

-- 5a. Profiles: anyone with a *@scholera.dev email goes to Dev; everyone else
-- goes to Stevens.
UPDATE profiles
SET institution_id = '00000000-0000-0000-0000-000000000002'
WHERE email ILIKE '%@scholera.dev'
  AND institution_id IS NULL;

UPDATE profiles
SET institution_id = '00000000-0000-0000-0000-000000000001'
WHERE institution_id IS NULL;

-- 5b. Course sections: derive from the assigned professor's institution.
UPDATE course_sections cs
SET institution_id = p.institution_id
FROM profiles p
WHERE cs.professor_id = p.id
  AND cs.institution_id IS NULL;

-- Sections without a professor assigned default to Stevens (matches existing
-- single-tenant assumption — these are pre-existing records).
UPDATE course_sections
SET institution_id = '00000000-0000-0000-0000-000000000001'
WHERE institution_id IS NULL;

-- 5c. Departments, programs, courses: institutional resources currently shared
-- in the single-tenant DB. Default everything to Stevens. If any need to be
-- moved to Dev later, that's a manual one-off cleanup.
UPDATE departments
SET institution_id = '00000000-0000-0000-0000-000000000001'
WHERE institution_id IS NULL;

UPDATE programs
SET institution_id = '00000000-0000-0000-0000-000000000001'
WHERE institution_id IS NULL;

UPDATE courses
SET institution_id = '00000000-0000-0000-0000-000000000001'
WHERE institution_id IS NULL;

-- ── 6. Lock down: SET NOT NULL, no DEFAULT ────────────────────────────────
-- This is the critical safety net. Without a DEFAULT, any future INSERT that
-- forgets to specify institution_id will FAIL LOUDLY rather than silently write
-- to Stevens. That's exactly what we want.

ALTER TABLE profiles ALTER COLUMN institution_id SET NOT NULL;
ALTER TABLE departments ALTER COLUMN institution_id SET NOT NULL;
ALTER TABLE programs ALTER COLUMN institution_id SET NOT NULL;
ALTER TABLE courses ALTER COLUMN institution_id SET NOT NULL;
ALTER TABLE course_sections ALTER COLUMN institution_id SET NOT NULL;

-- ── 7. Indexes for the new FK columns ─────────────────────────────────────
-- Phase 1.5 RLS policies will filter on institution_id, so these are mandatory
-- before that work lands. Adding now while tables are small is essentially free.
CREATE INDEX IF NOT EXISTS idx_profiles_institution ON profiles(institution_id);
CREATE INDEX IF NOT EXISTS idx_departments_institution ON departments(institution_id);
CREATE INDEX IF NOT EXISTS idx_programs_institution ON programs(institution_id);
CREATE INDEX IF NOT EXISTS idx_courses_institution ON courses(institution_id);
CREATE INDEX IF NOT EXISTS idx_course_sections_institution ON course_sections(institution_id);

-- ── 8. Relax global UNIQUE constraint on departments.code to per-tenant ───
-- Today: departments.code is globally UNIQUE. The moment institution #2 tries
-- to create department "CS", that blows up. Relax to UNIQUE(institution_id, code).
--
-- programs.code and courses.code are already UNIQUE(department_id, code) —
-- since each department is now institution-scoped, those compound uniques are
-- transitively institution-scoped. No change needed.

ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_code_key;
ALTER TABLE departments
  ADD CONSTRAINT departments_institution_code_key UNIQUE (institution_id, code);

-- ── 9. Sync institution_id to auth.users.app_metadata ─────────────────────
-- Putting institution_id in the JWT lets future RLS policies do
--   (auth.jwt() -> 'app_metadata' ->> 'institution_id')::uuid = institution_id
-- which is far cheaper than a subquery against profiles. Even though Phase 1.5
-- isn't tightening RLS yet, baking the JWT field in now means we don't have to
-- backfill it later.

CREATE OR REPLACE FUNCTION public.sync_institution_to_auth_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Only update auth.users when institution_id actually changed (or on insert).
  IF TG_OP = 'INSERT' OR NEW.institution_id IS DISTINCT FROM OLD.institution_id THEN
    UPDATE auth.users
    SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                            || jsonb_build_object('institution_id', NEW.institution_id::text)
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_institution_to_auth_metadata_trigger ON profiles;
CREATE TRIGGER sync_institution_to_auth_metadata_trigger
  AFTER INSERT OR UPDATE OF institution_id ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_institution_to_auth_metadata();

-- One-time backfill for the existing users we just tagged.
UPDATE auth.users u
SET raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb)
                        || jsonb_build_object('institution_id', p.institution_id::text)
FROM profiles p
WHERE p.id = u.id;

-- ── 10. RLS for the institutions table itself ─────────────────────────────
-- Only super_admins can read/write the institutions catalog directly.
-- Regular users can SELECT their own institution row (so the UI can render
-- the institution name in headers etc.).
-- Server actions go through createAdminClient (service role) which bypasses
-- RLS entirely — these policies cover the browser-side path only.

CREATE POLICY "Super admins can view all institutions"
  ON institutions FOR SELECT
  USING (public.is_super_admin());

CREATE POLICY "Super admins can insert institutions"
  ON institutions FOR INSERT
  WITH CHECK (public.is_super_admin());

CREATE POLICY "Super admins can update institutions"
  ON institutions FOR UPDATE
  USING (public.is_super_admin());

-- Authenticated users can read their own institution row.
CREATE POLICY "Users can view own institution"
  ON institutions FOR SELECT
  USING (
    id = (SELECT institution_id FROM profiles WHERE profiles.id = auth.uid())
  );

COMMIT;
