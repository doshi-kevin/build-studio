-- Migration: Rename role 'super_admin' → 'institution_admin'
--
-- Why: The role previously called "super_admin" actually represents a
-- per-institution admin (managing departments, professors, courses, programs,
-- and students within ONE university). The name "super_admin" is being
-- reserved for a future platform-level role held by the Scholera team to
-- manage multiple institutions. See CLAUDE.md "User Roles" for current
-- semantics.
--
-- Must be deployed together with the matching code change (hard cutover).
-- Run against local Supabase first, verify, then apply to prod at deploy time.

BEGIN;

-- 1. Drop the existing CHECK constraint so we can update values.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

-- 2. Backfill existing rows.
UPDATE public.profiles
SET role = 'institution_admin'
WHERE role = 'super_admin';

-- 3. Reinstate the CHECK constraint with the new allowed set.
--    'ta' is preserved untouched (legacy).
--    'super_admin' is intentionally NOT added here — it will be reintroduced
--    later when the platform-level Scholera admin role is built.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('institution_admin', 'professor', 'student', 'ta'));

-- 4. Replace the is_admin() helper function so RLS policies that depend on it
--    resolve against the new role value.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'institution_admin'
  );
$$;

COMMIT;
