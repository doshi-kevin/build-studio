-- #667 — "Mark all as read" inflated the professor's view receipts.
--
-- One table answers two different questions and could not tell them apart:
--   • the STUDENT's "is this unread?" badge
--   • the PROFESSOR's "who has actually viewed this?"
--
-- markAllAnnouncementsRead writes a row for every visible announcement, so one click
-- on a nav-badge convenience registered the student as having viewed announcements they
-- never opened. The professor is then shown view data that is not true, and acts on it
-- — chasing students who did read, or trusting a number that says a notice landed when
-- nobody looked at it.
--
-- Recording HOW the row was created keeps both answers correct from one table: the
-- student's badge counts any row (bulk-clearing genuinely means "don't show me this as
-- new"), while the professor's count considers only rows from an actual open.
--
-- Defaults to false so existing rows keep counting as views. That is the honest
-- treatment of history: those rows predate the distinction and we cannot know which
-- were bulk-cleared, and silently reclassifying them would swing every historical
-- receipt downward with no way to tell why.

alter table public.announcement_reads
  add column if not exists via_bulk boolean not null default false;

comment on column public.announcement_reads.via_bulk is
  'True when the row came from "Mark all as read" rather than opening the announcement. The professor''s view receipts must exclude these — a bulk clear is not a view (#667). Rows predating this column default to false and keep counting.';

-- The professor's receipt query filters on this, per announcement.
create index if not exists idx_announcement_reads_view_receipts
  on public.announcement_reads (announcement_id)
  where via_bulk = false;
