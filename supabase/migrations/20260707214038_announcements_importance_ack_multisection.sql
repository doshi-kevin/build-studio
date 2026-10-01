-- Migration: Announcements — importance flag, required acknowledgement, multi-section posting
--
-- Adds three capabilities to the existing announcements feature:
--   1. Importance    — an is_important flag driving stronger visual treatment.
--   2. Acknowledgement — requires_acknowledgement on the announcement + an
--      acknowledged_at timestamp on announcement_reads. Passive read tracking
--      (read_at) and active acknowledgement (acknowledged_at) are kept as
--      separate columns on purpose: reading is fired on view, acknowledgement
--      is an intentional click.
--   3. Multi-section — parent_announcement_id links the per-section copies that
--      a professor creates in one "post to multiple sections" action, so a
--      later edit can sync content across the whole group. Comments/reactions/
--      reads are NEVER synced (each section keeps its own child rows).
--
-- No new tables, so no new RLS tables. announcements stays deny-all (admin
-- client only); announcement_reads already has correct per-student/per-professor
-- policies that cover the new acknowledged_at column.

-- ── announcements: importance + acknowledgement + multi-section link ──────────
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS is_important BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_acknowledgement BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS parent_announcement_id UUID
    REFERENCES public.announcements(id) ON DELETE SET NULL;

-- Group lookups (fetch all copies of a multi-section post) filter on parent id.
CREATE INDEX IF NOT EXISTS idx_announcements_parent
  ON public.announcements(parent_announcement_id)
  WHERE parent_announcement_id IS NOT NULL;

-- ── announcement_reads: acknowledgement timestamp ────────────────────────────
ALTER TABLE public.announcement_reads
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP WITH TIME ZONE;

-- ── Perf: wrap auth.uid() in a scalar subquery on announcement_reads policies ─
-- Per data-access rules, `auth.uid()` re-evaluates per row; `(select auth.uid())`
-- runs once per query (auth_rls_initplan advisor). This table now gets more
-- writes (acknowledgements), so tighten it while we're here. Policy logic is
-- unchanged — only the wrapping differs.
DROP POLICY IF EXISTS "Students can insert own reads" ON public.announcement_reads;
CREATE POLICY "Students can insert own reads"
  ON public.announcement_reads FOR INSERT
  WITH CHECK (student_id = (select auth.uid()));

DROP POLICY IF EXISTS "Students can read own reads" ON public.announcement_reads;
CREATE POLICY "Students can read own reads"
  ON public.announcement_reads FOR SELECT
  USING (student_id = (select auth.uid()));

DROP POLICY IF EXISTS "Professors can read all reads for their sections" ON public.announcement_reads;
CREATE POLICY "Professors can read all reads for their sections"
  ON public.announcement_reads FOR SELECT
  USING (
    announcement_id IN (
      SELECT a.id FROM public.announcements a
      JOIN public.course_sections cs ON cs.id = a.section_id
      WHERE cs.professor_id = (select auth.uid())
    )
  );
