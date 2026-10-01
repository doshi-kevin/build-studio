-- Migration: Roadmap Manual Editor — professor-created concept nodes, edges, materials.
-- Created: 2026-05-28
--
-- ADDITIVE layer on top of the auto-generated roadmap. modules + module_items
-- remain the ONLY source of truth for auto nodes; these tables hold ONLY
-- professor-created concepts and the edges/materials they draw. There is no
-- mirroring of modules and no "freeze" flag — newly uploaded modules continue
-- to appear on the roadmap automatically.
--
-- Edges use POLYMORPHIC endpoints (node_type, node_id) rather than foreign keys,
-- because an edge can connect a manual concept to an auto module/item node.
-- This mirrors the existing roadmap_node_status.node_id pattern (also a
-- polymorphic id with no FK). Orphaned edges (endpoint deleted) are cleaned up
-- in the deleteConceptNode action and filtered at read time in assembleRoadmapData.

-- ═══════════════════════════════════════════════════════════════
-- TABLES
-- ═══════════════════════════════════════════════════════════════

-- 1. roadmap_nodes — manual concept blocks (concept / sub_concept / milestone).
CREATE TABLE IF NOT EXISTS public.roadmap_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL CHECK (node_type IN ('concept', 'sub_concept', 'milestone')),
  title TEXT NOT NULL,
  description TEXT,
  position_x DOUBLE PRECISION NOT NULL DEFAULT 0,
  position_y DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'complete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.roadmap_nodes IS 'Manual professor-created concept blocks on the course roadmap. Auto nodes (modules/items) are NOT stored here.';

-- 2. roadmap_edges — manual links between any two nodes (manual or auto).
--    Polymorphic endpoints: no FK because endpoints may be module/module_item rows.
CREATE TABLE IF NOT EXISTS public.roadmap_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  from_node_type TEXT NOT NULL CHECK (from_node_type IN ('concept', 'sub_concept', 'milestone', 'module', 'module_item')),
  from_node_id UUID NOT NULL,
  to_node_type TEXT NOT NULL CHECK (to_node_type IN ('concept', 'sub_concept', 'milestone', 'module', 'module_item')),
  to_node_id UUID NOT NULL,
  edge_type TEXT NOT NULL DEFAULT 'prerequisite' CHECK (edge_type IN ('prerequisite', 'related')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (section_id, from_node_type, from_node_id, to_node_type, to_node_id),
  -- No self-loops
  CHECK (NOT (from_node_type = to_node_type AND from_node_id = to_node_id))
);

COMMENT ON TABLE public.roadmap_edges IS 'Manual links between roadmap nodes. Endpoints are polymorphic (type,id); orphans filtered at read time.';

-- 3. roadmap_node_materials — materials attached to a manual concept node.
--    section_id denormalized for simple RLS + tenant scoping.
CREATE TABLE IF NOT EXISTS public.roadmap_node_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES public.roadmap_nodes(id) ON DELETE CASCADE,
  module_item_id UUID REFERENCES public.module_items(id) ON DELETE CASCADE,
  external_url TEXT,
  external_title TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Must reference an existing module item OR an external URL
  CHECK (module_item_id IS NOT NULL OR external_url IS NOT NULL)
);

COMMENT ON TABLE public.roadmap_node_materials IS 'Materials (existing module items or external URLs) attached to manual concept nodes.';

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_roadmap_nodes_section ON public.roadmap_nodes(section_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_edges_section ON public.roadmap_edges(section_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_node_materials_section ON public.roadmap_node_materials(section_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_node_materials_node ON public.roadmap_node_materials(node_id);

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- Mirrors roadmap_node_status: professor (section owner) full CRUD,
-- enrolled students read-only.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.roadmap_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roadmap_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roadmap_node_materials ENABLE ROW LEVEL SECURITY;

-- ── roadmap_nodes ────────────────────────────────────────────────

CREATE POLICY "Professors manage section roadmap nodes"
  ON public.roadmap_nodes FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = roadmap_nodes.section_id AND cs.professor_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = roadmap_nodes.section_id AND cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Enrolled students read roadmap nodes"
  ON public.roadmap_nodes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.section_id = roadmap_nodes.section_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled', 'completed')
    )
  );

-- ── roadmap_edges ────────────────────────────────────────────────

CREATE POLICY "Professors manage section roadmap edges"
  ON public.roadmap_edges FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = roadmap_edges.section_id AND cs.professor_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = roadmap_edges.section_id AND cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Enrolled students read roadmap edges"
  ON public.roadmap_edges FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.section_id = roadmap_edges.section_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled', 'completed')
    )
  );

-- ── roadmap_node_materials ───────────────────────────────────────

CREATE POLICY "Professors manage section roadmap node materials"
  ON public.roadmap_node_materials FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = roadmap_node_materials.section_id AND cs.professor_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.course_sections cs
      WHERE cs.id = roadmap_node_materials.section_id AND cs.professor_id = auth.uid()
    )
  );

CREATE POLICY "Enrolled students read roadmap node materials"
  ON public.roadmap_node_materials FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.section_id = roadmap_node_materials.section_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled', 'completed')
    )
  );
