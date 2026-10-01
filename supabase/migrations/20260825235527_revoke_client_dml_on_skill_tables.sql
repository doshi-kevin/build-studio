-- The three skill tables hand every logged-in user full DML, and lean on RLS alone
-- to take it back. Same gap already closed on the four project-grading tables
-- (20260825182750); this finishes the set.
--
-- Supabase grants INSERT/UPDATE/DELETE/TRUNCATE to `authenticated` by default. All
-- four policies on these tables are SELECT-only, so today RLS does deny the writes:
--
--   skills           "Professors and TAs read section skills"          SELECT
--   activity_skills  "Professors and TAs read activity-skill mappings" SELECT
--   skill_mastery    "Professors and TAs read section mastery"         SELECT
--   skill_mastery    "Students read their own mastery"                 SELECT
--
-- Two reasons that is not good enough:
--
--   1. TRUNCATE is never subject to RLS. No policy can stop it — only the grant can.
--      `authenticated` holding TRUNCATE on skill_mastery means the row-level rules
--      are simply not in the path for that one verb.
--
--   2. It is one permissive policy away from being live. The day someone adds an
--      INSERT or FOR ALL policy here — the exact mistake PR #198 made on challenges
--      — these grants make the table writable from the browser that same minute,
--      with no second lock behind it.
--
-- skill_mastery is the one that would hurt. It holds each student's own mastery
-- scores, which drive Athena's study advice and the professor's class analytics. A
-- student who could write it could rewrite what the platform believes they know.
--
-- Safe to revoke: nothing writes these from a client. Every mutating call site is a
-- server action or a server lib using the admin client, which is service_role and
-- unaffected by grants to anon/authenticated — verified across all of
-- skills/actions.ts, challenges/actions.ts, quizzes/actions.ts, live-classroom/actions.ts,
-- api/skills/recompute-sweep, lib/skills/{library,reconcile,grade-hook,roadmap-mastery}.ts
-- and lib/supabase/queries.ts. Reads are untouched, so every existing policy keeps
-- working exactly as before.

revoke insert, update, delete, truncate on public.skills          from public, anon, authenticated;
revoke insert, update, delete, truncate on public.activity_skills from public, anon, authenticated;
revoke insert, update, delete, truncate on public.skill_mastery   from public, anon, authenticated;
