-- Migration: Roadmap Manual Editor redesign (issue #124) — switch the manual
-- layer from an abstract concept-map (concept/sub_concept/milestone + free edges)
-- to a simple Module → Lecture → Topic outline that auto-connects by hierarchy.
-- Created: 2026-05-28
--
-- Clears the throwaway test rows from the prior concept iteration (no real data
-- existed). roadmap_edges / roadmap_node_materials are left in place but become
-- dormant (the redesign uses neither — topics are plain text labels).

-- Clear prior-iteration test data (materials FK → nodes, so clear it first).
DELETE FROM public.roadmap_node_materials;
DELETE FROM public.roadmap_edges;
DELETE FROM public.roadmap_nodes;

-- node_type now describes the hierarchy level instead of an abstract concept kind.
ALTER TABLE public.roadmap_nodes DROP CONSTRAINT IF EXISTS roadmap_nodes_node_type_check;
ALTER TABLE public.roadmap_nodes
  ADD CONSTRAINT roadmap_nodes_node_type_check CHECK (node_type IN ('module', 'lecture'));

-- A lecture belongs to a manual module; modules have parent_id = NULL.
ALTER TABLE public.roadmap_nodes
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.roadmap_nodes(id) ON DELETE CASCADE;

-- Topic labels live directly on lecture nodes as plain text chips.
ALTER TABLE public.roadmap_nodes
  ADD COLUMN IF NOT EXISTS topics TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_roadmap_nodes_parent ON public.roadmap_nodes(parent_id);

COMMENT ON TABLE public.roadmap_nodes IS 'Manual roadmap nodes: node_type=module (top-level box) or lecture (child of a module via parent_id). Lecture topics are plain text labels in the topics array.';
