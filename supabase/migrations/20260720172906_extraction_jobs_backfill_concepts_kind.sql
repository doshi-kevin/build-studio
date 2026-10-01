-- New extraction_jobs kind: 'backfill-concepts'.
--
-- Backfills stored quiz concepts (module_items.content.concepts, design §11a)
-- for legacy items whose extraction predates upload-time concept storage. It
-- runs ONLY the concept pass over the ALREADY-STORED extraction pages — one
-- cheap LLM call per item — unlike 'backfill-extraction', which re-runs the
-- whole pipeline (download, parse, vision) and re-bills its costs.
--
-- Item-scoped like 'extract', so module_item_id stays required for it.
-- No RLS/policy change: extraction_jobs keeps its existing admin-only access.

alter table public.extraction_jobs drop constraint if exists extraction_jobs_kind_check;
alter table public.extraction_jobs add constraint extraction_jobs_kind_check
  check (kind in ('extract', 'cleanup-storage', 'backfill-extraction', 'backfill-concepts', 'recompute-mastery'));
