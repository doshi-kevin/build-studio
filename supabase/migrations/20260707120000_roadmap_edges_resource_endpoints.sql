-- Migration: allow roadmap links to point at course resources.
-- The roadmap now shows quizzes, assignments, and live sessions (with their
-- polls / pop-quizzes) as their own boxes. Professors can link any of these into
-- the map, so roadmap_edges endpoints are widened beyond the module/manual kinds.
-- Endpoints stay polymorphic (type, id); an edge whose endpoint no longer resolves
-- to a live box is dropped at read time, so deleting a resource cleans up its links.
-- Created: 2026-07-07

ALTER TABLE public.roadmap_edges DROP CONSTRAINT IF EXISTS roadmap_edges_from_node_type_check;
ALTER TABLE public.roadmap_edges
  ADD CONSTRAINT roadmap_edges_from_node_type_check
  CHECK (from_node_type IN (
    'module', 'module_item', 'manual_module', 'manual_lecture',
    'quiz', 'assignment', 'live_session', 'live_poll', 'live_quiz'
  ));

ALTER TABLE public.roadmap_edges DROP CONSTRAINT IF EXISTS roadmap_edges_to_node_type_check;
ALTER TABLE public.roadmap_edges
  ADD CONSTRAINT roadmap_edges_to_node_type_check
  CHECK (to_node_type IN (
    'module', 'module_item', 'manual_module', 'manual_lecture',
    'quiz', 'assignment', 'live_session', 'live_poll', 'live_quiz'
  ));

COMMENT ON TABLE public.roadmap_edges IS 'Professor-drawn links between any two roadmap boxes (auto module/item, manual module/lecture, or a course resource: quiz/assignment/live_session/live_poll/live_quiz). Polymorphic endpoints (type,id); orphans filtered at read time.';
