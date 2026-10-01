-- Reuse the durable extraction_jobs queue for Topic-Mastery recompute.
--
-- Mastery recompute is event-triggered (a graded quiz/assignment/live-quiz, or a
-- topic config/mapping/exclude change enqueues a job) and drained by the same
-- worker + claim RPC + 5-min sweep as extraction. A recompute job is section-
-- scoped (sectionId in payload) and has no module_item, so it must be allowed to
-- carry a NULL module_item_id — same exception 'cleanup-storage' already gets.

alter table public.extraction_jobs drop constraint if exists extraction_jobs_kind_check;
alter table public.extraction_jobs add constraint extraction_jobs_kind_check
  check (kind in ('extract', 'cleanup-storage', 'backfill-extraction', 'recompute-mastery'));

alter table public.extraction_jobs drop constraint if exists module_item_required_for_extract;
alter table public.extraction_jobs add constraint module_item_required_for_extract
  check (kind in ('cleanup-storage', 'recompute-mastery') or module_item_id is not null);
