-- Make handle_new_user() a no-op.
--
-- Scholera is invite-only — public signup is disabled at the middleware
-- level. Every auth user is created by an institution admin (or super admin)
-- server action that immediately upserts a matching profiles row with the
-- right institution_id and role.
--
-- The previous version of this trigger inserted (id, email, role='student')
-- but no institution_id, which violates institution_id_required_for_non_super_admin.
-- It then silently swallowed the error via "EXCEPTION WHEN others THEN RETURN NEW",
-- which hid the failure from logs and made profile-missing bugs invisible.
--
-- The cleanest fix is to stop creating profiles in this trigger entirely.
-- Admin server actions own profile creation. If a future code path creates
-- an auth.users row without also inserting into profiles, getProfileById()
-- now logs that loudly instead of papering over it with a tenant-less row.
--
-- The trigger and function are kept (rather than dropped) so the attachment
-- point is documented and future maintainers can see this was deliberate.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  -- Intentionally no-op. See migration 00000000000057_handle_new_user_noop.sql.
  -- Profile creation is owned by institution admin / super admin server actions.
  RETURN NEW;
END;
$function$;
