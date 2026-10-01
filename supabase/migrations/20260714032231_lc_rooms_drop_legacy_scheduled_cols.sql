-- Retire the branch's basic scheduling columns (scheduled_start / scheduled_end),
-- superseded by main's recurring scheduling (scheduled_at + recurrence_group_id)
-- when feature/roadmap-all-resources merged main. All app reads were repointed to
-- scheduled_at, so these columns are now dead. No new table/RLS surface here.
--
-- Also fixes a merge artifact: BOTH scheduling migrations created an index named
-- idx_lc_rooms_section_scheduled. The branch's (on scheduled_start) applied first,
-- so main's (on scheduled_at) was silently skipped via CREATE INDEX IF NOT EXISTS —
-- leaving main's scheduled_at queries (getUpcomingScheduledRooms + the roadmap /
-- calendar reads) UNINDEXED. Drop the stale index and columns, then rebuild the
-- index on scheduled_at to match main's intent.

drop index if exists public.idx_lc_rooms_section_scheduled;

alter table public.lc_rooms
  drop column if exists scheduled_start,
  drop column if exists scheduled_end;

create index if not exists idx_lc_rooms_section_scheduled
  on public.lc_rooms (section_id, scheduled_at)
  where scheduled_at is not null;
