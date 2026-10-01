-- Multi-tenant Phase 2 hardening — security + perf gaps surfaced in review.
--
-- Three changes:
--   1. Sync institutions.status to auth.users.app_metadata.institution_status.
--      Lets DashboardLayout (and future server actions) read suspension state
--      from the JWT rather than hitting the DB on every render.
--   2. SQL view `audit_log_with_actor` — LEFT JOIN profiles so deleted actors
--      still surface (as NULL name/email) and we kill the n+1 lookup pattern.
--   3. SQL view `section_staff_with_institution` — adds institution_id derived
--      from the section_id FK chain so getInstitutionAdminCounts can filter
--      cross-tenant section_staff cleanly.
--
-- All three are additive — no existing column / behavior changes.

BEGIN;

-- ── 1. Sync institution_status to JWT app_metadata ────────────────────────
-- Trigger fires on profiles INSERT/UPDATE OF institution_id (chain to user)
-- AND on institutions UPDATE OF status (chain to all that institution's users).
-- Combined with auth.admin.signOut('global') in setInstitutionStatus(), this
-- ensures suspended-tenant users can't keep operating with a cached JWT.

-- 1a. Extend the existing sync function to also push status.
CREATE OR REPLACE FUNCTION public.sync_institution_to_auth_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.institution_id IS DISTINCT FROM OLD.institution_id THEN
    SELECT status INTO v_status FROM public.institutions WHERE id = NEW.institution_id;
    UPDATE auth.users
    SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                            || jsonb_build_object(
                              'institution_id', NEW.institution_id::text,
                              'institution_status', COALESCE(v_status, 'active')
                            )
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

-- 1b. New trigger: when an institution's status flips, update every member's JWT.
CREATE OR REPLACE FUNCTION public.sync_institution_status_to_members()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE auth.users u
    SET raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb)
                            || jsonb_build_object('institution_status', NEW.status)
    FROM public.profiles p
    WHERE p.id = u.id
      AND p.institution_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_institution_status_to_members_trigger ON public.institutions;
CREATE TRIGGER sync_institution_status_to_members_trigger
  AFTER UPDATE OF status ON public.institutions
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_institution_status_to_members();

-- 1c. One-time backfill — populate institution_status for every existing user.
UPDATE auth.users u
SET raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb)
                        || jsonb_build_object('institution_status', i.status)
FROM public.profiles p
JOIN public.institutions i ON i.id = p.institution_id
WHERE p.id = u.id;

-- ── 2. audit_log_with_actor view ──────────────────────────────────────────
-- Replaces the in-app n+1 actor lookup. LEFT JOIN means deleted actor profiles
-- come back as NULL rather than vanishing rows.
CREATE OR REPLACE VIEW public.audit_log_with_actor AS
SELECT
  e.id,
  e.event_type,
  e.metadata,
  e.timestamp,
  e.user_id   AS actor_id,
  p.name      AS actor_name,
  p.email     AS actor_email
FROM public.events e
LEFT JOIN public.profiles p ON p.id = e.user_id;

-- Lock down: only super_admins read it. View inherits RLS from underlying tables
-- when SECURITY INVOKER (default), but we surface it as a security boundary by
-- restricting GRANTs.
REVOKE ALL ON public.audit_log_with_actor FROM PUBLIC;
GRANT SELECT ON public.audit_log_with_actor TO service_role;

-- ── 3. section_staff institution chain ────────────────────────────────────
-- For getInstitutionAdminCounts. section_staff itself doesn't carry
-- institution_id, but its section_id FKs into course_sections which does.
-- A view exposing the join lets the dashboard count filter by tenant cleanly.
CREATE OR REPLACE VIEW public.section_staff_with_institution AS
SELECT
  ss.id,
  ss.section_id,
  ss.staff_id,
  ss.role,
  ss.status,
  ss.starts_at,
  ss.ends_at,
  ss.approved_by,
  ss.created_at,
  ss.updated_at,
  cs.institution_id
FROM public.section_staff ss
JOIN public.course_sections cs ON cs.id = ss.section_id;

REVOKE ALL ON public.section_staff_with_institution FROM PUBLIC;
GRANT SELECT ON public.section_staff_with_institution TO service_role;

COMMIT;
