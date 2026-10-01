-- Migration: background_jobs.subject_key — per-subject dedup for job types
-- whose unit of work is finer than a section, and pending-only dedup semantics.
--
-- Two changes to the active-job unique index:
--
-- 1. subject_key: the index deduped on (institution, section, type), which is
--    right for section-wide jobs (outcome alignment) but wrong for per-entity
--    jobs: two PDFs uploaded back-to-back would collide on type
--    'embed_material' and the second would silently never run. subject_key
--    (e.g. the module_item id) widens the dedup key. NULL for existing job
--    types ⇒ coalesce keeps their key shape identical.
--
-- 2. Pending-only (was pending+running): deduping against RUNNING jobs
--    swallows state changes that land mid-run — the running job already read
--    the old state, so an edit/delete during a run would NEVER be reconciled
--    (permanent stale/ghost vectors). Deduping only 'pending' lets exactly one
--    follow-up job queue behind a running one (further enqueues collide with
--    that pending row); when the running job finishes, the queued run reads
--    the final state and converges. Worst case per entity: one running + one
--    pending. (A concurrent worker MAY claim the pending job before the
--    running one finishes — a transient double-run with idempotent
--    deterministic-id writes — strictly better than permanent staleness.)

ALTER TABLE public.background_jobs ADD COLUMN IF NOT EXISTS subject_key text;

DROP INDEX IF EXISTS public.uq_background_jobs_active;

CREATE UNIQUE INDEX uq_background_jobs_pending
  ON public.background_jobs (
    institution_id,
    coalesce(section_id, '00000000-0000-0000-0000-000000000000'::uuid),
    type,
    coalesce(subject_key, '')
  )
  WHERE status = 'pending';

COMMENT ON COLUMN public.background_jobs.subject_key IS
  'Optional per-entity dedup key (e.g. a module_item id) so one job type can have one PENDING job per entity instead of per section. NULL = section/institution-level dedup.';
