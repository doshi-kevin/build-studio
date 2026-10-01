-- Remove the `anon` role's blanket table privileges in schema public.
--
-- `anon` is the role Postgres uses for anyone hitting the database with the public
-- browser key and no login: any stranger on the internet. Supabase's defaults had
-- given it DELETE on 142 tables, INSERT and UPDATE on 141, and SELECT on 140, out
-- of 145.
--
-- Nothing was leaking. RLS is on for 145/145 tables, no policy reachable by anon is
-- unconditional, and an anonymous caller got either 401 or an empty array. This is
-- the missing SECOND lock, not a breach: today every table depends on its RLS policy
-- being written correctly, with nothing behind it. One policy shipped as USING (true)
-- and the data is public instantly. With no grants, the same mistake is inert.
--
-- Nothing in the app needs anon table access. Verified: no file outside
-- src/app/(dashboard) and src/app/(auth) performs any .from()/.rpc(), and the three
-- unauthenticated pages that DO read the database all use the service_role admin
-- client, which bypasses grants entirely -- /c/[publicId] certificates,
-- /i/[shortId] invite redirects, /api/feeds/[token]. Login and invites go through
-- GoTrue against the auth schema as supabase_auth_admin, and handle_new_user runs as
-- its definer, so account creation never depended on these grants.
--
-- `authenticated` is deliberately UNTOUCHED. Only anon loses privileges.

-- Don't let this queue behind a long-running query and stall live traffic.
SET LOCAL lock_timeout = '5s';

-- ══════════════════════════════════════════════════════════════════
-- 1. Remove what exists (all 145 tables, 1 sequence)
-- ══════════════════════════════════════════════════════════════════

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- ══════════════════════════════════════════════════════════════════
-- 2. Stop it coming back on the next migration
-- ══════════════════════════════════════════════════════════════════
-- Root cause: pg_default_acl carries default ACLs in schema public granting anon
-- arwdDxtm on every NEW table. Without this, the hole reopens the next time anyone
-- creates a table. Registered per granting role; migrations run as postgres.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- ══════════════════════════════════════════════════════════════════
-- 3. Safety net for the default ACL we cannot alter
-- ══════════════════════════════════════════════════════════════════
-- There is a SECOND default ACL owned by supabase_admin, and postgres is not a
-- member of that role, so ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin is not
-- available to us. A table created by supabase_admin (which is what the Supabase
-- Dashboard Table Editor uses, as opposed to a migration) would therefore still
-- arrive with full anon privileges, silently.
--
-- Same mechanism this schema already uses for the identical class of problem:
-- rls_auto_enable + the `ensure_rls` event trigger (00000000000070) auto-enable RLS
-- on every new public table. This is that pattern applied to grants.
--
-- Caveat, stated rather than hidden: REVOKE requires ownership, so if a new table is
-- owned by a role postgres cannot revoke on, the attempt fails. It is caught and
-- logged rather than raised, because an event trigger must NEVER be able to block a
-- CREATE TABLE. Treat the advisor as the backstop, not this.

CREATE OR REPLACE FUNCTION public.anon_grants_auto_revoke()
  RETURNS event_trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table', 'partitioned table')
  LOOP
    IF cmd.schema_name = 'public' THEN
      BEGIN
        EXECUTE format('revoke all on table %s from anon', cmd.object_identity);
        RAISE LOG 'anon_grants_auto_revoke: revoked anon grants on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'anon_grants_auto_revoke: could not revoke anon grants on % (%)',
            cmd.object_identity, SQLERRM;
      END;
    END IF;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.anon_grants_auto_revoke() IS
  'Strips anon privileges from every newly created table in public. Exists because the supabase_admin default ACL still grants them and cannot be altered as postgres. Companion to rls_auto_enable; failures are logged, never raised, so this can never block a CREATE TABLE.';

DROP EVENT TRIGGER IF EXISTS ensure_no_anon_grants;
CREATE EVENT TRIGGER ensure_no_anon_grants ON ddl_command_end
  EXECUTE FUNCTION public.anon_grants_auto_revoke();

-- Kept on purpose: anon USAGE on schema public (PostgREST needs it to serve
-- authenticated traffic), and anon EXECUTE on the 16 remaining SECURITY INVOKER
-- functions -- those run with the caller's privileges, so with no table grants left
-- they are inert for anon.

-- NOT DONE HERE, deliberately: this function is itself SECURITY DEFINER and so is
-- still anon-executable, because the FUNCTIONS default ACL was left alone. Calling an
-- event-trigger function over /rpc/ just errors, so it is untidy rather than a data
-- path, but it does leave one anon advisory outstanding. The fix, if wanted, is:
--   REVOKE EXECUTE ON FUNCTION public.anon_grants_auto_revoke() FROM public, anon, authenticated;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
-- Left out so this file matches exactly what is applied to production.
