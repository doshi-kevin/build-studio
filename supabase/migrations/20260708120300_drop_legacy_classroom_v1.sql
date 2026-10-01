-- Live Classroom v1→v2 cutover, Phase 5: drop the legacy classroom_sessions model.
--
-- The v1 8-table classroom schema (migration 00000000000007) was superseded by
-- the v2 live-classroom model (lc_rooms / lc_interactions / lc_responses, from
-- migration 00000000000030 on). The mastery engine was repointed to v2 in commit
-- bdf3e9e; the roadmap + calendar readers and the v1 UI were repointed/removed in
-- this PR. Nothing in the app reads or writes these tables anymore, and there are
-- no production users, so it's safe to drop them now (the "Phase 5" the
-- 00000000000036_lc_interactions.sql comment always planned for).
--
-- child → parent order; CASCADE also clears the tables' RLS policies, indexes,
-- triggers, and their membership in the supabase_realtime publication.

drop table if exists public.question_upvotes cascade;
drop table if exists public.session_questions cascade;
drop table if exists public.quiz_responses cascade;
drop table if exists public.live_quizzes cascade;
drop table if exists public.poll_responses cascade;
drop table if exists public.live_polls cascade;
drop table if exists public.session_participants cascade;
drop table if exists public.classroom_sessions cascade;

-- The upvote-count trigger function is orphaned once its table is gone.
drop function if exists public.update_question_upvote_count() cascade;
