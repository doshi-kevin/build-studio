-- Repair two RPC grant bugs found during the 2026-07-17 release verification.
-- Already applied to prod via MCP the same day; this file makes local/CI
-- replays produce the same grants.
--
-- 1. Service-only RPCs left executable via the implicit PUBLIC grant.
--    Their migrations revoked `anon, authenticated` but not PUBLIC — and
--    CREATE FUNCTION grants EXECUTE to PUBLIC by default, which anon/
--    authenticated inherit. place_roadmap_edge is SECURITY DEFINER, so RLS
--    offered no backstop (surfaced by the security advisor). The skill RPCs
--    are INVOKER (RLS-protected) but are service-only by design.
--    Rule of thumb: always revoke from PUBLIC *and* the client roles.
revoke execute on function public.place_roadmap_edge(uuid, uuid, text, uuid, double precision) from public, anon, authenticated;
revoke execute on function public._upsert_skill_node(uuid, uuid, uuid, jsonb, integer) from public, anon, authenticated;
revoke execute on function public.confirm_skill_review(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.merge_section_skill_mastery_config(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.reorder_skills(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.replace_section_skill_mastery(uuid, uuid, jsonb) from public, anon, authenticated;

-- 2. The inverse bug from 20260715191137: revoking PUBLIC on RLS-BACKING
--    functions without re-granting `authenticated` breaks every profile read
--    (42501 — get_visible_profile_ids backs the profiles SELECT policy) and
--    realtime channel authorization (lc_user_can_access_room backs the
--    realtime.messages policies) on any fresh replay. Prod already carries
--    these grants; without this line every local `migration up` produces a
--    broken environment.
grant execute on function public.get_visible_profile_ids(uuid) to authenticated;
grant execute on function public.lc_user_can_access_room(uuid, uuid) to authenticated;
