-- ============================================================
-- Link an assignment to a project phase
--
-- Adds a nullable assignment_id to project_phases so a phase can
-- record the (professor-created) assignment its details were
-- copied from. This is a ONE-TIME copy at creation — the phase is
-- freely editable afterward and is NOT kept in sync with the
-- assignment. The column exists only to (a) render an "Assignment"
-- tag on the phase and (b) cascade-delete the phase when the
-- assignment is deleted.
--
-- ON DELETE CASCADE: deleting the assignment removes the linked
-- phase (and, transitively, its phase_items and phase_comments).
-- This is the intended behavior.
--
-- RLS: no policy change. project_phases already has RLS scoped via
-- project/team (see 00000000000008_projects.sql); a nullable column
-- adds no new access surface. The insert_project_phase RPC is left
-- untouched — the server action sets assignment_id in a follow-up
-- UPDATE on the just-created row.
-- ============================================================

ALTER TABLE public.project_phases
  ADD COLUMN assignment_id UUID REFERENCES public.assignments(id) ON DELETE CASCADE;

-- FK columns are not auto-indexed by Postgres; this index also speeds
-- up the cascade-delete lookup when an assignment is removed.
CREATE INDEX idx_project_phases_assignment
  ON public.project_phases(assignment_id);
