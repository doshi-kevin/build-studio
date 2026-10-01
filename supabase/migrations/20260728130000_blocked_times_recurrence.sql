-- Recurring calendar entries: a professor "Add event" (lecture, seminar, etc.) can repeat
-- weekly on the weekday of its start date, until an optional end date. Both columns are
-- additive with safe defaults, so every existing row stays a one-off ('none') and behavior
-- is unchanged. No RLS change here (see the companion busy-times migration). blocked_times
-- is small (per-professor), so no new index is warranted.

ALTER TABLE public.blocked_times
  ADD COLUMN IF NOT EXISTS recurrence TEXT NOT NULL DEFAULT 'none'
    CHECK (recurrence IN ('none', 'weekly')),
  ADD COLUMN IF NOT EXISTS recurrence_until DATE;
