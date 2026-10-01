-- #190: Secure public.audit_log_with_actor (cross-tenant audit-log leak).
--
-- The view existed only on prod (drift; not in repo migrations). It ran WITHOUT
-- security_invoker (so it bypassed RLS on events/profiles, executing as its owner
-- `postgres`) and had ALL privileges granted to anon + authenticated. Result: any
-- authenticated (possibly anon) caller could read the entire audit log + actor
-- name/email across every institution.
--
-- Investigation (read-only, prod, 2026-06-20):
--   reloptions = NULL  -> no security_invoker (RLS bypassed)
--   relacl: anon, authenticated, service_role all granted arwdDxtm (ALL)
--
-- Fix: codify the view as a tracked migration WITH security_invoker (so it honours
-- the caller's RLS on events/profiles), and restrict access to service_role (admin)
-- only. CREATE OR REPLACE so this is correct on a fresh local DB and on prod alike.

CREATE OR REPLACE VIEW public.audit_log_with_actor
  WITH (security_invoker = on) AS
  SELECT e.id,
         e.event_type,
         e.metadata,
         e."timestamp",
         e.user_id AS actor_id,
         p.name    AS actor_name,
         p.email   AS actor_email
  FROM public.events e
  LEFT JOIN public.profiles p ON p.id = e.user_id;

-- Never anon/authenticated; admin/service_role only.
REVOKE ALL ON public.audit_log_with_actor FROM anon, authenticated;
GRANT SELECT ON public.audit_log_with_actor TO service_role;
