-- Give calendar events (blocked_times) the same course + meeting-mode fields office hours
-- already have, so a lecture can carry its course and an In-person / Zoom / Hybrid location.
-- All additive with safe defaults, mirroring public.office_hours exactly; existing rows keep
-- working (course_id NULL, no meeting mode). meeting_type is nullable — a personal block has
-- no mode. No RLS change (the note-free student busy-times RPC returns only time ranges, so
-- these new columns are never exposed to students).

ALTER TABLE public.blocked_times
  ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS course_name TEXT,
  ADD COLUMN IF NOT EXISTS course_code TEXT,
  ADD COLUMN IF NOT EXISTS meeting_type TEXT
    CHECK (meeting_type IS NULL OR meeting_type IN ('in_person', 'zoom', 'hybrid')),
  ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoom_link TEXT NOT NULL DEFAULT '';

-- FK columns aren't auto-indexed; index course_id so the ON DELETE SET NULL cleanup when a
-- course is removed doesn't scan the table (per .claude/rules/data-access.md).
CREATE INDEX IF NOT EXISTS idx_blocked_times_course_id ON public.blocked_times(course_id);
