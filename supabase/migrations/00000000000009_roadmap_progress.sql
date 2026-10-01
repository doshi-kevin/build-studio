-- Migration: Create roadmap_progress table for student progress tracking.
-- Run this in the Supabase SQL Editor.

-- Table: roadmap_progress — stores per-student, per-section roadmap progress as JSONB
CREATE TABLE IF NOT EXISTS roadmap_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  section_id UUID NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  progress JSONB NOT NULL DEFAULT '{"version":1,"nodeProgress":{},"lastAccessedAt":null}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(section_id, student_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_roadmap_progress_section ON roadmap_progress(section_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_progress_student ON roadmap_progress(student_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_progress_section_student ON roadmap_progress(section_id, student_id);

-- RLS policies
ALTER TABLE roadmap_progress ENABLE ROW LEVEL SECURITY;

-- Students can read their own progress
CREATE POLICY "Students can read own roadmap progress"
  ON roadmap_progress FOR SELECT
  USING (auth.uid() = student_id);

-- Students can insert their own progress
CREATE POLICY "Students can insert own roadmap progress"
  ON roadmap_progress FOR INSERT
  WITH CHECK (auth.uid() = student_id);

-- Students can update their own progress
CREATE POLICY "Students can update own roadmap progress"
  ON roadmap_progress FOR UPDATE
  USING (auth.uid() = student_id);

-- Professors can read progress for their course sections
CREATE POLICY "Professors can read section roadmap progress"
  ON roadmap_progress FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM course_sections cs
      WHERE cs.id = roadmap_progress.section_id
        AND cs.professor_id = auth.uid()
    )
  );
