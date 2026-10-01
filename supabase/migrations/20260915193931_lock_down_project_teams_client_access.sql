-- project_teams: take the private team columns and all DML away from client roles.
--
-- Two separate holes, both confirmed against production.
--
-- 1. CROSS-TEAM DISCLOSURE OF SUBMITTED COURSEWORK (live, not defence-in-depth).
--
--    The "Enrolled students can read teams" policy authorises every project_teams
--    row belonging to any project in the student's section -- deliberately, because
--    students browse the class roster of teams to find one to join. But `submission`
--    (the whole Devpost-shaped blob a team turns in) and the legacy `planning_doc`
--    are columns ON THAT SAME ROW, and row-level security cannot hide a column.
--
--    So every enrolled student could read every other team's submitted coursework
--    with one PostgREST call. Verified in prod as a real student with the anon key:
--
--      select id, name, submission from project_teams where project_id = '<a project>'
--      -> 2 rows, including a team the caller is not a member of, `submission` populated.
--
--    The RSC half of this was already found and fixed: the student project page
--    deletes both fields before handing the roster to a client component (see the
--    comment in student/.../projects/[projectId]/page.tsx). That closed the DevTools
--    payload and left the direct query wide open. A `delete rest.submission` in React
--    is not an access control.
--
-- 2. WRITE PATH WITH RLS AS THE ONLY LOCK.
--
--    "Team creators can update own teams" is `created_by = auth.uid()` with no
--    WITH CHECK and no column restriction, and Supabase's default DML grants to
--    `authenticated` were never revoked on this table. A team creator could therefore
--    UPDATE project_teams.submission directly and bypass saveSubmission/submitProject
--    entirely -- which matters because those actions hold the ONLY validation of the
--    submission's URL fields. That validation exists specifically because the
--    professor's grading view renders them as <a href>, so a `javascript:` scheme
--    stored here is a stored-XSS vector into a professor's session. Its own code
--    comment calls itself "the real guard"; it is not, if the table is writable.
--    The same path also lets already-submitted work be silently rewritten.
--
-- THE FIX
--
-- Column privileges cannot be subtracted from a table-level grant -- REVOKE SELECT
-- (col) is a no-op while the role still holds SELECT on the table. So the SELECT
-- grant is dropped and re-granted column by column. That ordering is also why the
-- keep-list is spelled out: a column added later is NOT readable by a client role
-- until someone grants it on purpose, which is the safe direction for this table.
--
-- `public` is revoked alongside anon/authenticated on purpose: revoking only the two
-- named roles leaves the privilege reachable through PUBLIC. Same reasoning, and the
-- same shape, as 20260825182750_revoke_client_dml_on_project_grading.
--
-- Nothing legitimate loses anything. Every read and write of project_teams in the
-- app goes through the admin (service_role) client inside a server action or an RSC
-- page -- verified across all 29 call sites -- and service_role is untouched here.
-- The one other policy that references this table (project_docs "Section professors
-- can read project docs") only joins on id/project_id, both of which stay granted.

-- ── 1. Private columns ────────────────────────────────────────────────
revoke select on public.project_teams from public, anon, authenticated;

grant select (
  id,
  project_id,
  created_by,
  name,
  description,
  status,
  created_at,
  updated_at,
  workspace_enabled
) on public.project_teams to authenticated;

-- `anon` is deliberately NOT granted. It held the table-wide SELECT only because
-- Supabase grants it by default, and nothing anonymous reads this table: all 29
-- call sites use the admin client. Re-granting it columns would also quietly
-- reverse the 2026-08-24 anon hardening — and worse, invisibly, because
-- information_schema.role_table_grants does not surface column-only grants, so
-- the "anon reaches nothing" invariant in src/__tests__/db would still pass.

-- ── 2. Writes are server-only ─────────────────────────────────────────
revoke insert, update, delete, truncate on public.project_teams from public, anon, authenticated;

comment on column public.project_teams.submission is
  'Team''s submitted coursework. NOT readable by client roles -- SELECT is granted column-by-column in 20260915193931 precisely to exclude this one. Read it only through the admin client after verifying team membership.';

comment on column public.project_teams.planning_doc is
  'Legacy single-string planning doc, superseded by project_docs. NOT readable by client roles (see 20260915193931).';
