-- Revoke anon EXECUTE on roadmap_set_node_checkoff.
--
-- 20260619143157 created it and 20260713120000 replaced it. Both ran
--   revoke all on function ... from public;
--   grant execute on function ... to authenticated, service_role;
-- Supabase's default privileges grant EXECUTE on every new function in public to
-- anon explicitly, not through PUBLIC, so revoking from PUBLIC left anon's own
-- grant in place. Anyone holding the publishable key could call
-- /rest/v1/rpc/roadmap_set_node_checkoff.
--
-- Impact was small: the function is SECURITY INVOKER, so RLS on roadmap_progress
-- still applied and anon has no table privileges there. It is still a write RPC
-- open to unauthenticated callers, and src/__tests__/db/grants-and-policy-shape.test.ts
-- ("cannot execute any function in the public schema") fails on it.
--
-- The only caller is setMyNodeCheckedOff in
-- src/app/(dashboard)/student/courses/[sectionId]/roadmap/actions.ts, which uses
-- the service-role client after verifyEnrollment. authenticated keeps EXECUTE, as
-- the original migration intended.
--
-- REVOKE and GRANT are idempotent, so re-running this file changes nothing.

revoke all on function public.roadmap_set_node_checkoff(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.roadmap_set_node_checkoff(uuid, uuid, text, boolean) to authenticated, service_role;
