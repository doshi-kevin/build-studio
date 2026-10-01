-- Migration: Create project workspace tables
-- Run this against your Supabase SQL editor.
-- Created: 2026-02-14

-- ═══════════════════════════════════════════════════════════════
-- PHASE 1 TABLES (active in UI)
-- ═══════════════════════════════════════════════════════════════

-- 1. projects — the central entity, scoped to a course section
CREATE TABLE IF NOT EXISTS public.projects (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'completed', 'archived')),
  visibility TEXT NOT NULL DEFAULT 'course'
    CHECK (visibility IN ('private', 'course', 'public')),
  max_team_size INTEGER NOT NULL DEFAULT 5,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  thumbnail_url TEXT,
  showcase_enabled BOOLEAN NOT NULL DEFAULT false,
  showcase_description TEXT,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 2. project_members — team membership with role-based access
CREATE TABLE IF NOT EXISTS public.project_members (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'member', 'viewer')),
  contribution_summary TEXT,
  joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);

-- 3. project_phases — milestones / phases within a project
CREATE TABLE IF NOT EXISTS public.project_phases (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed', 'blocked')),
  position INTEGER NOT NULL DEFAULT 0,
  start_date DATE,
  due_date DATE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 4. project_videos — video uploads for project demos
CREATE TABLE IF NOT EXISTS public.project_videos (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL,
  video_path TEXT NOT NULL,
  file_size INTEGER,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 5. project_showcase — public showcase entries
CREATE TABLE IF NOT EXISTS public.project_showcase (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE UNIQUE,
  published_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tagline TEXT NOT NULL DEFAULT '',
  external_url TEXT,
  is_featured BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 6. future_contributors — students who want to continue a project
CREATE TABLE IF NOT EXISTS public.future_contributors (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);

-- ═══════════════════════════════════════════════════════════════
-- PHASE 2 TABLES (schema only, UI deferred)
-- ═══════════════════════════════════════════════════════════════

-- 7. github_connections — links a user's GitHub account
CREATE TABLE IF NOT EXISTS public.github_connections (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE UNIQUE,
  github_username TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  access_token TEXT NOT NULL,
  avatar_url TEXT,
  connected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 8. project_repositories — links a project to a GitHub repo
CREATE TABLE IF NOT EXISTS public.project_repositories (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  github_repo_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  is_primary BOOLEAN NOT NULL DEFAULT true,
  webhook_secret TEXT,
  last_synced_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(project_id, github_repo_id)
);

-- 9. project_commits — tracked commits from linked repos
CREATE TABLE IF NOT EXISTS public.project_commits (
  id UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
  repository_id UUID NOT NULL REFERENCES public.project_repositories(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  message TEXT NOT NULL,
  author_github_username TEXT,
  author_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  committed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  files_changed INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(repository_id, commit_sha)
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_projects_section ON public.projects(section_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_by ON public.projects(created_by);
CREATE INDEX IF NOT EXISTS idx_projects_status ON public.projects(status);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON public.project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON public.project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_phases_project ON public.project_phases(project_id);
CREATE INDEX IF NOT EXISTS idx_project_videos_project ON public.project_videos(project_id);
CREATE INDEX IF NOT EXISTS idx_project_showcase_project ON public.project_showcase(project_id);
CREATE INDEX IF NOT EXISTS idx_future_contributors_project ON public.future_contributors(project_id);
CREATE INDEX IF NOT EXISTS idx_future_contributors_user ON public.future_contributors(user_id);
CREATE INDEX IF NOT EXISTS idx_github_connections_user ON public.github_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_project_repositories_project ON public.project_repositories(project_id);
CREATE INDEX IF NOT EXISTS idx_project_commits_repository ON public.project_commits(repository_id);
CREATE INDEX IF NOT EXISTS idx_project_commits_project ON public.project_commits(project_id);

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_showcase ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.future_contributors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.github_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_commits ENABLE ROW LEVEL SECURITY;

-- Projects
CREATE POLICY "Professors can read section projects"
  ON public.projects FOR SELECT
  USING (
    section_id IN (
      SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
    )
  );

CREATE POLICY "Enrolled students can read course-visible projects"
  ON public.projects FOR SELECT
  USING (
    visibility IN ('course', 'public')
    AND section_id IN (
      SELECT section_id FROM public.enrollments
      WHERE student_id = auth.uid() AND status IN ('active', 'completed')
    )
  );

CREATE POLICY "Project creators can read own projects"
  ON public.projects FOR SELECT
  USING (created_by = auth.uid());

CREATE POLICY "Professors can insert projects"
  ON public.projects FOR INSERT
  WITH CHECK (
    section_id IN (
      SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
    )
  );

CREATE POLICY "Students can insert projects when enrolled"
  ON public.projects FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND section_id IN (
      SELECT section_id FROM public.enrollments
      WHERE student_id = auth.uid() AND status = 'active'
    )
  );

CREATE POLICY "Creators and professors can update projects"
  ON public.projects FOR UPDATE
  USING (
    created_by = auth.uid()
    OR section_id IN (
      SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
    )
  );

CREATE POLICY "Professors can delete projects"
  ON public.projects FOR DELETE
  USING (
    section_id IN (
      SELECT id FROM public.course_sections WHERE professor_id = auth.uid()
    )
  );

-- Project Members
CREATE POLICY "Members and professors can read project members"
  ON public.project_members FOR SELECT
  USING (
    project_id IN (
      SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
    )
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Owners and professors can insert members"
  ON public.project_members FOR INSERT
  WITH CHECK (
    project_id IN (
      SELECT project_id FROM public.project_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Owners and professors can update members"
  ON public.project_members FOR UPDATE
  USING (
    user_id = auth.uid()
    OR project_id IN (
      SELECT project_id FROM public.project_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Owners and professors can delete members"
  ON public.project_members FOR DELETE
  USING (
    user_id = auth.uid()
    OR project_id IN (
      SELECT project_id FROM public.project_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

-- Project Phases
CREATE POLICY "Members and professors can read phases"
  ON public.project_phases FOR SELECT
  USING (
    project_id IN (
      SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
    )
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Owners and professors can manage phases"
  ON public.project_phases FOR ALL
  USING (
    project_id IN (
      SELECT project_id FROM public.project_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

-- Project Videos
CREATE POLICY "Members and professors can read videos"
  ON public.project_videos FOR SELECT
  USING (
    project_id IN (
      SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
    )
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Members can upload videos"
  ON public.project_videos FOR INSERT
  WITH CHECK (
    uploaded_by = auth.uid()
    AND project_id IN (
      SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Owners and professors can delete videos"
  ON public.project_videos FOR DELETE
  USING (
    uploaded_by = auth.uid()
    OR project_id IN (
      SELECT project_id FROM public.project_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

-- Showcase
CREATE POLICY "Anyone can read public showcase"
  ON public.project_showcase FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects WHERE visibility = 'public' AND showcase_enabled = true
    )
  );

CREATE POLICY "Professors can manage showcase"
  ON public.project_showcase FOR ALL
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

-- Future Contributors
CREATE POLICY "Students can express interest"
  ON public.future_contributors FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can read own contributions"
  ON public.future_contributors FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Project owners and professors can manage contributors"
  ON public.future_contributors FOR ALL
  USING (
    project_id IN (
      SELECT project_id FROM public.project_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = auth.uid()
    )
  );

-- GitHub tables (Phase 2 RLS)
CREATE POLICY "Users can manage own github connection"
  ON public.github_connections FOR ALL
  USING (user_id = auth.uid());

CREATE POLICY "Members can read project repos"
  ON public.project_repositories FOR SELECT
  USING (
    project_id IN (
      SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Members can read project commits"
  ON public.project_commits FOR SELECT
  USING (
    project_id IN (
      SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
    )
  );
