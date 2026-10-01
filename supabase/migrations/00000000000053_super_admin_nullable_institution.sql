-- super_admins are platform-tier — they manage every institution, not one.
-- Pre-this-migration: profiles.institution_id was NOT NULL (added in mig 44),
-- which forced super_admins into a hack-tenant assignment (the original
-- super_admin was tagged as Stevens, which is wrong — they aren't a Stevens
-- user). Worse, inviteSuperAdmin couldn't insert NULL, so every invite
-- failed with a NOT NULL violation.
--
-- Fix:
--   • Drop NOT NULL on profiles.institution_id.
--   • Add a CHECK constraint that REQUIRES institution_id for every role
--     OTHER than super_admin. Tenant tagging is still enforced for
--     institution_admins, professors, students, and course_assistants —
--     the only carve-out is platform-tier super_admins.
--   • Backfill: clear the existing super_admin's institution_id to NULL
--     so the data matches the semantics.

BEGIN;

ALTER TABLE public.profiles
  ALTER COLUMN institution_id DROP NOT NULL;

ALTER TABLE public.profiles
  ADD CONSTRAINT institution_id_required_for_non_super_admin
  CHECK (institution_id IS NOT NULL OR role = 'super_admin');

UPDATE public.profiles
   SET institution_id = NULL
 WHERE role = 'super_admin';

COMMIT;
