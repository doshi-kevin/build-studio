-- Classroom Realtime Fix: REPLICA IDENTITY FULL
--
-- Supabase Realtime's postgres_changes requires REPLICA IDENTITY FULL on
-- tables when UPDATE/DELETE events are filtered by non-PK columns. The
-- classroom hooks subscribe with filter `session_id=eq.<sessionId>`, and
-- session_id is not the primary key, so without this setting the realtime
-- server silently drops UPDATE/DELETE events because it only receives the
-- primary key of the old row in the WAL.
--
-- Symptom that triggered this fix: professor opens a poll (UPDATE sets
-- is_active=true) but students never see it; student leave events don't
-- reach the professor.

ALTER TABLE public.classroom_sessions   REPLICA IDENTITY FULL;
ALTER TABLE public.session_participants REPLICA IDENTITY FULL;
ALTER TABLE public.live_polls           REPLICA IDENTITY FULL;
ALTER TABLE public.poll_responses       REPLICA IDENTITY FULL;
ALTER TABLE public.live_quizzes         REPLICA IDENTITY FULL;
ALTER TABLE public.quiz_responses       REPLICA IDENTITY FULL;
ALTER TABLE public.session_questions    REPLICA IDENTITY FULL;
ALTER TABLE public.question_upvotes     REPLICA IDENTITY FULL;
