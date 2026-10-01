-- Live Classroom v1→v2 cutover, part 1: scheduling on lc_rooms.
--
-- The legacy classroom_sessions model (being retired) supported *scheduling* a
-- session ahead of time (scheduled_start / scheduled_end, status='scheduled').
-- lc_rooms was live-only (created at go-live, status live|ended). To let the
-- roadmap + calendar show a planned session BEFORE it goes live, add the two
-- scheduling columns and a 'scheduled' status. Purely additive; existing rooms
-- and the create-at-go-live path (default status 'live') are unaffected.

alter table public.lc_rooms
  add column if not exists scheduled_start timestamptz,
  add column if not exists scheduled_end   timestamptz;

-- Widen the status CHECK to include 'scheduled' (data-preserving DROP/ADD, never
-- a table recreate). Default remains 'live' so the go-live path is unchanged.
alter table public.lc_rooms drop constraint if exists lc_rooms_status_check;
alter table public.lc_rooms
  add constraint lc_rooms_status_check
  check (status in ('scheduled', 'live', 'ended'));

-- Roadmap/calendar list a section's scheduled rooms by time.
create index if not exists idx_lc_rooms_section_scheduled
  on public.lc_rooms (section_id, scheduled_start)
  where scheduled_start is not null;

-- RLS is unchanged: the existing "prof manages own rooms" (FOR ALL) covers
-- creating/starting a scheduled room, and "students view rooms in enrolled
-- sections" (FOR SELECT) already exposes every status, so a scheduled room shows
-- on the student roadmap/calendar. No new policy needed.
