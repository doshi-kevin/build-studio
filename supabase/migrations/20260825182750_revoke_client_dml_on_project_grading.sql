-- Strip client DML from the four project-grading tables (PR #656 follow-up).
--
-- 20260727201139 and 20260813130000 create these four tables, enable RLS on each,
-- and give each one SELECT-only policies. That is correct, and it is what actually
-- blocks writes today — verified against production by impersonating `authenticated`
-- with a real student's uid and attempting an INSERT into project_grade_releases:
-- it was denied, because RLS with no permissive policy for a command denies it.
--
-- What those migrations did NOT do is remove the grants. Both wrote
-- `GRANT SELECT ... TO authenticated`, but Supabase already grants the full DML set
-- to `authenticated` on new tables in `public`, and GRANT only adds. So production
-- shows INSERT, UPDATE, DELETE and TRUNCATE still held by `authenticated` on all
-- four, with RLS as the single thing standing between a student and their own
-- project grade.
--
-- That is a defence-in-depth gap rather than a live hole, and on grade tables it is
-- worth closing:
--
--   * One `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, or one future policy written
--     `FOR ALL` instead of `FOR SELECT`, converts it into a write path with no second
--     lock behind it. This repo has already shipped that exact mistake once — see
--     20260821203000, where `FOR ALL` with no WITH CHECK left challenge_submissions
--     writable straight from the browser.
--   * TRUNCATE is never subject to RLS at all. PostgREST exposes no verb that reaches
--     it, so it is not reachable today, but a granted privilege that RLS cannot govern
--     does not belong on a client role.
--
-- `public` is revoked alongside anon/authenticated on purpose: revoking only the two
-- named roles leaves the privilege reachable through PUBLIC.
--
-- Nothing legitimate loses anything. Every write to these tables goes through a
-- server action on the admin client (service_role), which these statements do not
-- touch. Reads keep working: the SELECT grant and the SELECT policies both stay.
--
-- Pattern copied from 20260807200910_course_skill_library, which got this right when
-- it created its table.

revoke insert, update, delete, truncate on public.project_master_phases  from public, anon, authenticated;
revoke insert, update, delete, truncate on public.project_phase_items    from public, anon, authenticated;
revoke insert, update, delete, truncate on public.project_item_scores    from public, anon, authenticated;
revoke insert, update, delete, truncate on public.project_grade_releases from public, anon, authenticated;
