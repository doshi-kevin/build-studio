-- Migration: allow_team_workspace moves from course_sections.settings
-- down to the projects table, where professors configure it per project.
--
-- Why: "Team workspaces" (team-scoped chat channels) only make sense
-- for group projects. Scoping the setting per-project lets a professor
-- run a graded group project WITH chat in parallel to an individual
-- short-assignment project WITHOUT chat, instead of the current
-- all-or-nothing course-level toggle.
--
-- Gating behavior after this migration:
--   1. Professors set `allow_team_workspace` at project creation /
--      edit time. Defaults to TRUE — same default as the old course
--      setting, so existing projects keep working.
--   2. `enableTeamWorkspace` student action checks the new column
--      instead of `course_sections.settings.allowTeamWorkspaces`.
--   3. For individual projects (max_team_size = 1) the column is
--      ignored by the UI since there are no teams to chat in.
--
-- The old course-level setting is left in place for now — harmless
-- dead field, removable in a follow-up cleanup once we've verified
-- nothing reads it outside the paths updated in this slice.
--
-- Created: 2026-04-15

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS allow_team_workspace BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.projects.allow_team_workspace IS
  'Per-project toggle for team-scoped chat workspaces. Defaults to true. Has no effect on individual projects (max_team_size = 1).';
