-- Widen module_items.item_type to accept 'image'.
--
-- The app has supported image items for a while: 'image' is in MODULE_ITEM_TYPES,
-- imageContentSchema exists, contentSchemaMap wires it up, and the Add-material
-- popover offers "Image". But the DB CHECK constraint listed only seven types, so
-- every insert failed with 23514 and the professor saw a generic "Failed to create
-- item". An entire content type was unusable.
--
-- Written drop-then-add (not a bare ADD) because repo and prod disagree about
-- whether this constraint exists at all:
--   * prod carries the seven-value constraint, inherited from docs/archive/schema.sql
--   * supabase/migrations/00000000000000_base_schema.sql declares item_type with
--     NO check, so a database built from migrations alone has none
-- DROP ... IF EXISTS converges both to the same eight-value constraint.
--
-- No NOT VALID/VALIDATE split: module_items is small (~76 rows), so the validating
-- scan is instantaneous and the brief ACCESS EXCLUSIVE lock is not worth splitting
-- across transactions. Revisit if this table ever grows by orders of magnitude.
--
-- docs/archive/schema.sql is updated in the same change so the standalone schema doc stops
-- re-seeding the seven-value version into any database built from it.

alter table module_items
  drop constraint if exists module_items_item_type_check;

alter table module_items
  add constraint module_items_item_type_check
  check (item_type = any (array[
    'lecture',
    'video',
    'image',
    'reference',
    'assignment',
    'note',
    'link',
    'section_divider'
  ]));
