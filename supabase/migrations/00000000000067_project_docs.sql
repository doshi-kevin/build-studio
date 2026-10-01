-- Migration: project_docs
-- Multi-doc support for team workspaces. Replaces the single
-- project_teams.planning_doc field. Docs are per-team, ordered, and
-- can be pinned (the original "Planning" doc becomes a pinned row).
--
-- The planning_doc column on project_teams is intentionally NOT dropped
-- here — it stays for one release cycle as a read fallback for any code
-- that hasn't switched to project_docs. Removal is a future migration.

-- ── Table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_docs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES public.project_teams(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Untitled' CHECK (char_length(title) <= 200),
  content     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_pinned   BOOLEAN NOT NULL DEFAULT false,
  position    INTEGER NOT NULL DEFAULT 0,
  created_by  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  updated_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.project_docs IS 'Team-scoped collaborative documents (canvases). Replaces project_teams.planning_doc.';

-- ── Indexes ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_project_docs_team_position
  ON public.project_docs(team_id, position);

CREATE INDEX IF NOT EXISTS idx_project_docs_team_updated
  ON public.project_docs(team_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_docs_pinned
  ON public.project_docs(team_id, is_pinned)
  WHERE is_pinned = true;

-- Uniqueness on (team_id, title) is scoped to pinned docs only. This
-- hardens the backfill against concurrent insert races for the system
-- "Planning" doc while leaving user-created canvases free to share
-- titles (e.g., multiple "Untitled" canvases).
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_docs_pinned_title
  ON public.project_docs(team_id, title)
  WHERE is_pinned = true;

-- ── Updated-at trigger ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_project_docs_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_docs_updated_at ON public.project_docs;
CREATE TRIGGER trg_project_docs_updated_at
  BEFORE UPDATE ON public.project_docs
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_project_docs_updated_at();

-- ── RLS ────────────────────────────────────────────────────────
ALTER TABLE public.project_docs ENABLE ROW LEVEL SECURITY;

-- Team members can read all docs for their team.
CREATE POLICY "Team members can read project docs"
  ON public.project_docs FOR SELECT
  USING (public.is_team_member(team_id, auth.uid()));

-- Team members can create docs (created_by must be self).
CREATE POLICY "Team members can create project docs"
  ON public.project_docs FOR INSERT
  WITH CHECK (
    public.is_team_member(team_id, auth.uid())
    AND created_by = auth.uid()
  );

-- Team members can update docs for their team.
CREATE POLICY "Team members can update project docs"
  ON public.project_docs FOR UPDATE
  USING (public.is_team_member(team_id, auth.uid()));

-- Team members can delete docs for their team.
CREATE POLICY "Team members can delete project docs"
  ON public.project_docs FOR DELETE
  USING (public.is_team_member(team_id, auth.uid()));

-- Professors teaching the section can read (for grading / oversight).
-- Admins are not granted here — they use the service-role admin client which bypasses RLS.
CREATE POLICY "Section professors can read project docs"
  ON public.project_docs FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.project_teams pt
      JOIN public.projects p ON p.id = pt.project_id
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE pt.id = project_docs.team_id
        AND cs.professor_id = auth.uid()
    )
  );
