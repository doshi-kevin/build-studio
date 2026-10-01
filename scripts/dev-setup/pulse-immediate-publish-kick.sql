-- Local-only immediate-publish kick (Scholera Pulse).
--
-- Makes scheduled assignment/quiz notifications fire the INSTANT the item flips to
-- published, instead of waiting for the next /api/notifications/cron poll. A trigger on
-- the scheduled→published transition calls the cron endpoint (publish sweeps only) right
-- then, via pg_net → the host app.
--
-- This is the LOCAL stand-in for what production will do once the Cloud Scheduler OIDC
-- auth lands on /api/notifications/cron (which fails closed in prod today). Same shape as
-- pulse-local-cron.sql: runs inside Docker, hardcodes the local dev URL + secret.
--
-- Apply (PowerShell):
--   Get-Content scripts/dev-setup/pulse-immediate-publish-kick.sql -Raw | docker exec -i supabase_db_Scholera-prod psql -U postgres -d postgres
-- Remove:
--   DROP TRIGGER IF EXISTS trg_pulse_kick_publish ON public.assignments;
--   DROP TRIGGER IF EXISTS trg_pulse_kick_publish ON public.quizzes;
--   DROP FUNCTION IF EXISTS public.pulse_kick_publish_notification();
--
-- Notes:
--   * The poll sweep (pulse-local-sweep.sh / pulse-local-cron.sql) stays as a BACKSTOP —
--     if a kick is missed (app down), the next poll still delivers. Both are idempotent
--     (each atomically claims only published-but-unnotified rows).
--   * The bearer secret must match NOTIFICATIONS_CRON_SECRET in .env.local.
--   * Local DB state — a `supabase db reset` wipes it; re-apply afterwards.

CREATE OR REPLACE FUNCTION public.pulse_kick_publish_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  -- Fire only on a genuine transition INTO published that no inline path already
  -- notified. Inline publishes stamp publish_notified_at in the same UPDATE, so they
  -- arrive here with it NOT NULL and are skipped (no double-notify). The pg_cron
  -- scheduled flip leaves it NULL → this kicks the sweep to fan out immediately.
  IF NEW.status = 'published'
     AND OLD.status IS DISTINCT FROM 'published'
     AND NEW.publish_notified_at IS NULL THEN
    PERFORM net.http_post(
      url := 'http://host.docker.internal:3000/api/notifications/cron?publishOnly=1',
      headers := '{"Authorization": "Bearer local-dev-cron-secret"}'::jsonb
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_pulse_kick_publish ON public.assignments;
CREATE TRIGGER trg_pulse_kick_publish
  AFTER UPDATE OF status ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.pulse_kick_publish_notification();

DROP TRIGGER IF EXISTS trg_pulse_kick_publish ON public.quizzes;
CREATE TRIGGER trg_pulse_kick_publish
  AFTER UPDATE OF status ON public.quizzes
  FOR EACH ROW EXECUTE FUNCTION public.pulse_kick_publish_notification();
