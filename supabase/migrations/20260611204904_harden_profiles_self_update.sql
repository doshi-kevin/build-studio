-- Harden self-service profile updates against privilege escalation / tenant takeover.
--
-- VULNERABILITY (security review 2026-06-11, Vuln 1):
--   The base-schema policy
--     CREATE POLICY "Users can update own profile" ON profiles
--       FOR UPDATE USING (auth.uid() = id);
--   has NO `with check`. Postgres reuses the `using` expression as the post-update
--   row check when `with check` is absent, and `auth.uid() = id` still holds after a
--   user edits ANY other column of their own row. Because the publishable/anon key
--   reaches PostgREST directly from the browser, an authenticated user could
--     PATCH /rest/v1/profiles?id=eq.<self> { "role":"institution_admin",
--                                            "institution_id":"<any tenant>" }
--   and become institution-admin of any tenant (is_admin_of() trusts profiles.role
--   and profiles.institution_id). No later migration closed this.
--
-- FIX:
--   1. Add `with check (auth.uid() = id)` to the self-update policy (prevents
--      reassigning a row to another id).
--   2. Add a BEFORE UPDATE trigger that rejects any change to `role` or
--      `institution_id` unless the caller is the service role / an internal
--      Postgres role. A row-level `with check` cannot enforce this — it only sees
--      the NEW row and cannot compare against OLD — so column immutability must be
--      enforced in a trigger (same pattern as the tenant-guard triggers in
--      migrations 55/56).
--
--   All legitimate writes to role/institution_id go through server actions using
--   the service-role client (createAdminClient), so the bypass below preserves every
--   real flow while blocking the browser-reachable escalation path.

BEGIN;

-- 1. Self-update policy gains a with-check.
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- 2. Drop the client-facing INSERT policy. It was FOR INSERT WITH CHECK
--    (auth.uid() = id), which — now that handle_new_user is a noop (migration
--    057) — let an authenticated user whose profiles row doesn't exist yet
--    POST /rest/v1/profiles with role='institution_admin' + any institution_id,
--    re-opening Vuln 1 at row-creation time. No session-client code path inserts
--    profiles; legitimate creation (invite/onboarding) uses the service-role
--    client, which bypasses RLS. So remove the policy entirely.
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;

-- 3. Column-immutability guard for role & institution_id, on INSERT and UPDATE.
CREATE OR REPLACE FUNCTION public.prevent_profile_privilege_escalation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Trusted server-side / internal callers may set/change role & institution_id.
  -- auth.role() reads the JWT role claim and survives SECURITY DEFINER context;
  -- the current_user list is a belt-and-suspenders fallback so no internal write
  -- is ever blocked.
  IF coalesce(auth.role(), '') = 'service_role'
     OR current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  -- INSERT: a non-service-role caller may only ever create a plain student row.
  -- (Defense in depth — the INSERT policy above is dropped, so RLS already
  --  denies these; this also guards against a future INSERT policy being added.)
  IF TG_OP = 'INSERT' THEN
    IF NEW.role IS DISTINCT FROM 'student' THEN
      RAISE EXCEPTION 'Creating a profile with an elevated role is not permitted'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: role and institution_id are immutable to non-service-role callers.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Changing profile role is not permitted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.institution_id IS DISTINCT FROM OLD.institution_id THEN
    RAISE EXCEPTION 'Changing profile institution is not permitted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_profile_privilege_escalation ON public.profiles;
CREATE TRIGGER prevent_profile_privilege_escalation
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_profile_privilege_escalation();

COMMIT;
