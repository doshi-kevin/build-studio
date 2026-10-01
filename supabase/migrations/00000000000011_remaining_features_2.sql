-- Migration: Project Chat (Discussions) — Team-scoped channels + messages
-- Run this against your Supabase SQL editor.
-- Created: 2026-03-08

-- ═══════════════════════════════════════════════════════════════
-- TABLES
-- ═══════════════════════════════════════════════════════════════

-- 1. project_chat_channels — named channels within a team (max 10)
CREATE TABLE IF NOT EXISTS public.project_chat_channels (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID NOT NULL REFERENCES public.project_teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  is_default BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 2. project_chat_messages — messages within a channel
CREATE TABLE IF NOT EXISTS public.project_chat_messages (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id UUID NOT NULL REFERENCES public.project_chat_channels(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  attachment_url TEXT,
  attachment_path TEXT,
  attachment_name TEXT,
  attachment_size INTEGER,
  attachment_type TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_project_chat_channels_team ON public.project_chat_channels(team_id);
CREATE INDEX IF NOT EXISTS idx_project_chat_messages_channel ON public.project_chat_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_project_chat_messages_created ON public.project_chat_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_chat_messages_author ON public.project_chat_messages(author_id);

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.project_chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_chat_messages ENABLE ROW LEVEL SECURITY;

-- Security definer function to check team membership without triggering RLS recursion
-- on project_members (which has its own RLS policies that cause infinite recursion)
CREATE OR REPLACE FUNCTION public.is_team_member(p_team_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE team_id = p_team_id AND user_id = p_user_id
  );
$$;

-- Channels — team members only (no professor access)

CREATE POLICY "Team members can read channels"
  ON public.project_chat_channels FOR SELECT
  USING (public.is_team_member(team_id, auth.uid()));

CREATE POLICY "Team members can create channels"
  ON public.project_chat_channels FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND public.is_team_member(team_id, auth.uid())
  );

CREATE POLICY "Team members can update non-default channels"
  ON public.project_chat_channels FOR UPDATE
  USING (
    is_default = false
    AND public.is_team_member(team_id, auth.uid())
  );

CREATE POLICY "Team members can delete non-default channels"
  ON public.project_chat_channels FOR DELETE
  USING (
    is_default = false
    AND public.is_team_member(team_id, auth.uid())
  );

-- Messages — team members only (no professor access)

CREATE POLICY "Team members can read messages"
  ON public.project_chat_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.project_chat_channels pcc
      WHERE pcc.id = project_chat_messages.channel_id
        AND public.is_team_member(pcc.team_id, auth.uid())
    )
  );

CREATE POLICY "Team members can send messages"
  ON public.project_chat_messages FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.project_chat_channels pcc
      WHERE pcc.id = project_chat_messages.channel_id
        AND public.is_team_member(pcc.team_id, auth.uid())
    )
  );

-- ═══════════════════════════════════════════════════════════════
-- ENABLE REALTIME
-- ═══════════════════════════════════════════════════════════════

ALTER PUBLICATION supabase_realtime ADD TABLE public.project_chat_channels;
ALTER PUBLICATION supabase_realtime ADD TABLE public.project_chat_messages;
-- ============================================================
-- Migration: Course-Level Discussions
-- Creates discussion_channels and discussion_messages tables,
-- adds workspace_enabled column to project_teams, sets up RLS,
-- indexes, and Supabase Realtime.
-- ============================================================

-- ── Security Definer: check enrollment OR professor ownership ──

