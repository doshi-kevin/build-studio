-- Fix: emitEvent's upsert cannot dedup against the PARTIAL unique index.
--
-- 20260702000000_shared_feed_items.sql created a partial unique index:
--   ON feed_items(recipient_id, type, entity_id) WHERE entity_id IS NOT NULL
-- supabase-js `.upsert(rows, { onConflict: 'recipient_id,type,entity_id' })` emits
-- `ON CONFLICT (recipient_id, type, entity_id) DO NOTHING` with NO predicate, so Postgres
-- can't match the partial index and every emitEvent insert fails with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
--
-- Replace it with a FULL unique index so the ON CONFLICT matches. entity_id NULLs stay
-- distinct in a unique index (Postgres default), so entity-less events still insert
-- freely while entity-anchored events dedup on (recipient_id, type, entity_id).

DROP INDEX IF EXISTS public.uq_feed_items_recipient_type_entity;

CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_items_recipient_type_entity
  ON public.feed_items (recipient_id, type, entity_id);
