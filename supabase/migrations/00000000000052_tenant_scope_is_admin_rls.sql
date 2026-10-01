-- CRITICAL: tenant-scope the is_admin() RLS policies on profiles,
-- section_staff, and section_staff_requests.
--
-- The previous is_admin() helper returned true for ANY institution_admin,
-- regardless of tenant. The 6 policies below all used `is_admin()` as
-- their entire predicate, which let any institution_admin in tenant A
-- SELECT/UPDATE every profile, every section_staff row, and every
-- section_staff_request row across ALL tenants — via the public anon
-- key + their JWT.
--
-- Fixes:
--   • New is_admin_of(institution_id uuid) helper — true only when the
--     caller is an institution_admin in THAT institution.
--   • New is_section_admin(section_id uuid) helper — true only when the
--     caller is an institution_admin of the section's parent institution.
--     Section_staff(_requests) only carry section_id directly, so this
--     helper joins through course_sections to enforce tenant scope
--     without a brittle per-policy CTE.
--   • The 6 existing policies are dropped and recreated with the
--     tenant-scoped predicates. is_admin() is left in place (still used
--     elsewhere) but no longer the sole gate for these tables.

BEGIN;

-- ── New tenant-scoped helpers ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_admin_of(p_institution_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'institution_admin'
      AND p.institution_id = p_institution_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_of(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.is_section_admin(p_section_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.course_sections cs
    JOIN public.profiles p ON p.id = auth.uid()
    WHERE cs.id = p_section_id
      AND p.role = 'institution_admin'
      AND cs.institution_id = p.institution_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_section_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_section_admin(uuid) TO authenticated;

-- ── profiles ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Admins can read all profiles" ON public.profiles;
CREATE POLICY "Admins can read profiles in their institution"
  ON public.profiles
  FOR SELECT
  USING (public.is_admin_of(institution_id));

DROP POLICY IF EXISTS "Admins can update all profiles" ON public.profiles;
CREATE POLICY "Admins can update profiles in their institution"
  ON public.profiles
  FOR UPDATE
  USING (public.is_admin_of(institution_id))
  WITH CHECK (public.is_admin_of(institution_id));

-- ── section_staff ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Admins can manage staff" ON public.section_staff;
CREATE POLICY "Admins can manage staff in their institution"
  ON public.section_staff
  FOR ALL
  USING (public.is_section_admin(section_id))
  WITH CHECK (public.is_section_admin(section_id));

DROP POLICY IF EXISTS "Admins can read all staff" ON public.section_staff;
CREATE POLICY "Admins can read staff in their institution"
  ON public.section_staff
  FOR SELECT
  USING (public.is_section_admin(section_id));

-- ── section_staff_requests ────────────────────────────────────────────

DROP POLICY IF EXISTS "Admins can read all requests" ON public.section_staff_requests;
CREATE POLICY "Admins can read requests in their institution"
  ON public.section_staff_requests
  FOR SELECT
  USING (public.is_section_admin(section_id));

DROP POLICY IF EXISTS "Admins can review requests" ON public.section_staff_requests;
CREATE POLICY "Admins can review requests in their institution"
  ON public.section_staff_requests
  FOR UPDATE
  USING (public.is_section_admin(section_id))
  WITH CHECK (public.is_section_admin(section_id));

COMMIT;