CREATE OR REPLACE FUNCTION public.is_enrolled_or_professor(
  p_section_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Check if user is the section professor
  IF EXISTS (
    SELECT 1 FROM public.course_sections
    WHERE id = p_section_id AND professor_id = p_user_id
  ) THEN
    RETURN TRUE;
  END IF;

  -- Check if user is enrolled
  IF EXISTS (
    SELECT 1 FROM public.enrollments
    WHERE section_id = p_section_id
      AND student_id = p_user_id
      AND status IN ('enrolled', 'completed')
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

-- ── discussion_channels ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.discussion_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  team_id UUID REFERENCES public.project_teams(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('course', 'team')),
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  is_default BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.discussion_channels IS 'Course-level discussion channels. scope=course for all enrolled, scope=team for private team workspaces.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_discussion_channels_section ON public.discussion_channels(section_id);
CREATE INDEX IF NOT EXISTS idx_discussion_channels_team ON public.discussion_channels(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_discussion_channels_section_scope ON public.discussion_channels(section_id, scope);

-- ── discussion_messages ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.discussion_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES public.discussion_channels(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  attachment_url TEXT,
  attachment_path TEXT,
  attachment_name TEXT,
  attachment_size INTEGER,
  attachment_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.discussion_messages IS 'Messages within discussion channels. Cascades on channel delete.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_discussion_messages_channel ON public.discussion_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_discussion_messages_created ON public.discussion_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discussion_messages_author ON public.discussion_messages(author_id);

-- ── ALTER project_teams: workspace_enabled ──────────────────────

ALTER TABLE public.project_teams
  ADD COLUMN IF NOT EXISTS workspace_enabled BOOLEAN NOT NULL DEFAULT false;

-- ── RLS ─────────────────────────────────────────────────────────

ALTER TABLE public.discussion_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discussion_messages ENABLE ROW LEVEL SECURITY;

-- Channels: course-scope — enrolled students + professor can read
CREATE POLICY "Course channel: enrolled or professor can read"
  ON public.discussion_channels
  FOR SELECT
  USING (
    scope = 'course'
    AND is_enrolled_or_professor(section_id, auth.uid())
  );

-- Channels: team-scope — only team members can read
CREATE POLICY "Team channel: team members can read"
  ON public.discussion_channels
  FOR SELECT
  USING (
    scope = 'team'
    AND is_team_member(team_id, auth.uid())
  );

-- Messages: user can read if they can see the channel
CREATE POLICY "Message: can read if channel accessible"
  ON public.discussion_messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.discussion_channels dc
      WHERE dc.id = channel_id
      AND (
        (dc.scope = 'course' AND is_enrolled_or_professor(dc.section_id, auth.uid()))
        OR
        (dc.scope = 'team' AND is_team_member(dc.team_id, auth.uid()))
      )
    )
  );

-- Messages: user can insert if they can see the channel and channel is active
CREATE POLICY "Message: can insert if channel accessible and active"
  ON public.discussion_messages
  FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.discussion_channels dc
      WHERE dc.id = channel_id
      AND dc.status = 'active'
      AND (
        (dc.scope = 'course' AND is_enrolled_or_professor(dc.section_id, auth.uid()))
        OR
        (dc.scope = 'team' AND is_team_member(dc.team_id, auth.uid()))
      )
    )
  );

-- ── Realtime ────────────────────────────────────────────────────

ALTER PUBLICATION supabase_realtime ADD TABLE public.discussion_channels;
ALTER PUBLICATION supabase_realtime ADD TABLE public.discussion_messages;
-- Migration: Add phase_items table for checklist items within project phases
-- Run this against your Supabase SQL editor.
-- Created: 2026-03-08

-- ═══════════════════════════════════════════════════════════════
-- TABLE: phase_items — checklist items within a project phase
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.phase_items (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  phase_id UUID NOT NULL REFERENCES public.project_phases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  is_completed BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0,
  completed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_phase_items_phase ON public.phase_items(phase_id);
CREATE INDEX IF NOT EXISTS idx_phase_items_phase_position ON public.phase_items(phase_id, position);

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.phase_items ENABLE ROW LEVEL SECURITY;

-- SELECT: Team members and professors can read phase items
CREATE POLICY "Team members and professors can read phase items"
  ON public.phase_items FOR SELECT
  USING (
    phase_id IN (
      SELECT pp.id FROM public.project_phases pp
      WHERE pp.project_id IN (
        SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
      )
    )
    OR phase_id IN (
      SELECT pp.id FROM public.project_phases pp
      JOIN public.projects p ON p.id = pp.project_id
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE: Any team member can manage phase items
CREATE POLICY "Team members can manage phase items"
  ON public.phase_items FOR ALL
  USING (
    phase_id IN (
      SELECT pp.id FROM public.project_phases pp
      WHERE pp.project_id IN (
        SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
      )
    )
    OR phase_id IN (
      SELECT pp.id FROM public.project_phases pp
      JOIN public.projects p ON p.id = pp.project_id
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );
-- Migration: Create roadmap_node_status table for auto-generated course roadmap.
-- Run this in the Supabase SQL Editor.
--
-- This table stores professor-set statuses on modules (weeks) and module_items (items).
-- The auto roadmap structure is derived from modules + module_items; only statuses are stored here.

-- Table: roadmap_node_status
CREATE TABLE IF NOT EXISTS public.roadmap_node_status (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL CHECK (node_type IN ('module', 'module_item')),
  node_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'complete')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(section_id, node_type, node_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_roadmap_node_status_section
  ON public.roadmap_node_status(section_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_node_status_lookup
  ON public.roadmap_node_status(section_id, node_type, node_id);

-- RLS
ALTER TABLE public.roadmap_node_status ENABLE ROW LEVEL SECURITY;

-- Professors can read statuses for their sections
CREATE POLICY "Professors can read section roadmap node statuses"
  ON public.roadmap_node_status FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = roadmap_node_status.section_id
        AND cs.professor_id = auth.uid()
    )
  );

-- Professors can insert statuses for their sections
CREATE POLICY "Professors can insert section roadmap node statuses"
  ON public.roadmap_node_status FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = roadmap_node_status.section_id
        AND cs.professor_id = auth.uid()
    )
  );

-- Professors can update statuses for their sections
CREATE POLICY "Professors can update section roadmap node statuses"
  ON public.roadmap_node_status FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = roadmap_node_status.section_id
        AND cs.professor_id = auth.uid()
    )
  );

