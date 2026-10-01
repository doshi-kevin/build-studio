-- Retire the old roadmap's storage (roadmap-engine.md §16, slice 3).
--
-- The old roadmap canvas is deleted in the same change as this migration, and
-- nothing in the app reads or writes any of these tables any more. Each one
-- stored state the redesigned roadmap has no concept of:
--
--   · roadmap_node_status  — the professor's hand-ticked not_started /
--                            in_progress / complete per module + module_item.
--                            Status is now DERIVED on read from what actually
--                            happened (§11 decision 2, `loadRoadmapCoverage`),
--                            so a stored value can only disagree with reality.
--   · roadmap_nodes        — manual "Module → Lecture → Topic" boxes the old
--                            canvas let a professor draw by hand. They carried no
--                            file, no room and no lifecycle, so there is nothing
--                            to derive coverage from; they retire with the canvas
--                            that authored them (§11 decision 4).
--                            roadmap_node_materials is its child (FK → id).
--   · roadmap_notes        — sticky notes and separators authored on the old
--                            canvas. The redesigned roadmap reads both from
--                            `module_items` instead (type 'note' and
--                            'section_divider'), which is where the Modules page
--                            already authors them.
--
-- KEPT deliberately, because the new roadmap does use them:
--   · roadmap_edges     — module ↔ resource placement (still written by the quiz /
--                         assignment / live-classroom placement flows) plus
--                         prerequisite/related xrefs. Its endpoints are
--                         polymorphic (type, id) with NO foreign key to
--                         roadmap_nodes, so dropping that table cannot cascade
--                         into placement. Rows that pointed at a manual box are
--                         already inert: assembleRoadmapData keeps an edge only
--                         when BOTH endpoints resolve to a rendered box.
--   · roadmap_progress  — the student's own check-offs, read by the coverage layer
--                         and written via roadmap_set_node_checkoff.
--
-- Data loss is intended and confirmed: these rows describe a UI that no longer
-- exists. Dropping a table takes its RLS policies and indexes with it, so there
-- is no separate policy cleanup.

-- Child first — roadmap_node_materials.node_id references roadmap_nodes(id).
DROP TABLE IF EXISTS public.roadmap_node_materials;
DROP TABLE IF EXISTS public.roadmap_nodes;
DROP TABLE IF EXISTS public.roadmap_node_status;
DROP TABLE IF EXISTS public.roadmap_notes;

-- Pin-to-page went with the old student roadmap. Its per-node value lived as a
-- `pinnedPage` KEY inside roadmap_progress.nodeProgress (JSONB) — never a column —
-- so existing keys simply stop having a reader; there is nothing to migrate off.
-- roadmap_set_node_checkoff (the check-off writer) and roadmap_assessment_counts
-- are untouched.
DROP FUNCTION IF EXISTS public.roadmap_set_node_page(UUID, UUID, TEXT, INTEGER);
