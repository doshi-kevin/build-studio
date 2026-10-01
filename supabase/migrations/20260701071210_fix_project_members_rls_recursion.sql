-- Fix RLS infinite recursion on public.project_members.
--
-- The original policies (00000000000008_projects.sql) subquery project_members
-- from WITHIN policies ON project_members, which Postgres rejects at runtime
-- with 42P17 (infinite recursion) -> HTTP 500 on any client-side read of the
-- table. Server actions survive because they use the admin client (bypasses
-- RLS), but any direct PostgREST/anon read 500s in a loop.
--
-- Fix: introduce SECURITY DEFINER helpers (mirroring the existing
-- is_team_member() in 00000000000011_remaining_features_2.sql) that read
-- project_members with owner privileges — bypassing RLS internally, so calling
-- them from a project_members policy does not re-enter the policy. Then rewrite
-- the four policies to use the helpers. The professor branch stays inline; it
-- joins projects + course_sections and never touches project_members, so it
-- cannot recurse.

CREATE OR REPLACE FUNCTION public.is_project_member(p_project_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = p_project_id AND user_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_project_owner(p_project_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = p_project_id AND user_id = p_user_id AND role = 'owner'
  );
$$;

REVOKE ALL ON FUNCTION public.is_project_member(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_project_member(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.is_project_owner(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_project_owner(uuid, uuid) TO authenticated;

-- Swap the four recursive policies. Guard with a short lock_timeout so the
-- ACCESS EXCLUSIVE lock DROP POLICY needs can't queue behind live queries and
-- stall the app — it aborts instead if the table is busy. The migration runner
-- wraps this script in a single (implicit) transaction, so SET LOCAL scopes
-- correctly and the swap stays atomic without an explicit BEGIN/COMMIT.
SET LOCAL lock_timeout = '3s';

DROP POLICY IF EXISTS "Members and professors can read project members" ON public.project_members;
DROP POLICY IF EXISTS "Owners and professors can insert members" ON public.project_members;
DROP POLICY IF EXISTS "Owners and professors can update members" ON public.project_members;
DROP POLICY IF EXISTS "Owners and professors can delete members" ON public.project_members;

CREATE POLICY "Members and professors can read project members"
  ON public.project_members FOR SELECT
  USING (
    public.is_project_member(project_id, (select auth.uid()))
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = (select auth.uid())
    )
  );

CREATE POLICY "Owners and professors can insert members"
  ON public.project_members FOR INSERT
  WITH CHECK (
    public.is_project_owner(project_id, (select auth.uid()))
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = (select auth.uid())
    )
  );

CREATE POLICY "Owners and professors can update members"
  ON public.project_members FOR UPDATE
  USING (
    user_id = (select auth.uid())
    OR public.is_project_owner(project_id, (select auth.uid()))
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = (select auth.uid())
    )
  );

CREATE POLICY "Owners and professors can delete members"
  ON public.project_members FOR DELETE
  USING (
    user_id = (select auth.uid())
    OR public.is_project_owner(project_id, (select auth.uid()))
    OR project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = (select auth.uid())
    )
  );
