-- Publish scheduled assignments at their EXACT scheduled time.
--
-- Assignments previously only had the */5 `publish_scheduled_assignments` poller,
-- which lags up to 5 minutes. Quizzes already publish exactly on time via a
-- per-item one-time pg_cron job (see schedule_quiz_publish in migration 70). This
-- mirrors that mechanism for assignments: a trigger schedules a one-time cron job
-- at the assignment's exact scheduled_publish_at.
--
-- The */5 poller stays as a safety-net backstop (idempotent — whichever fires
-- first publishes; the other's WHERE status='scheduled' then matches nothing).
-- The one-time job leaves publish_notified_at NULL, so the notification sweep
-- still fans out normally.

CREATE OR REPLACE FUNCTION public.schedule_assignment_publish()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  cron_expr TEXT;
  job_name TEXT;
BEGIN
  job_name := 'publish-assignment-' || NEW.id;

  -- Always cancel any existing pending publish job for this assignment.
  BEGIN
    PERFORM cron.unschedule(job_name);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- job didn't exist, that's fine
  END;

  -- Schedule a one-time job only when a future publish time is set and the
  -- assignment is still scheduled.
  IF NEW.scheduled_publish_at IS NOT NULL AND NEW.status = 'scheduled' THEN
    cron_expr := CONCAT(
      EXTRACT(MINUTE FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' ',
      EXTRACT(HOUR   FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' ',
      EXTRACT(DAY    FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' ',
      EXTRACT(MONTH  FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' *'
    );

    -- The job only does the UPDATE. When it flips the row to published,
    -- scheduled_publish_at becomes NULL, which re-fires this AFTER-UPDATE trigger
    -- and unschedules the job above — self-cleaning, same as quizzes.
    -- %L quotes/escapes the value (quote_literal) per security-migrations.md, rather
    -- than relying on NEW.id being a uuid.
    PERFORM cron.schedule(job_name, cron_expr, FORMAT(
      $sql$
        UPDATE assignments
        SET status = 'published',
            published_at = NOW(),
            scheduled_publish_at = NULL,
            updated_at = NOW()
        WHERE id = %L
          AND status = 'scheduled';
      $sql$,
      NEW.id
    ));
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_schedule_assignment_publish ON public.assignments;
CREATE TRIGGER trg_schedule_assignment_publish
  AFTER INSERT OR UPDATE OF scheduled_publish_at, status ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.schedule_assignment_publish();
