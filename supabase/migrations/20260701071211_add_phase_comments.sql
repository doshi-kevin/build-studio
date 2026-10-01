-- Create the missing public.phase_comments table.
--
-- The professor phase-feedback feature (addPhaseComment / getPhaseComments in
-- the professor projects actions, plus the student-side read actions) queries
-- .from('phase_comments'), but no migration ever created the table in prod.
-- Every insert/select fails and the client swallows the error, so professor
-- phase comments silently no-op. This creates the table with the exact shape
-- the code expects (id, phase_id, author_id, content, created_at) and the
-- default FK name phase_comments_author_id_fkey (matches the PostgREST alias).
--
-- Backfill of already-scrubbed data is not needed; the table is new.

CREATE TABLE IF NOT EXISTS public.phase_comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phase_id UUID NOT NULL REFERENCES public.project_phases(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phase_comments_phase ON public.phase_comments(phase_id);

ALTER TABLE public.phase_comments ENABLE ROW LEVEL SECURITY;

-- All writes go through server actions using the admin client (which bypasses
-- RLS), so the client-facing policy is SELECT-only per security-migrations.md
-- (no FOR ALL on an admin-written table).
--
-- Authorization: a caller may read a phase's comments if they are a member of
-- that phase's team OR the professor of the phase's project's section. The
-- check is wrapped in a SECURITY DEFINER helper so the policy does NOT trigger
-- project_phases'/project_members' own RLS (which would stack per-row and, via
-- project_members, risk recursion).
CREATE OR REPLACE FUNCTION public.can_access_phase(p_phase_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_phases ph
    WHERE ph.id = p_phase_id AND (
      public.is_team_member(ph.team_id, p_user_id)
      OR ph.project_id IN (
        SELECT p.id FROM public.projects p
        JOIN public.course_sections cs ON cs.id = p.section_id
        WHERE cs.professor_id = p_user_id
      )
    )
  );
$$;

REVOKE ALL ON FUNCTION public.can_access_phase(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.can_access_phase(uuid, uuid) TO authenticated;

CREATE POLICY "Team members and section professors can read phase comments"
  ON public.phase_comments FOR SELECT
  USING (public.can_access_phase(phase_id, (select auth.uid())));
