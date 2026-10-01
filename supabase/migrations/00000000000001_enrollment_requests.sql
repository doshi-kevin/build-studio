-- Migration: Create enrollment_requests table for Smart Enrollment System
-- Run this against your Supabase SQL editor.

-- 1. Create table
CREATE TABLE IF NOT EXISTS public.enrollment_requests (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  rejection_reason TEXT,
  reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(section_id, student_id)
);

-- 2. Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_enrollment_requests_section ON public.enrollment_requests(section_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_requests_student ON public.enrollment_requests(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_requests_status ON public.enrollment_requests(status);

-- 3. Enable RLS
ALTER TABLE public.enrollment_requests ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies
CREATE POLICY "Students can read own enrollment requests"
  ON public.enrollment_requests FOR SELECT
  USING (student_id = auth.uid());

CREATE POLICY "Students can insert own enrollment requests"
  ON public.enrollment_requests FOR INSERT
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "Students can update own rejected requests"
  ON public.enrollment_requests FOR UPDATE
  USING (student_id = auth.uid() AND status = 'rejected');

CREATE POLICY "Professors can read section enrollment requests"
  ON public.enrollment_requests FOR SELECT
  USING (
    section_id IN (
      SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
    )
  );

CREATE POLICY "Professors can update section enrollment requests"
  ON public.enrollment_requests FOR UPDATE
  USING (
    section_id IN (
      SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
    )
  );
