-- can_author_in_section was executable by anon.
--
-- It is SECURITY DEFINER and takes the user id as a PARAMETER rather than reading auth.uid(),
-- so anyone holding the publishable anon key — which ships in the browser bundle — could POST
-- to /rest/v1/rpc/can_author_in_section with any (section_id, user_id) pair and learn whether
-- that person teaches, is enrolled in, or is an active TA for that section. No account needed.
--
-- It was the only one of the 18 policy predicate helpers with an anon grant. The other 17 are
-- authenticated-only. Postgres grants EXECUTE to PUBLIC on every new function by default, and
-- the ensure_no_anon_grants event trigger only fires on CREATE TABLE, so functions never had
-- that default stripped. src/__tests__/migration-guards.test.ts now fails any new migration
-- that creates a function without revoking it.
--
-- authenticated must KEEP execute: two policies call this helper and both evaluate as the
-- calling role, so revoking it there would break them --
--   * public.discussion_messages  "Message: can insert if channel accessible and active"
--   * storage.objects             "Chat attachments: upload"
-- Both pass auth.uid() as p_user_id, so the parameter is never used for anyone but the caller.
--
-- Revoking a privilege that is already absent is a no-op, so this is safely re-runnable.

REVOKE ALL ON FUNCTION public.can_author_in_section(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_author_in_section(uuid, uuid) FROM anon;

-- Stated explicitly rather than left to inherit, matching the revoke-then-grant pattern used
-- for is_course_member in 20260806153145_security_audit_close_cross_tenant_gaps.sql.
GRANT EXECUTE ON FUNCTION public.can_author_in_section(uuid, uuid) TO authenticated;


-- lc_add_upvote had the same default PUBLIC grant, and it is worse: it WRITES.
--
-- SECURITY DEFINER, takes p_user_id as a parameter instead of reading auth.uid(), and UPDATEs
-- lc_interactions.payload — incrementing `upvotes` and appending to `upvotedBy`. Anyone holding
-- the publishable anon key and an interaction id could therefore inflate the upvote count on a
-- live classroom question and attribute the vote to any user id they chose, with no account.
-- It also returns the interaction payload, so the same call reads the question back.
--
-- The application reaches it through the service-role client (upvoteQuestion in
-- src/lib/live-classroom/interactions/actions.ts), and its ACL carried no explicit service_role
-- grant — execute came from PUBLIC. So the grant below is REQUIRED, not decorative: revoking
-- PUBLIC without it would break upvoting.
REVOKE ALL ON FUNCTION public.lc_add_upvote(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lc_add_upvote(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.lc_add_upvote(uuid, uuid) TO service_role;

-- insert_project_phase is NOT security definer, so row-level security still applies to what it
-- writes and anon holds no table grants — a lower-severity exposure than the two above. Revoked
-- for the same reason regardless: nothing in this schema should answer to the browser's role.
-- Its callers already use the service-role client, which holds its own explicit grant.
REVOKE ALL ON FUNCTION public.insert_project_phase(uuid, uuid, text, text, text, date, date, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.insert_project_phase(uuid, uuid, text, text, text, date, date, text, uuid) FROM anon;
