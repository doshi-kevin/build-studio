-- Project grading engine: phase-weighted, team + individual.
--
-- Each placed phase item becomes a graded component with a weight (points it
-- contributes to the project total), a grain (team = one shared score, or
-- individual = one per student), a scoring mode (numeric = auto-pulled from the
-- assignment/quiz/attendance source, or levels = a manual level pick), and
-- optional levels. A "manual" item is a free column with its own title + max;
-- an "attendance" item derives a rate from lc_attendance in the phase window.
--
-- A student's project grade is computed on read as Σ (earned/possible × weight)
-- over the items that apply to them; only manual/level results are persisted
-- (project_item_scores). Visibility is gated by an explicit release row.

-- ═══════════════════════════════════════════════════════════════
-- 1. Grading config on placed phase items
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.project_phase_items
  ADD COLUMN IF NOT EXISTS weight NUMERIC NOT NULL DEFAULT 0
    CHECK (weight >= 0 AND weight <= 1000),
  ADD COLUMN IF NOT EXISTS grain TEXT NOT NULL DEFAULT 'individual'
    CHECK (grain IN ('team', 'individual')),
  ADD COLUMN IF NOT EXISTS scoring_mode TEXT NOT NULL DEFAULT 'numeric'
    CHECK (scoring_mode IN ('numeric', 'levels')),
  ADD COLUMN IF NOT EXISTS levels JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS manual_title TEXT,
  ADD COLUMN IF NOT EXISTS manual_max NUMERIC
    CHECK (manual_max IS NULL OR manual_max > 0);

-- Widen item_type (was assignment|quiz) to cover attendance + manual, which
-- carry neither an assignment_id nor a quiz_id.
ALTER TABLE public.project_phase_items DROP CONSTRAINT IF EXISTS project_phase_items_item_type_check;
ALTER TABLE public.project_phase_items DROP CONSTRAINT IF EXISTS project_phase_items_check;

ALTER TABLE public.project_phase_items
  ADD CONSTRAINT project_phase_items_item_type_check
  CHECK (item_type IN ('assignment', 'quiz', 'attendance', 'manual'));

ALTER TABLE public.project_phase_items
  ADD CONSTRAINT project_phase_items_link_check CHECK (
    (item_type = 'assignment' AND assignment_id IS NOT NULL AND quiz_id IS NULL)
    OR (item_type = 'quiz' AND quiz_id IS NOT NULL AND assignment_id IS NULL)
    OR (item_type IN ('attendance', 'manual') AND assignment_id IS NULL AND quiz_id IS NULL)
  );

-- ═══════════════════════════════════════════════════════════════
-- 2. project_item_scores — persisted manual / level results only
-- ═══════════════════════════════════════════════════════════════
-- One row per (item, target). A team-grained score has team_id set + student_id
-- NULL; an individual score has student_id set + team_id NULL. NULLS NOT
-- DISTINCT (PG15+) makes the unique treat the NULL half as a real key so upsert
-- can conflict-target it.

CREATE TABLE IF NOT EXISTS public.project_item_scores (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_item_id UUID NOT NULL REFERENCES public.project_phase_items(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  team_id UUID REFERENCES public.project_teams(id) ON DELETE CASCADE,
  student_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  earned NUMERIC,
  level_id TEXT,
  graded_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  graded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_item_scores_target_check CHECK (
    (team_id IS NOT NULL AND student_id IS NULL)
    OR (student_id IS NOT NULL AND team_id IS NULL)
  ),
  CONSTRAINT uq_project_item_score UNIQUE NULLS NOT DISTINCT (phase_item_id, team_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_project_item_scores_project ON public.project_item_scores(project_id);
CREATE INDEX IF NOT EXISTS idx_project_item_scores_student ON public.project_item_scores(student_id);
CREATE INDEX IF NOT EXISTS idx_project_item_scores_team ON public.project_item_scores(team_id);
CREATE INDEX IF NOT EXISTS idx_project_item_scores_institution ON public.project_item_scores(institution_id);

-- ═══════════════════════════════════════════════════════════════
-- 3. project_grade_releases — one row per released project
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.project_grade_releases (
  project_id UUID NOT NULL PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_project_grade_releases_institution ON public.project_grade_releases(institution_id);

-- ═══════════════════════════════════════════════════════════════
-- GRANTS (authenticated SELECT only; writes via service_role)
-- ═══════════════════════════════════════════════════════════════

GRANT SELECT ON public.project_item_scores, public.project_grade_releases TO authenticated;
GRANT ALL ON public.project_item_scores, public.project_grade_releases TO service_role;

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (SELECT-only; writes via admin client)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.project_item_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_grade_releases ENABLE ROW LEVEL SECURITY;

-- Policies scope by BOTH role AND institution_id. projects/enrollments carry no
-- institution_id, so the tenant is reached via course_sections and matched to the
-- row's own column. Student status list mirrors the server gate ('enrolled' too).

-- Professors read their section's item scores.
DROP POLICY IF EXISTS "Professors can read project item scores" ON public.project_item_scores;
CREATE POLICY "Professors can read project item scores"
  ON public.project_item_scores FOR SELECT
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = (SELECT auth.uid())
        AND cs.institution_id = project_item_scores.institution_id
    )
  );

-- Students read their OWN individual scores + their team's shared scores, and
-- only once the project's grades are released (defense in depth; the compute
-- also gates on release server-side). The release row they check is itself
-- tenant- and enrollment-scoped by its own policy below.
DROP POLICY IF EXISTS "Students can read their released project item scores" ON public.project_item_scores;
CREATE POLICY "Students can read their released project item scores"
  ON public.project_item_scores FOR SELECT
  USING (
    project_id IN (
      SELECT r.project_id FROM public.project_grade_releases r
      WHERE r.institution_id = project_item_scores.institution_id
    )
    AND (
      student_id = (SELECT auth.uid())
      OR (
        student_id IS NULL
        AND team_id IN (
          SELECT pm.team_id FROM public.project_members pm
          WHERE pm.user_id = (SELECT auth.uid())
        )
      )
    )
  );

-- Professors read their section's release rows.
DROP POLICY IF EXISTS "Professors can read project grade releases" ON public.project_grade_releases;
CREATE POLICY "Professors can read project grade releases"
  ON public.project_grade_releases FOR SELECT
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE cs.professor_id = (SELECT auth.uid())
        AND cs.institution_id = project_grade_releases.institution_id
    )
  );

-- Enrolled students may see whether their project's grades are released.
DROP POLICY IF EXISTS "Enrolled students can read project grade releases" ON public.project_grade_releases;
CREATE POLICY "Enrolled students can read project grade releases"
  ON public.project_grade_releases FOR SELECT
  USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.enrollments e ON e.section_id = p.section_id
      JOIN public.course_sections cs ON cs.id = p.section_id
      WHERE e.student_id = (SELECT auth.uid())
        AND e.status IN ('enrolled', 'active', 'completed')
        AND p.visibility IN ('course', 'public')
        AND cs.institution_id = project_grade_releases.institution_id
    )
  );
