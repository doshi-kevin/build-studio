-- Take the write grants away from `authenticated` on the public tables that have
-- row-level security on but no policy at all.
--
-- These 21 are the same shape user_memory was in. Row-level security denies the
-- writes today because no policy exists, so the grants are inert, with one
-- exception: TRUNCATE is a table-level privilege that no policy can hold back.
-- The rest become live the moment somebody adds a permissive write policy,
-- which is the obvious thing to do the first time a user needs to edit their
-- own row, and nothing about the table warns them.
--
-- Checked before applying, not assumed:
--   * `anon` already holds nothing on any of these. The ensure_no_anon_grants
--     event trigger has been doing its job since August.
--   * No table here is reached by a client that row-level security applies to.
--     182 files build either the cookie-based server client or the browser
--     client, and none of them reads or writes these tables. Every access is
--     through the service-role admin client, which bypasses RLS and keeps all
--     its privileges below.
--   * No SECURITY DEFINER function callable by `authenticated` runs dynamic SQL
--     on caller input, so TRUNCATE has no route today either.
--
-- SELECT is left alone. It is equally inert without a policy, and leaving it
-- means a future read policy works without a second migration to restore it.
--
-- Not fixed here, and worth its own decision: the ensure_rls and
-- ensure_no_anon_grants event triggers fire on CREATE TABLE and neither touches
-- `authenticated`, so table 22 will arrive in this same state.

revoke insert, update, delete, truncate, references on
  public.announcements,
  public.athena_artifacts,
  public.auth_rate_limits,
  public.courses,
  public.department_faculty,
  public.departments,
  public.events,
  public.extraction_jobs,
  public.invite_redirects,
  public.lc_events,
  public.lc_recording_sessions,
  public.module_dividers,
  public.module_items,
  public.modules,
  public.programs,
  public.quiz_answers,
  public.quiz_attempts,
  public.quiz_item_stats,
  public.quiz_question_assignments,
  public.quiz_questions,
  public.quizzes
from authenticated;
