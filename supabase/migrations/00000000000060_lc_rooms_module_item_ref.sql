-- Live Classroom: Link rooms to source module items.
-- Adds module_item_id FK and source_file_path snapshot so annotations,
-- future transcripts, and ML training data can trace back to the
-- original document even if the module item is later deleted.

ALTER TABLE lc_rooms
  ADD COLUMN module_item_id uuid REFERENCES module_items(id) ON DELETE SET NULL;

ALTER TABLE lc_rooms
  ADD COLUMN source_file_path text;

CREATE INDEX idx_lc_rooms_module_item
  ON lc_rooms (module_item_id)
  WHERE module_item_id IS NOT NULL;
