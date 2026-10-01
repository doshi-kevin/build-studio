-- Migration: Announcements v2 — scheduling, rich text, reactions, comments, mentions, read tracking
-- Run in Supabase SQL Editor
-- Created: 2026-02-21

-- ═══════════════════════════════════════════════════════════════
-- COLUMN ADDITIONS TO announcements TABLE
-- ═══════════════════════════════════════════════════════════════

-- Scheduling: expand status enum + add scheduled_at column
ALTER TABLE public.announcements
  DROP CONSTRAINT IF EXISTS announcements_status_check;

ALTER TABLE public.announcements
  ADD CONSTRAINT announcements_status_check
  CHECK (status IN ('draft', 'published', 'scheduled'));

ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP WITH TIME ZONE;

-- Rich text: JSONB column for TipTap JSON content (keep `content` as plain text fallback)
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS rich_content JSONB;

-- Visibility: controls who sees this announcement
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'all';

ALTER TABLE public.announcements
  DROP CONSTRAINT IF EXISTS announcements_visibility_check;

ALTER TABLE public.announcements
  ADD CONSTRAINT announcements_visibility_check
  CHECK (visibility IN ('all', 'mentioned_only'));

-- Toggle columns for reactions and comments
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS allow_reactions BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS allow_comments BOOLEAN NOT NULL DEFAULT false;

-- ═══════════════════════════════════════════════════════════════
-- NEW TABLES
-- ═══════════════════════════════════════════════════════════════

-- 1. announcement_reads — tracks which students have read each announcement
CREATE TABLE IF NOT EXISTS public.announcement_reads (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  announcement_id UUID NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  read_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(announcement_id, student_id)
);

-- 2. announcement_reactions — emoji reactions per student per announcement
CREATE TABLE IF NOT EXISTS public.announcement_reactions (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  announcement_id UUID NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(announcement_id, student_id, emoji)
);

-- 3. announcement_comments — comments on announcements
CREATE TABLE IF NOT EXISTS public.announcement_comments (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  announcement_id UUID NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 4. announcement_mentions — tracks which students are @-mentioned
CREATE TABLE IF NOT EXISTS public.announcement_mentions (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  announcement_id UUID NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(announcement_id, student_id)
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_announcement_reads_announcement
  ON public.announcement_reads(announcement_id);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_student
  ON public.announcement_reads(student_id);

CREATE INDEX IF NOT EXISTS idx_announcement_reactions_announcement
  ON public.announcement_reactions(announcement_id);
CREATE INDEX IF NOT EXISTS idx_announcement_reactions_student
  ON public.announcement_reactions(student_id);

CREATE INDEX IF NOT EXISTS idx_announcement_comments_announcement
  ON public.announcement_comments(announcement_id);
CREATE INDEX IF NOT EXISTS idx_announcement_comments_author
  ON public.announcement_comments(author_id);

CREATE INDEX IF NOT EXISTS idx_announcement_mentions_announcement
  ON public.announcement_mentions(announcement_id);
CREATE INDEX IF NOT EXISTS idx_announcement_mentions_student
  ON public.announcement_mentions(student_id);

-- Partial index for scheduling query
CREATE INDEX IF NOT EXISTS idx_announcements_scheduled
  ON public.announcements(status, scheduled_at)
  WHERE status = 'scheduled';

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_mentions ENABLE ROW LEVEL SECURITY;

-- announcement_reads policies
CREATE POLICY "Students can insert own reads"
  ON public.announcement_reads FOR INSERT
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "Students can read own reads"
  ON public.announcement_reads FOR SELECT
  USING (student_id = auth.uid());

CREATE POLICY "Professors can read all reads for their sections"
  ON public.announcement_reads FOR SELECT
  USING (
    announcement_id IN (
      SELECT a.id FROM public.announcements a
      JOIN public.course_sections cs ON cs.id = a.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

-- announcement_reactions policies
CREATE POLICY "Students can insert own reactions"
  ON public.announcement_reactions FOR INSERT
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "Students can delete own reactions"
  ON public.announcement_reactions FOR DELETE
  USING (student_id = auth.uid());

CREATE POLICY "Enrolled users can read reactions"
  ON public.announcement_reactions FOR SELECT
  USING (
    announcement_id IN (
      SELECT a.id FROM public.announcements a
      WHERE a.section_id IN (
        SELECT section_id FROM public.enrollments WHERE student_id = auth.uid()
      )
    )
    OR announcement_id IN (
      SELECT a.id FROM public.announcements a
      JOIN public.course_sections cs ON cs.id = a.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

-- announcement_comments policies
CREATE POLICY "Enrolled students can insert comments"
  ON public.announcement_comments FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND announcement_id IN (
      SELECT a.id FROM public.announcements a
      WHERE a.section_id IN (
        SELECT section_id FROM public.enrollments
        WHERE student_id = auth.uid() AND status = 'active'
      )
    )
  );

CREATE POLICY "Authors can update own comments"
  ON public.announcement_comments FOR UPDATE
  USING (author_id = auth.uid());

CREATE POLICY "Authors can delete own comments"
  ON public.announcement_comments FOR DELETE
  USING (author_id = auth.uid());

CREATE POLICY "Professors can delete any comment in their sections"
  ON public.announcement_comments FOR DELETE
  USING (
    announcement_id IN (
      SELECT a.id FROM public.announcements a
      JOIN public.course_sections cs ON cs.id = a.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Enrolled users and professors can read comments"
  ON public.announcement_comments FOR SELECT
  USING (
    announcement_id IN (
      SELECT a.id FROM public.announcements a
      WHERE a.section_id IN (
        SELECT section_id FROM public.enrollments WHERE student_id = auth.uid()
      )
    )
    OR announcement_id IN (
      SELECT a.id FROM public.announcements a
      JOIN public.course_sections cs ON cs.id = a.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

-- announcement_mentions policies
CREATE POLICY "Professors can manage mentions for their sections"
  ON public.announcement_mentions FOR ALL
  USING (
    announcement_id IN (
      SELECT a.id FROM public.announcements a
      JOIN public.course_sections cs ON cs.id = a.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Students can read own mentions"
  ON public.announcement_mentions FOR SELECT
  USING (student_id = auth.uid());
