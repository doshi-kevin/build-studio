-- Live Classroom: a real "class started" timestamp, and an index for the
-- paginated Class Insights gallery. (#186, #185)
--
-- started_at — the moment the professor commits the pre-class setup and the
-- class goes live in front of students (deck activated, students notified).
-- created_at is when the room SHELL was opened, often many minutes earlier
-- while a deck uploaded and rendered, so it is a noisy baseline for "did this
-- student arrive late". Attendance's late-join flag measures from started_at
-- when present.
--
-- Deliberately nullable with no backfill: rooms that ran before this column
-- existed have no start signal, and the report falls back to created_at for
-- them (their stored numbers stay as they were). A synthetic backfill would
-- invent a precision we don't have.
ALTER TABLE public.lc_rooms ADD COLUMN IF NOT EXISTS started_at timestamptz;

-- The gallery now reads ONE page of a section's ended sessions ordered by
-- created_at. The only pre-existing section index is partial on
-- status = 'live', so that read had no usable index and scanned the table.
CREATE INDEX IF NOT EXISTS idx_lc_rooms_section_created
  ON public.lc_rooms (section_id, created_at DESC);

-- No RLS change: lc_rooms already has RLS enabled (migration
-- 00000000000030_live_classroom_m1.sql) with a prof-owns-own-rooms policy and
-- an enrolled-student SELECT policy. Both scope by row, so a new column on
-- those rows is covered — no table is created here.
