-- ============================================================
-- Migration: Calendar & Office Hours tables
-- Moves calendar data from localStorage to Supabase.
-- 3 tables: office_hours, bookings, blocked_times
-- (Slots remain computed at runtime — not stored.)
-- Created: 2026-02-22
-- ============================================================

-- ═══════════════════════════════════════════════════════════════
-- 1. OFFICE_HOURS — recurring weekly templates set by professors
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.office_hours (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  professor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  course_name TEXT,
  course_code TEXT,
  day_of_week TEXT NOT NULL
    CHECK (day_of_week IN ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')),
  start_time TEXT NOT NULL,   -- "HH:MM" 24h
  end_time TEXT NOT NULL,     -- "HH:MM" 24h
  slot_duration INTEGER NOT NULL DEFAULT 30
    CHECK (slot_duration IN (15, 30, 45, 60)),
  buffer_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (buffer_minutes >= 0 AND buffer_minutes <= 15),
  meeting_type TEXT NOT NULL DEFAULT 'in_person'
    CHECK (meeting_type IN ('in_person', 'zoom')),
  location TEXT NOT NULL DEFAULT '',
  zoom_link TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  effective_from DATE NOT NULL,
  effective_until DATE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- 2. BOOKINGS — student appointments for specific time slots
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bookings (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  office_hours_id UUID NOT NULL REFERENCES public.office_hours(id) ON DELETE CASCADE,
  professor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TEXT NOT NULL,   -- "HH:MM"
  end_time TEXT NOT NULL,     -- "HH:MM"
  title TEXT NOT NULL,
  course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  course_name TEXT,
  course_code TEXT,
  meeting_type TEXT NOT NULL DEFAULT 'in_person'
    CHECK (meeting_type IN ('in_person', 'zoom')),
  purpose TEXT NOT NULL DEFAULT 'general_question'
    CHECK (purpose IN ('assignment_doubt','exam_prep','project_discussion','career_guidance','general_question')),
  student_note TEXT NOT NULL DEFAULT '',
  professor_note TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  zoom_link TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'booked'
    CHECK (status IN ('available','booked','completed','cancelled','no_show')),
  cancelled_by TEXT
    CHECK (cancelled_by IS NULL OR cancelled_by IN ('professor','student')),
  cancellation_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- 3. BLOCKED_TIMES — professor unavailability blocks
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.blocked_times (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  professor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TEXT NOT NULL,   -- "HH:MM"
  end_time TEXT NOT NULL,     -- "HH:MM"
  reason TEXT NOT NULL DEFAULT 'other'
    CHECK (reason IN ('lunch','conference','meeting','personal','other')),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

-- office_hours
CREATE INDEX IF NOT EXISTS idx_office_hours_professor
  ON public.office_hours(professor_id);

CREATE INDEX IF NOT EXISTS idx_office_hours_active
  ON public.office_hours(professor_id, is_active)
  WHERE is_active = true;

-- bookings
CREATE INDEX IF NOT EXISTS idx_bookings_professor
  ON public.bookings(professor_id);

CREATE INDEX IF NOT EXISTS idx_bookings_student
  ON public.bookings(student_id);

CREATE INDEX IF NOT EXISTS idx_bookings_status_date
  ON public.bookings(status, date);

CREATE INDEX IF NOT EXISTS idx_bookings_date
  ON public.bookings(date);

CREATE INDEX IF NOT EXISTS idx_bookings_office_hours
  ON public.bookings(office_hours_id);

-- blocked_times
CREATE INDEX IF NOT EXISTS idx_blocked_times_professor
  ON public.blocked_times(professor_id);

CREATE INDEX IF NOT EXISTS idx_blocked_times_professor_date
  ON public.blocked_times(professor_id, date);

-- ═══════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.office_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_times ENABLE ROW LEVEL SECURITY;

-- ── office_hours ──

CREATE POLICY "Professors can manage own office hours"
  ON public.office_hours FOR ALL
  USING (professor_id = auth.uid());

CREATE POLICY "Students can view active office hours"
  ON public.office_hours FOR SELECT
  USING (is_active = true);

-- ── bookings ──

CREATE POLICY "Professors can manage bookings for their office hours"
  ON public.bookings FOR ALL
  USING (professor_id = auth.uid());

CREATE POLICY "Students can view own bookings"
  ON public.bookings FOR SELECT
  USING (student_id = auth.uid());

CREATE POLICY "Students can insert own bookings"
  ON public.bookings FOR INSERT
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "Students can update own bookings"
  ON public.bookings FOR UPDATE
  USING (student_id = auth.uid());

-- ── blocked_times ──

CREATE POLICY "Professors can manage own blocked times"
  ON public.blocked_times FOR ALL
  USING (professor_id = auth.uid());

CREATE POLICY "Students can view blocked times for slot generation"
  ON public.blocked_times FOR SELECT
  USING (true);
-- ============================================================
-- Migration: Calendar Feed Tokens
-- Token-based authentication for iCal feed URLs.
-- Users subscribe once in Outlook; events auto-sync.
-- Created: 2026-02-22
-- ============================================================

CREATE TABLE IF NOT EXISTS public.calendar_tokens (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,           -- 64-char hex (crypto.randomBytes(32))
  label TEXT NOT NULL DEFAULT 'Default',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_accessed_at TIMESTAMP WITH TIME ZONE,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- One active token per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_tokens_active_user
  ON public.calendar_tokens(user_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_calendar_tokens_token
  ON public.calendar_tokens(token);

-- ── RLS ──

ALTER TABLE public.calendar_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own calendar tokens"
  ON public.calendar_tokens FOR ALL
  USING (user_id = auth.uid());
-- Migration: Feedback System
-- Creates the feedbacks table for collecting student and professor feedback
-- from anywhere in the app via a floating widget.

-- 1. Create the feedbacks table
CREATE TABLE IF NOT EXISTS feedbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_role TEXT NOT NULL CHECK (user_role IN ('student', 'professor')),
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 3),
  category TEXT NOT NULL CHECK (category IN ('bug', 'feature_request', 'content_issue', 'ux', 'general')),
  message TEXT,
  page_url TEXT NOT NULL,
  page_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'resolved', 'dismissed')),
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Indexes for common queries
CREATE INDEX idx_feedbacks_user_id ON feedbacks(user_id);
CREATE INDEX idx_feedbacks_status ON feedbacks(status);
CREATE INDEX idx_feedbacks_category ON feedbacks(category);
CREATE INDEX idx_feedbacks_created_at ON feedbacks(created_at DESC);
CREATE INDEX idx_feedbacks_user_role ON feedbacks(user_role);

-- 3. Updated_at trigger
CREATE OR REPLACE FUNCTION update_feedbacks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feedbacks_updated_at
  BEFORE UPDATE ON feedbacks
  FOR EACH ROW
  EXECUTE FUNCTION update_feedbacks_updated_at();

-- 4. RLS policies
ALTER TABLE feedbacks ENABLE ROW LEVEL SECURITY;

-- Users can insert their own feedback
CREATE POLICY "Users can insert own feedback"
  ON feedbacks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can read their own feedback
CREATE POLICY "Users can read own feedback"
  ON feedbacks FOR SELECT
  USING (auth.uid() = user_id);

-- Note: Admin reads/updates use the admin client (service role) which bypasses RLS.
-- ═══════════════════════════════════════════════════════════════
-- Migration: Challenge Board
-- Created: 2026-02-22
--
-- Tables: badges, challenges, challenge_claims,
--         challenge_submissions, user_badges
-- ═══════════════════════════════════════════════════════════════

-- ── TABLE 1: badges ────────────────────────────────────────────
-- Gamification badge definitions, scoped per section.

CREATE TABLE IF NOT EXISTS public.badges (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '🏆',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(section_id, name)
);

-- ── TABLE 2: challenges ────────────────────────────────────────
-- Professor-created (or student-proposed) challenge assignments.

CREATE TABLE IF NOT EXISTS public.challenges (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'general'
    CHECK (type IN ('general', 'coding', 'puzzle', 'research', 'creative', 'discussion')),
  difficulty TEXT NOT NULL DEFAULT 'medium'
    CHECK (difficulty IN ('easy', 'medium', 'hard', 'expert')),
  points INTEGER NOT NULL DEFAULT 10,
  bonus_points INTEGER NOT NULL DEFAULT 0,
  badge_id UUID REFERENCES public.badges(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'draft'
    CHECK (visibility IN ('draft', 'published', 'archived')),
  source TEXT NOT NULL DEFAULT 'instructor'
    CHECK (source IN ('instructor', 'student_proposed')),
  max_claims INTEGER,
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── TABLE 3: challenge_claims ──────────────────────────────────
-- A student claims (reserves) a challenge to work on.

CREATE TABLE IF NOT EXISTS public.challenge_claims (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES public.challenges(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'submitted', 'approved', 'rejected', 'withdrawn')),
  reviewer_note TEXT,
  reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(challenge_id, user_id)
);

-- ── TABLE 4: challenge_submissions ─────────────────────────────
-- Actual submission content attached to a claim.

CREATE TABLE IF NOT EXISTS public.challenge_submissions (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.challenge_claims(id) ON DELETE CASCADE,
  submission_type TEXT NOT NULL DEFAULT 'text'
    CHECK (submission_type IN ('text', 'link', 'file', 'github')),
  content TEXT,
  url TEXT,
  file_url TEXT,
  file_path TEXT,
  file_name TEXT,
  file_size INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── TABLE 5: user_badges ───────────────────────────────────────
-- Badge awards to students.

CREATE TABLE IF NOT EXISTS public.user_badges (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  badge_id UUID NOT NULL REFERENCES public.badges(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  awarded_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(section_id, badge_id, user_id)
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_badges_section ON public.badges(section_id);
CREATE INDEX IF NOT EXISTS idx_challenges_section ON public.challenges(section_id);
CREATE INDEX IF NOT EXISTS idx_challenges_section_visibility ON public.challenges(section_id, visibility);
CREATE INDEX IF NOT EXISTS idx_challenges_section_created ON public.challenges(section_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_challenges_source ON public.challenges(source);
CREATE INDEX IF NOT EXISTS idx_challenge_claims_challenge ON public.challenge_claims(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_claims_user ON public.challenge_claims(user_id);
CREATE INDEX IF NOT EXISTS idx_challenge_claims_challenge_status ON public.challenge_claims(challenge_id, status);
CREATE INDEX IF NOT EXISTS idx_challenge_claims_section_user ON public.challenge_claims(user_id, challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_submissions_claim ON public.challenge_submissions(claim_id);
CREATE INDEX IF NOT EXISTS idx_user_badges_section ON public.user_badges(section_id);
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON public.user_badges(user_id);
CREATE INDEX IF NOT EXISTS idx_user_badges_badge ON public.user_badges(badge_id);

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenge_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenge_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_badges ENABLE ROW LEVEL SECURITY;

-- ── badges policies ────────────────────────────────────────────

CREATE POLICY "Professors can manage section badges"
  ON public.badges FOR ALL
  USING (section_id IN (
    SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
  ));

CREATE POLICY "Enrolled students can read section badges"
  ON public.badges FOR SELECT
  USING (section_id IN (
    SELECT section_id FROM public.enrollments
    WHERE student_id = auth.uid() AND status IN ('enrolled', 'completed')
  ));

-- ── challenges policies ────────────────────────────────────────

CREATE POLICY "Professors can manage section challenges"
  ON public.challenges FOR ALL
  USING (section_id IN (
    SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
  ));

CREATE POLICY "Enrolled students can read published challenges"
  ON public.challenges FOR SELECT
  USING (
    visibility = 'published'
    AND section_id IN (
      SELECT section_id FROM public.enrollments
      WHERE student_id = auth.uid() AND status IN ('enrolled', 'completed')
    )
  );

CREATE POLICY "Students can read own proposed challenges"
  ON public.challenges FOR SELECT
  USING (
    created_by = auth.uid()
    AND source = 'student_proposed'
  );

CREATE POLICY "Students can insert proposed challenges"
  ON public.challenges FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND source = 'student_proposed'
    AND visibility = 'draft'
    AND section_id IN (
      SELECT section_id FROM public.enrollments
      WHERE student_id = auth.uid() AND status = 'enrolled'
    )
  );

-- ── challenge_claims policies ──────────────────────────────────

CREATE POLICY "Professors can read section claims"
  ON public.challenge_claims FOR SELECT
  USING (challenge_id IN (
    SELECT id FROM public.challenges
    WHERE section_id IN (
      SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
    )
  ));

CREATE POLICY "Professors can update section claims"
  ON public.challenge_claims FOR UPDATE
  USING (challenge_id IN (
    SELECT id FROM public.challenges
    WHERE section_id IN (
      SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
    )
  ));

CREATE POLICY "Students can manage own claims"
  ON public.challenge_claims FOR ALL
  USING (user_id = auth.uid());

-- ── challenge_submissions policies ─────────────────────────────

CREATE POLICY "Professors can read section submissions"
  ON public.challenge_submissions FOR SELECT
  USING (claim_id IN (
    SELECT id FROM public.challenge_claims
    WHERE challenge_id IN (
      SELECT id FROM public.challenges
      WHERE section_id IN (
        SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
      )
    )
  ));

CREATE POLICY "Students can manage own submissions"
  ON public.challenge_submissions FOR ALL
  USING (claim_id IN (
    SELECT id FROM public.challenge_claims WHERE user_id = auth.uid()
  ));

-- ── user_badges policies ───────────────────────────────────────

CREATE POLICY "Professors can manage section user_badges"
  ON public.user_badges FOR ALL
  USING (section_id IN (
    SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
  ));

CREATE POLICY "Users can read own badges"
  ON public.user_badges FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Enrolled students can read section badge awards"
  ON public.user_badges FOR SELECT
  USING (section_id IN (
    SELECT section_id FROM public.enrollments
    WHERE student_id = auth.uid() AND status IN ('enrolled', 'completed')
  ));
-- Migration: Create Course Alumni Intelligence Panel tables
-- Run this against your Supabase SQL editor.
-- Created: 2026-02-16
--
-- Tables:
--   1. course_reviews           — reviews with 5 rating dimensions
--   2. course_questions          — alumni Q&A questions
--   3. course_answers            — answers to questions
--   4. course_answer_votes       — upvotes on answers
--   5. course_tips               — survival guide entries
--   6. course_tip_votes          — upvotes on tips
--   7. course_resources          — uploaded study materials
--   8. course_professor_insights — professor-specific insights

-- ═══════════════════════════════════════════════════════════════
-- 1. COURSE REVIEWS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.course_reviews (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rating_overall INTEGER NOT NULL CHECK (rating_overall BETWEEN 1 AND 5),
  rating_difficulty INTEGER NOT NULL CHECK (rating_difficulty BETWEEN 1 AND 5),
  rating_workload INTEGER NOT NULL CHECK (rating_workload BETWEEN 1 AND 5),
  rating_teaching INTEGER NOT NULL CHECK (rating_teaching BETWEEN 1 AND 5),
  rating_grading_fairness INTEGER NOT NULL CHECK (rating_grading_fairness BETWEEN 1 AND 5),
  review_text TEXT NOT NULL DEFAULT '',
  would_take_again BOOLEAN NOT NULL DEFAULT true,
  grade_received TEXT CHECK (grade_received IN ('A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F','W','P','NP','I')),
  hours_per_week INTEGER CHECK (hours_per_week BETWEEN 0 AND 80),
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'flagged')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(course_id, author_id)
);

-- ═══════════════════════════════════════════════════════════════
-- 2. COURSE QUESTIONS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.course_questions (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'hidden')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- 3. COURSE ANSWERS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.course_answers (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_id UUID NOT NULL REFERENCES public.course_questions(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  is_accepted BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- 4. COURSE ANSWER VOTES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.course_answer_votes (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  answer_id UUID NOT NULL REFERENCES public.course_answers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(answer_id, user_id)
);

-- ═══════════════════════════════════════════════════════════════
-- 5. COURSE TIPS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.course_tips (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('study_advice', 'exam_tips', 'grading_tricks', 'general', 'resources', 'time_management')),
  content TEXT NOT NULL,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- 6. COURSE TIP VOTES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.course_tip_votes (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  tip_id UUID NOT NULL REFERENCES public.course_tips(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(tip_id, user_id)
);

-- ═══════════════════════════════════════════════════════════════
-- 7. COURSE RESOURCES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.course_resources (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'notes'
    CHECK (category IN ('notes', 'cheat_sheet', 'project_example', 'study_guide', 'practice_exam', 'other')),
  file_url TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- 8. COURSE PROFESSOR INSIGHTS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.course_professor_insights (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  professor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rating_teaching INTEGER NOT NULL CHECK (rating_teaching BETWEEN 1 AND 5),
  rating_approachability INTEGER NOT NULL CHECK (rating_approachability BETWEEN 1 AND 5),
  rating_clarity INTEGER NOT NULL CHECK (rating_clarity BETWEEN 1 AND 5),
  insight_text TEXT NOT NULL DEFAULT '',
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(course_id, professor_id, author_id)
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

-- course_reviews
CREATE INDEX IF NOT EXISTS idx_course_reviews_course ON public.course_reviews(course_id);
CREATE INDEX IF NOT EXISTS idx_course_reviews_author ON public.course_reviews(author_id);
CREATE INDEX IF NOT EXISTS idx_course_reviews_status ON public.course_reviews(status);

-- course_questions
CREATE INDEX IF NOT EXISTS idx_course_questions_course ON public.course_questions(course_id);
CREATE INDEX IF NOT EXISTS idx_course_questions_author ON public.course_questions(author_id);

-- course_answers
CREATE INDEX IF NOT EXISTS idx_course_answers_question ON public.course_answers(question_id);
CREATE INDEX IF NOT EXISTS idx_course_answers_author ON public.course_answers(author_id);

-- course_answer_votes
CREATE INDEX IF NOT EXISTS idx_course_answer_votes_answer ON public.course_answer_votes(answer_id);
CREATE INDEX IF NOT EXISTS idx_course_answer_votes_user ON public.course_answer_votes(user_id);

-- course_tips
CREATE INDEX IF NOT EXISTS idx_course_tips_course ON public.course_tips(course_id);
CREATE INDEX IF NOT EXISTS idx_course_tips_author ON public.course_tips(author_id);
CREATE INDEX IF NOT EXISTS idx_course_tips_category ON public.course_tips(category);

-- course_tip_votes
CREATE INDEX IF NOT EXISTS idx_course_tip_votes_tip ON public.course_tip_votes(tip_id);
CREATE INDEX IF NOT EXISTS idx_course_tip_votes_user ON public.course_tip_votes(user_id);

-- course_resources
CREATE INDEX IF NOT EXISTS idx_course_resources_course ON public.course_resources(course_id);
CREATE INDEX IF NOT EXISTS idx_course_resources_author ON public.course_resources(author_id);
CREATE INDEX IF NOT EXISTS idx_course_resources_category ON public.course_resources(category);

-- course_professor_insights
CREATE INDEX IF NOT EXISTS idx_course_prof_insights_course ON public.course_professor_insights(course_id);
CREATE INDEX IF NOT EXISTS idx_course_prof_insights_professor ON public.course_professor_insights(professor_id);
CREATE INDEX IF NOT EXISTS idx_course_prof_insights_author ON public.course_professor_insights(author_id);

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.course_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_answer_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_tips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_tip_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_professor_insights ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════
-- RLS POLICIES — SELECT (any authenticated user can read active content)
-- ═══════════════════════════════════════════════════════════════

CREATE POLICY "Authenticated users can read active reviews"
  ON public.course_reviews FOR SELECT
  USING (status = 'active' AND auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can read active questions"
  ON public.course_questions FOR SELECT
  USING (status = 'active' AND auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can read active answers"
  ON public.course_answers FOR SELECT
  USING (status = 'active' AND auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can read answer votes"
  ON public.course_answer_votes FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can read active tips"
  ON public.course_tips FOR SELECT
  USING (status = 'active' AND auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can read tip votes"
  ON public.course_tip_votes FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can read active resources"
  ON public.course_resources FOR SELECT
  USING (status = 'active' AND auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can read active professor insights"
  ON public.course_professor_insights FOR SELECT
  USING (status = 'active' AND auth.uid() IS NOT NULL);

-- ═══════════════════════════════════════════════════════════════
-- RLS POLICIES — INSERT (alumni for write-heavy tables, anyone for questions/votes)
-- ═══════════════════════════════════════════════════════════════

CREATE POLICY "Alumni can create reviews"
  ON public.course_reviews FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND course_id IN (
      SELECT cs.course_id FROM public.course_sections cs
      JOIN public.enrollments e ON e.section_id = cs.id
      WHERE e.student_id = auth.uid()
        AND e.status IN ('active', 'completed', 'enrolled')
    )
  );

CREATE POLICY "Authenticated users can create questions"
  ON public.course_questions FOR INSERT
  WITH CHECK (author_id = auth.uid());

CREATE POLICY "Alumni can create answers"
  ON public.course_answers FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND question_id IN (
      SELECT cq.id FROM public.course_questions cq
      WHERE cq.course_id IN (
        SELECT cs.course_id FROM public.course_sections cs
        JOIN public.enrollments e ON e.section_id = cs.id
        WHERE e.student_id = auth.uid()
          AND e.status IN ('active', 'completed', 'enrolled')
      )
    )
  );

CREATE POLICY "Authenticated users can vote on answers"
  ON public.course_answer_votes FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Alumni can create tips"
  ON public.course_tips FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND course_id IN (
      SELECT cs.course_id FROM public.course_sections cs
      JOIN public.enrollments e ON e.section_id = cs.id
      WHERE e.student_id = auth.uid()
        AND e.status IN ('active', 'completed', 'enrolled')
    )
  );

CREATE POLICY "Authenticated users can vote on tips"
  ON public.course_tip_votes FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Alumni can upload resources"
  ON public.course_resources FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND course_id IN (
      SELECT cs.course_id FROM public.course_sections cs
      JOIN public.enrollments e ON e.section_id = cs.id
      WHERE e.student_id = auth.uid()
        AND e.status IN ('active', 'completed', 'enrolled')
    )
  );

CREATE POLICY "Alumni can create professor insights"
  ON public.course_professor_insights FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND course_id IN (
      SELECT cs.course_id FROM public.course_sections cs
      JOIN public.enrollments e ON e.section_id = cs.id
      WHERE e.student_id = auth.uid()
        AND e.status IN ('active', 'completed', 'enrolled')
    )
  );

-- ═══════════════════════════════════════════════════════════════
-- RLS POLICIES — UPDATE (authors can update own content)
-- ═══════════════════════════════════════════════════════════════

CREATE POLICY "Authors can update own reviews"
  ON public.course_reviews FOR UPDATE
  USING (author_id = auth.uid());

CREATE POLICY "Authors can update own questions"
  ON public.course_questions FOR UPDATE
  USING (author_id = auth.uid());

CREATE POLICY "Authors can update own answers"
  ON public.course_answers FOR UPDATE
  USING (author_id = auth.uid());

CREATE POLICY "Authors can update own tips"
  ON public.course_tips FOR UPDATE
  USING (author_id = auth.uid());

CREATE POLICY "Authors can update own resources"
  ON public.course_resources FOR UPDATE
  USING (author_id = auth.uid());

CREATE POLICY "Authors can update own professor insights"
  ON public.course_professor_insights FOR UPDATE
  USING (author_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════
-- RLS POLICIES — DELETE (own votes only)
-- ═══════════════════════════════════════════════════════════════

CREATE POLICY "Users can remove own answer votes"
  ON public.course_answer_votes FOR DELETE
  USING (user_id = auth.uid());

CREATE POLICY "Users can remove own tip votes"
  ON public.course_tip_votes FOR DELETE
  USING (user_id = auth.uid());
-- ============================================================
-- Project Teams Migration — Student-Driven Teams Under Professor Assignments
-- ============================================================
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)
--
-- Creates 2 new tables:
--   1. project_teams    — student-created teams under a professor-created project
--   2. project_grades   — professor grades per team
--
-- Alters 5 existing tables:
--   - projects           — add guidelines + due_date
--   - project_members    — add team_id
--   - project_phases     — add team_id
--   - project_videos     — add team_id
--   - project_showcase   — add team_id
-- ============================================================

-- ── 1. project_teams ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(project_id, name)
);

ALTER TABLE project_teams ENABLE ROW LEVEL SECURITY;

-- ── 2. project_grades ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES project_teams(id) ON DELETE CASCADE UNIQUE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  graded_by uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  score numeric(5, 2) NOT NULL CHECK (score >= 0 AND score <= 100),
  feedback text NOT NULL DEFAULT '',
  graded_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE project_grades ENABLE ROW LEVEL SECURITY;

-- ── 3. Alter projects — add assignment fields ─────────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS guidelines text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS due_date date;

-- ── 4. Add team_id to existing child tables ───────────────────
ALTER TABLE project_members ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES project_teams(id) ON DELETE CASCADE;
ALTER TABLE project_phases ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES project_teams(id) ON DELETE CASCADE;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES project_teams(id) ON DELETE CASCADE;
ALTER TABLE project_showcase ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES project_teams(id) ON DELETE CASCADE;

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_project_teams_project ON project_teams(project_id);
CREATE INDEX IF NOT EXISTS idx_project_teams_created_by ON project_teams(created_by);
CREATE INDEX IF NOT EXISTS idx_project_grades_team ON project_grades(team_id);
CREATE INDEX IF NOT EXISTS idx_project_grades_project ON project_grades(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_team ON project_members(team_id);
CREATE INDEX IF NOT EXISTS idx_project_phases_team ON project_phases(team_id);
CREATE INDEX IF NOT EXISTS idx_project_videos_team ON project_videos(team_id);

-- team_id unique constraints for team-scoped data
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_showcase_team ON project_showcase(team_id) WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_members_team_user ON project_members(team_id, user_id) WHERE team_id IS NOT NULL;
