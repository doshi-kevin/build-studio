-- Canvas band ordering: professors/students can drag notes and placed
-- resources (quiz/assignment/live session cards) up and down within a module's
-- branch list on the roadmap canvas. The order persists as a sortable position:
--   - roadmap_notes.position    — order of a note within its module's band
--   - roadmap_edges.position    — order of a placed resource (used on
--                                 module→resource placement edges only)
-- Fractional values (drop between neighbors → midpoint); NULL = default order
-- (creation sequence), so no backfill is needed. Both tables already have RLS
-- (notes: 20260710194202, edges: 00000000000064) — a new column inherits it.

ALTER TABLE roadmap_notes ADD COLUMN position DOUBLE PRECISION;
ALTER TABLE roadmap_edges ADD COLUMN position DOUBLE PRECISION;
