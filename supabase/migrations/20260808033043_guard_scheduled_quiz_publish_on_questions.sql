-- #311 item 4: a scheduled quiz with no questions (or with an incomplete one) went
-- live to students.
--
-- Scheduled publish has three writers: the professor quiz list, the student quiz
-- list, and the one-time pg_cron job scheduled by schedule_quiz_publish(). The two
-- app paths now apply the same gate publishQuiz enforces (see
-- src/lib/quiz/auto-publish.ts). This migration puts the identical rule in the
-- cron job's SQL — the path that actually fires FIRST, at the scheduled instant,
-- before any page load, and therefore the one that mattered most.
--
-- Only the FORMAT'ed UPDATE inside cron.schedule changes; the rest of the function
-- is reproduced verbatim so this stays a faithful CREATE OR REPLACE.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, no data change, no RLS impact (the
-- function is SECURITY DEFINER, unchanged, and touches only public.quizzes).
--
-- KNOWN GAP: jobs already registered in cron.job carry the OLD SQL text, which was
-- baked in when they were scheduled. They keep publishing unguarded until the quiz
-- is re-saved (which re-runs this trigger and re-schedules with the new SQL).
-- Deliberately not rewriting live cron.job rows here — that is a data migration
-- over a system catalog and deserves its own change.

CREATE OR REPLACE FUNCTION public.schedule_quiz_publish()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  cron_expr TEXT;
  job_name TEXT;
BEGIN
  job_name := 'publish-quiz-' || NEW.id;

  -- Always cancel any existing pending publish job for this quiz
  BEGIN
    PERFORM cron.unschedule(job_name);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- job didn't exist, that's fine
  END;

  -- Schedule a new one-time job only if a future scheduled time is set and quiz is draft
  IF NEW.scheduled_publish_at IS NOT NULL AND NEW.status = 'draft' THEN
    cron_expr := CONCAT(
      EXTRACT(MINUTE FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' ',
      EXTRACT(HOUR   FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' ',
      EXTRACT(DAY    FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' ',
      EXTRACT(MONTH  FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' *'
    );

    -- Cron job only does the UPDATE — no self-unschedule.
    -- The AFTER UPDATE trigger fires when scheduled_publish_at becomes NULL,
    -- which calls cron.unschedule() to clean up the job automatically.
    --
    -- The two EXISTS clauses are the publish gate: at least one assigned question,
    -- and none of them incomplete. A quiz that fails stays a draft with its
    -- schedule intact, so re-saving it once the questions are finished
    -- re-schedules the job and it publishes then.
    PERFORM cron.schedule(job_name, cron_expr, FORMAT(
      $sql$
        UPDATE quizzes
        SET status = 'published',
            scheduled_publish_at = NULL,
            updated_at = NOW()
        WHERE id = '%s'
          AND status = 'draft'
          AND EXISTS (
            SELECT 1
            FROM quiz_question_assignments a
            WHERE a.quiz_id = quizzes.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM quiz_question_assignments a
            JOIN quiz_questions q ON q.id = a.question_id
            WHERE a.quiz_id = quizzes.id
              AND q.is_complete = FALSE
          );
      $sql$,
      NEW.id
    ));
  END IF;

  RETURN NEW;
END;
$function$;