-- Professors can delete statuses for their sections
CREATE POLICY "Professors can delete section roadmap node statuses"
  ON public.roadmap_node_status FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = roadmap_node_status.section_id
        AND cs.professor_id = auth.uid()
    )
  );

-- Enrolled students can read statuses (read-only)
CREATE POLICY "Enrolled students can read roadmap node statuses"
  ON public.roadmap_node_status FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.section_id = roadmap_node_status.section_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled', 'completed')
    )
  );
-- Migration: Team Join Requests
-- Purpose: Allow students to request to join existing teams on project assignments.
-- Team owners can accept or decline requests.
--
-- Run this in Supabase SQL Editor.

-- ── Table ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.team_join_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES public.project_teams(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  responded_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

-- ── Indexes ──────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_team_join_requests_team ON public.team_join_requests(team_id);
CREATE INDEX IF NOT EXISTS idx_team_join_requests_user ON public.team_join_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_team_join_requests_project ON public.team_join_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_team_join_requests_status ON public.team_join_requests(status);

-- ── RLS ──────────────────────────────────────────────────────────

ALTER TABLE public.team_join_requests ENABLE ROW LEVEL SECURITY;

-- Students can read their own requests
CREATE POLICY "Users can read own join requests"
  ON public.team_join_requests FOR SELECT
  USING (auth.uid() = user_id);

-- Team members can read requests for their team
CREATE POLICY "Team members can read team join requests"
  ON public.team_join_requests FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members
      WHERE project_members.team_id = team_join_requests.team_id
        AND project_members.user_id = auth.uid()
    )
  );

-- Enrolled students can create join requests
CREATE POLICY "Enrolled students can create join requests"
  ON public.team_join_requests FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.enrollments
      WHERE enrollments.section_id = team_join_requests.section_id
        AND enrollments.student_id = auth.uid()
        AND enrollments.status IN ('enrolled', 'completed')
    )
  );

-- Team owners can update (accept/decline) requests
CREATE POLICY "Team owners can update join requests"
  ON public.team_join_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members
      WHERE project_members.team_id = team_join_requests.team_id
        AND project_members.user_id = auth.uid()
        AND project_members.role = 'owner'
    )
  );

-- Users can delete their own pending requests (withdraw)
CREATE POLICY "Users can delete own pending requests"
  ON public.team_join_requests FOR DELETE
  USING (auth.uid() = user_id AND status = 'pending');
-- Migration: AI Tutor Chat Persistence — per-student conversation threads + messages
-- Run this against your Supabase SQL editor.
-- Created: 2026-03-12

-- ═══════════════════════════════════════════════════════════════
-- TABLES
-- ═══════════════════════════════════════════════════════════════

-- 1. ai_conversations — scoped to (student, section), supports multiple threads
CREATE TABLE IF NOT EXISTS public.ai_conversations (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New Chat',
  context_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 2. ai_messages — individual messages within a conversation
CREATE TABLE IF NOT EXISTS public.ai_messages (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_ai_conversations_student_section
  ON public.ai_conversations(student_id, section_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_asc
  ON public.ai_messages(conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_desc
  ON public.ai_messages(conversation_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;

-- Conversations — students can manage their own

CREATE POLICY "Students can read own conversations"
  ON public.ai_conversations FOR SELECT
  USING (student_id = auth.uid());

CREATE POLICY "Students can create own conversations"
  ON public.ai_conversations FOR INSERT
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "Students can update own conversations"
  ON public.ai_conversations FOR UPDATE
  USING (student_id = auth.uid());

CREATE POLICY "Students can delete own conversations"
  ON public.ai_conversations FOR DELETE
  USING (student_id = auth.uid());

-- Messages — students can read/insert messages in their own conversations

CREATE POLICY "Students can read messages in own conversations"
  ON public.ai_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.ai_conversations ac
      WHERE ac.id = ai_messages.conversation_id
        AND ac.student_id = auth.uid()
    )
  );

CREATE POLICY "Students can insert messages in own conversations"
  ON public.ai_messages FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.ai_conversations ac
      WHERE ac.id = ai_messages.conversation_id
        AND ac.student_id = auth.uid()
    )
  );
