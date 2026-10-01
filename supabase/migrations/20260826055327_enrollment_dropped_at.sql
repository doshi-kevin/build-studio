-- #744 — a student who unenrols disappears from the roster and the gradebook with no
-- signal, while their submissions and grades stay in the database keyed by student_id.
--
-- dropSection is already non-destructive: it only flips enrollments.status to 'dropped',
-- and re-enrolling restores everything intact. What was missing is WHEN they left. The
-- table carries `status` and `enrolled_at` and nothing else, so nothing can answer "how
-- long has this data been orphaned?" — which is exactly what a retention sweep needs to
-- decide whether a row is ready to clear.
--
-- Adds the timestamp only. The sweep itself is deliberately NOT part of this change.

alter table public.enrollments
  add column if not exists dropped_at timestamptz;

comment on column public.enrollments.dropped_at is
  'When the enrollment moved to a non-active status. NULL for active enrollments, and also '
  'NULL for rows dropped before this column existed — see the index comment.';

-- Partial, because the only query that will ever use it is the sweep looking for dropped
-- rows old enough to clear. Indexing active enrollments here would be dead weight on the
-- hottest table in the product.
create index if not exists idx_enrollments_dropped_at
  on public.enrollments (dropped_at)
  where status = 'dropped';

comment on index public.idx_enrollments_dropped_at is
  'For the future retention sweep over departed students. Deliberately NOT backfilled: rows '
  'dropped before this column existed have no true departure date, and inventing one (say, '
  'updated_at) would make the sweep delete real student work at the wrong time. A NULL '
  'dropped_at on a dropped row means "unknown" and the sweep must skip it rather than guess.';
