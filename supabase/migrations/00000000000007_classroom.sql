-- Migration: Create Classroom Mode tables
-- Run this against your Supabase SQL editor.
-- Created: 2026-02-21

-- ═══════════════════════════════════════════════════════════════
-- 8 TABLES for live classroom sessions
-- ═══════════════════════════════════════════════════════════════

-- 1. classroom_sessions — the central entity, scoped to a course section
CREATE TABLE IF NOT EXISTS public.classroom_sessions (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scheduled_start TIMESTAMP WITH TIME ZONE NOT NULL,
  scheduled_end TIMESTAMP WITH TIME ZONE NOT NULL,
  actual_start TIMESTAMP WITH TIME ZONE,
  actual_end TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'live', 'ended', 'cancelled')),
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 2. session_participants — tracks student join/leave/heartbeat
CREATE TABLE IF NOT EXISTS public.session_participants (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES public.classroom_sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  left_at TIMESTAMP WITH TIME ZONE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  heartbeat_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(session_id, student_id)
);

-- 3. live_polls — professor-created polls within a session
CREATE TABLE IF NOT EXISTS public.live_polls (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES public.classroom_sessions(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  poll_type TEXT NOT NULL DEFAULT 'single_choice'
    CHECK (poll_type IN ('single_choice', 'multiple_choice', 'word_cloud')),
  choices JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT false,
  opened_at TIMESTAMP WITH TIME ZONE,
  closed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 4. poll_responses — one response per student per poll
CREATE TABLE IF NOT EXISTS public.poll_responses (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  poll_id UUID NOT NULL REFERENCES public.live_polls(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  response JSONB NOT NULL,
  submitted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(poll_id, student_id)
);

-- 5. live_quizzes — short quizzes pushed during a session
CREATE TABLE IF NOT EXISTS public.live_quizzes (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES public.classroom_sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  time_limit_seconds INTEGER NOT NULL DEFAULT 60,
  is_active BOOLEAN NOT NULL DEFAULT false,
  opened_at TIMESTAMP WITH TIME ZONE,
  closed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 6. quiz_responses — one response per student per quiz
CREATE TABLE IF NOT EXISTS public.quiz_responses (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_id UUID NOT NULL REFERENCES public.live_quizzes(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  score NUMERIC,
  submitted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(quiz_id, student_id)
);

-- 7. session_questions — student Q&A inbox
CREATE TABLE IF NOT EXISTS public.session_questions (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES public.classroom_sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  upvote_count INTEGER NOT NULL DEFAULT 0,
  is_answered BOOLEAN NOT NULL DEFAULT false,
  answered_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 8. question_upvotes — one upvote per student per question
CREATE TABLE IF NOT EXISTS public.question_upvotes (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_id UUID NOT NULL REFERENCES public.session_questions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  UNIQUE(question_id, student_id)
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_classroom_sessions_section
  ON public.classroom_sessions(section_id);

CREATE INDEX IF NOT EXISTS idx_classroom_sessions_status_start
  ON public.classroom_sessions(status, scheduled_start)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_session_participants_session
  ON public.session_participants(session_id);

CREATE INDEX IF NOT EXISTS idx_session_participants_student
  ON public.session_participants(student_id);

CREATE INDEX IF NOT EXISTS idx_live_polls_session
  ON public.live_polls(session_id);

CREATE INDEX IF NOT EXISTS idx_live_polls_active
  ON public.live_polls(session_id, is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_poll_responses_poll
  ON public.poll_responses(poll_id);

CREATE INDEX IF NOT EXISTS idx_live_quizzes_session
  ON public.live_quizzes(session_id);

CREATE INDEX IF NOT EXISTS idx_live_quizzes_active
  ON public.live_quizzes(session_id, is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_quiz_responses_quiz
  ON public.quiz_responses(quiz_id);

CREATE INDEX IF NOT EXISTS idx_session_questions_session
  ON public.session_questions(session_id);

CREATE INDEX IF NOT EXISTS idx_question_upvotes_question
  ON public.question_upvotes(question_id);

-- ═══════════════════════════════════════════════════════════════
-- TRIGGER: Auto-update upvote_count on session_questions
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.update_question_upvote_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.session_questions
      SET upvote_count = upvote_count + 1
      WHERE id = NEW.question_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.session_questions
      SET upvote_count = upvote_count - 1
      WHERE id = OLD.question_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_question_upvote_count ON public.question_upvotes;
CREATE TRIGGER trg_question_upvote_count
  AFTER INSERT OR DELETE ON public.question_upvotes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_question_upvote_count();

-- ═══════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.classroom_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_quizzes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_upvotes ENABLE ROW LEVEL SECURITY;

-- ── classroom_sessions ──

CREATE POLICY "Professors can manage sessions for their sections"
  ON public.classroom_sessions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = classroom_sessions.section_id
        AND cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Students can view sessions in enrolled sections"
  ON public.classroom_sessions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.section_id = classroom_sessions.section_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled', 'completed')
    )
  );

-- ── session_participants ──

CREATE POLICY "Professors can view participants in their sessions"
  ON public.session_participants FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.classroom_sessions cs
      JOIN public.course_sections sect ON sect.id = cs.section_id
      WHERE cs.id = session_participants.session_id
        AND sect.professor_id = auth.uid()
    )
  );

CREATE POLICY "Students can manage own participation"
  ON public.session_participants FOR ALL
  USING (student_id = auth.uid());

-- ── live_polls ──

CREATE POLICY "Professors can manage polls in their sessions"
  ON public.live_polls FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.classroom_sessions cs
      JOIN public.course_sections sect ON sect.id = cs.section_id
      WHERE cs.id = live_polls.session_id
        AND sect.professor_id = auth.uid()
    )
  );

CREATE POLICY "Students can view polls in enrolled sessions"
  ON public.live_polls FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.classroom_sessions cs
      JOIN public.enrollments e ON e.section_id = cs.section_id
      WHERE cs.id = live_polls.session_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled', 'completed')
    )
  );

-- ── poll_responses ──

CREATE POLICY "Professors can view poll responses in their sessions"
  ON public.poll_responses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.live_polls lp
      JOIN public.classroom_sessions cs ON cs.id = lp.session_id
      JOIN public.course_sections sect ON sect.id = cs.section_id
      WHERE lp.id = poll_responses.poll_id
        AND sect.professor_id = auth.uid()
    )
  );

