-- Local-only stand-in for the production Cloud Scheduler.
--
-- Makes the local Supabase DB container call the Pulse notifications cron endpoint
-- once a minute via pg_net → the host app (host.docker.internal:3000). Runs entirely
-- inside Docker, so there's no host shell / WSL involved. This is what actually
-- delivers scheduled-assignment notifications in local dev (prod uses Cloud Scheduler).
--
-- Apply (PowerShell):
--   Get-Content scripts/dev-setup/pulse-local-cron.sql -Raw | docker exec -i supabase_db_Scholera-prod psql -U postgres -d postgres
-- Remove:
--   SELECT cron.unschedule('pulse_local_sweep');
--
-- Notes:
--   * cron.schedule upserts by name, so re-applying is safe.
--   * Local DB state — a `supabase db reset` wipes it; re-apply afterwards.
--   * The bearer secret must match NOTIFICATIONS_CRON_SECRET in .env.local.
--   * pg_cron's finest granularity is 1 minute.

SELECT cron.schedule(
  'pulse_local_sweep',
  '* * * * *',
  $$SELECT net.http_post(
      url := 'http://host.docker.internal:3000/api/notifications/cron',
      headers := '{"Authorization": "Bearer local-dev-cron-secret"}'::jsonb
    );$$
);
