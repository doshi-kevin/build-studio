-- Professor-defined project structure: master phases + polymorphic phase items.
--
-- project_master_phases: the professor's official phases for a project (the
-- "organizer" structure). Distinct from project_phases, which remains the
-- per-team task tracking students own.
--
-- project_phase_items: places an existing assignment OR quiz into a master
-- phase. Placement is a tag — it never modifies the underlying item's dates.
-- An item can be placed at most once per project (partial unique indexes),
-- so a concurrent double-drop upserts into a move instead of duplicating.
--
-- Writes go exclusively through server actions using the admin client after
-- verifySectionAccess + canWriteAsStaff, so policies are SELECT-only
-- (no FOR ALL write hole; see .claude/rules/security-migrations.md).

-- ═══════════════════════════════════════════════════════════════
-- TABLES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.project_master_phases (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  position INTEGER NOT NULL DEFAULT 0,
  start_date DATE,
  end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.project_phase_items (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_id UUID NOT NULL REFERENCES public.project_master_phases(id) ON DELETE CASCADE,
  -- Denormalized from phase so "placed at most once per project" is a
  -- DB-enforceable constraint (partial unique indexes below).
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('assignment', 'quiz')),
  assignment_id UUID REFERENCES public.assignments(id) ON DELETE CASCADE,
  quiz_id UUID REFERENCES public.quizzes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (item_type = 'assignment' AND assignment_id IS NOT NULL AND quiz_id IS NULL)
    OR (item_type = 'quiz' AND quiz_id IS NOT NULL AND assignment_id IS NULL)
  )
);

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_master_phases_project
  ON public.project_master_phases(project_id);
-- "idx_phase_items_*" is taken by the student checklist table phase_items;
-- prefix with the full table name to avoid the collision.
CREATE INDEX IF NOT EXISTS idx_project_phase_items_phase
  ON public.project_phase_items(phase_id);
CREATE INDEX IF NOT EXISTS idx_project_phase_items_project
  ON public.project_phase_items(project_id);

-- One placement per item per project (NULLs never conflict, so the two
-- constraints coexist). Real constraints — not partial indexes — so
-- PostgREST upsert can infer them: a concurrent double-drop becomes a
-- move instead of a duplicate. They double as the FK-column indexes.
ALTER TABLE public.project_phase_items
  ADD CONSTRAINT uq_phase_items_assignment UNIQUE (project_id, assignment_id);
ALTER TABLE public.project_phase_items
  ADD CONSTRAINT uq_phase_items_quiz UNIQUE (project_id, quiz_id);

-- ═══════════════════════════════════════════════════════════════
-- GRANTS
-- ═══════════════════════════════════════════════════════════════
-- Default privileges don't grant SELECT/DML on new tables to the Supabase
-- roles in all environments (observed locally), so be explicit. authenticated
-- gets SELECT only (RLS below narrows rows); writes go through service_role.

GRANT SELECT ON public.project_master_phases, public.project_phase_items TO authenticated;
GRANT ALL ON public.project_master_phases, public.project_phase_items TO service_role;

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (SELECT-only; writes via admin client)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.project_master_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_phase_items ENABLE ROW LEVEL SECURITY;

-- Policies scope by BOTH the caller's role (professor owns the section / student
-- enrolled in it) AND institution_id: projects/enrollments carry no institution_id,
-- so the tenant is reached via course_sections and matched to the row's own column.
DROP POLICY IF EXISTS "Professors can read master phases" ON public.project_master_phases;
CREATE POLICY "Professors can read master phases"
  ON public.project_master_phases FOR SELECT
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = (SELECT auth.uid())
        AND cs.institution_id = project_master_phases.institution_id
    )
  );

DROP POLICY IF EXISTS "Enrolled students can read master phases" ON public.project_master_phases;
CREATE POLICY "Enrolled students can read master phases"
  ON public.project_master_phases FOR SELECT
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.enrollments e ON e.section_id = p.section_id
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE e.student_id = (SELECT auth.uid())
        AND e.status IN ('enrolled', 'active', 'completed')
        AND p.visibility IN ('course', 'public')
        AND cs.institution_id = project_master_phases.institution_id
    )
  );

DROP POLICY IF EXISTS "Professors can read phase items" ON public.project_phase_items;
CREATE POLICY "Professors can read phase items"
  ON public.project_phase_items FOR SELECT
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = (SELECT auth.uid())
        AND cs.institution_id = project_phase_items.institution_id
    )
  );

DROP POLICY IF EXISTS "Enrolled students can read phase items" ON public.project_phase_items;
CREATE POLICY "Enrolled students can read phase items"
  ON public.project_phase_items FOR SELECT
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.enrollments e ON e.section_id = p.section_id
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE e.student_id = (SELECT auth.uid())
        AND e.status IN ('enrolled', 'active', 'completed')
        AND p.visibility IN ('course', 'public')
        AND cs.institution_id = project_phase_items.institution_id
    )
  );