CREATE POLICY "Students can insert own poll responses"
  ON public.poll_responses FOR INSERT
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "Students can view own poll responses"
  ON public.poll_responses FOR SELECT
  USING (student_id = auth.uid());

-- ── live_quizzes ──

CREATE POLICY "Professors can manage quizzes in their sessions"
  ON public.live_quizzes FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.classroom_sessions cs
      JOIN public.course_sections sect ON sect.id = cs.section_id
      WHERE cs.id = live_quizzes.session_id
        AND sect.professor_id = auth.uid()
    )
  );

CREATE POLICY "Students can view quizzes in enrolled sessions"
  ON public.live_quizzes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.classroom_sessions cs
      JOIN public.enrollments e ON e.section_id = cs.section_id
      WHERE cs.id = live_quizzes.session_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled', 'completed')
    )
  );

-- ── quiz_responses ──

CREATE POLICY "Professors can view quiz responses in their sessions"
  ON public.quiz_responses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.live_quizzes lq
      JOIN public.classroom_sessions cs ON cs.id = lq.session_id
      JOIN public.course_sections sect ON sect.id = cs.section_id
      WHERE lq.id = quiz_responses.quiz_id
        AND sect.professor_id = auth.uid()
    )
  );

CREATE POLICY "Students can insert own quiz responses"
  ON public.quiz_responses FOR INSERT
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "Students can view own quiz responses"
  ON public.quiz_responses FOR SELECT
  USING (student_id = auth.uid());

-- ── session_questions ──

CREATE POLICY "Professors can manage questions in their sessions"
  ON public.session_questions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.classroom_sessions cs
      JOIN public.course_sections sect ON sect.id = cs.section_id
      WHERE cs.id = session_questions.session_id
        AND sect.professor_id = auth.uid()
    )
  );

CREATE POLICY "Students can insert own questions"
  ON public.session_questions FOR INSERT
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "Students can view questions in enrolled sessions"
  ON public.session_questions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.classroom_sessions cs
      JOIN public.enrollments e ON e.section_id = cs.section_id
      WHERE cs.id = session_questions.session_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled', 'completed')
    )
  );

-- ── question_upvotes ──

CREATE POLICY "Students can manage own upvotes"
  ON public.question_upvotes FOR ALL
  USING (student_id = auth.uid());

CREATE POLICY "Professors can view upvotes in their sessions"
  ON public.question_upvotes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.session_questions sq
      JOIN public.classroom_sessions cs ON cs.id = sq.session_id
      JOIN public.course_sections sect ON sect.id = cs.section_id
      WHERE sq.id = question_upvotes.question_id
        AND sect.professor_id = auth.uid()
    )
  );

-- ═══════════════════════════════════════════════════════════════
-- REALTIME PUBLICATION
-- ═══════════════════════════════════════════════════════════════

ALTER PUBLICATION supabase_realtime ADD TABLE public.classroom_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.session_participants;
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_polls;
ALTER PUBLICATION supabase_realtime ADD TABLE public.poll_responses;
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_quizzes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.quiz_responses;
ALTER PUBLICATION supabase_realtime ADD TABLE public.session_questions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.question_upvotes;
