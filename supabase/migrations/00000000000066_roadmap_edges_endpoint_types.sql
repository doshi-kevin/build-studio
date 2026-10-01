-- Migration: Allow manual↔auto links on the roadmap (issue #124).
-- roadmap_edges is revived (it was dormant after the Module→Lecture→Topic
-- redesign) to connect ANY two boxes — auto module/item or manual module/lecture.
-- Endpoint types are realigned to the post-redesign node kinds.
-- Created: 2026-05-28

ALTER TABLE public.roadmap_edges DROP CONSTRAINT IF EXISTS roadmap_edges_from_node_type_check;
ALTER TABLE public.roadmap_edges
  ADD CONSTRAINT roadmap_edges_from_node_type_check
  CHECK (from_node_type IN ('module', 'module_item', 'manual_module', 'manual_lecture'));

ALTER TABLE public.roadmap_edges DROP CONSTRAINT IF EXISTS roadmap_edges_to_node_type_check;
ALTER TABLE public.roadmap_edges
  ADD CONSTRAINT roadmap_edges_to_node_type_check
  CHECK (to_node_type IN ('module', 'module_item', 'manual_module', 'manual_lecture'));

COMMENT ON TABLE public.roadmap_edges IS 'Professor-drawn links between any two roadmap boxes (auto module/item or manual module/lecture). Polymorphic endpoints (type,id); orphans filtered at read time.';
