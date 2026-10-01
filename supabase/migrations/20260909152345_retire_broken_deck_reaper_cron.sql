-- Retire lc_decks_orphan_reaper. It never worked, and it never could.
--
-- The job ran nightly at 03:00 from 2026-04-29 and failed all 134 times with:
--
--   ERROR: Direct deletion from storage tables is not allowed.
--          Use the Storage API instead.
--   HINT:  This prevents accidental data loss from orphaned objects.
--   CONTEXT: PL/pgSQL function storage.protect_delete()
--
-- lc_reap_orphan_decks() did `DELETE FROM storage.objects`, which Supabase blocks
-- with a trigger. No amount of fixing the WHERE clause helps: storage rows can
-- only be removed through the Storage API. Because it was broken from its first
-- run there was never a working state to regress from, so nothing alerted and
-- 5,213 files (662 MB) accumulated before anyone looked.
--
-- Replaced by POST /api/live-classroom/reap-decks, on Google Cloud Scheduler
-- next to the other two sweeps. That endpoint reads the rooms worth KEEPING and
-- deletes the rest through `storage.from(bucket).remove()`, in bounded batches.
--
-- Deliberately dropping the function too, not just unscheduling the job. Leaving
-- a callable function that always throws is a trap for the next person who finds
-- it and assumes it works.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'lc_decks_orphan_reaper') then
    perform cron.unschedule('lc_decks_orphan_reaper');
  end if;
end $$;

drop function if exists public.lc_reap_orphan_decks();
