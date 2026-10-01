-- Roadmap separators: a frontier-style divider line (editable label) that a
-- professor/student can drop between modules OR between a module's materials on
-- the canvas. It reuses the roadmap_notes table wholesale — same author/section/
-- institution scoping, same RLS, same drag-position column — differing only in
-- how it renders. A 'separator' anchored to the sentinel module_key 'spine'
-- sits between module rows; anchored to a real module key it sits in that
-- module's material band.
--
-- New column inherits the table's existing RLS (20260710194202); no backfill
-- needed (default 'note' keeps every existing row a note).

ALTER TABLE roadmap_notes
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'separator'));
