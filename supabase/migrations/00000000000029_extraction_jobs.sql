-- Migration: extraction_jobs — durable background queue for PDF/PPTX extraction.
--
-- Why: the current fire-and-forget server action in
-- src/app/(dashboard)/professor/courses/[sectionId]/modules/actions.ts
-- silently fails when Cloud Run recycles an instance mid-run. Of 10 "completed"
-- lecture extractions in prod, 0 have images saved — strong evidence the work
-- path gets killed before storing results. This migration introduces a
-- Postgres-backed queue that the worker (src/app/api/extraction-worker/kick)
-- claims atomically, so individual job failures don't destroy state and
-- stale jobs can be re-claimed on the next kick.
--
-- Design notes:
--   • Service-role only — RLS is ON with zero policies, matching invite_redirects.
--     Jobs carry enough payload to re-execute, but no user should query them
--     directly. The admin UI page in PR 5 will use createAdminClient().
--   • `kind` column is a discriminator so the same queue can handle new job
--     types later (e.g. 'cleanup-storage' enqueued by the module_items delete
--     trigger, or 'backfill-extraction' for one-time admin scripts).
--   • `claim_next_extraction_job()` is the ONLY way workers should claim a
--     row. `supabase-js` cannot hold a FOR UPDATE lock across .select()/.update()
--     calls under the transaction pooler, so the atomic claim lives in a
--     single SQL statement wrapped as an RPC.
--   • `cancel_pending_extraction_jobs(p_module_item_id)` lets enqueueExtractionJob()
--     supersede prior jobs for the same item when a professor re-uploads.
--   • Trigger on module_items DELETE enqueues a cleanup-storage job so we
--     don't leak PNGs in the course-materials bucket.
--
-- Run in Supabase SQL Editor (or `supabase db push` if using local dev setup).

-- ── Table ──────────────────────────────────────────────────────
-- module_item_id is nullable AND uses ON DELETE CASCADE. This split
-- lets 'extract' jobs be auto-reaped when a professor deletes the
-- parent lecture (desired: abort any still-running work), while
-- 'cleanup-storage' jobs (enqueued BY the delete trigger below) are
-- inserted with module_item_id = NULL so they survive the cascade.
-- The target item id for cleanup lives in payload.moduleItemId.
CREATE TABLE IF NOT EXISTS public.extraction_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'extract'
    CHECK (kind IN ('extract', 'cleanup-storage', 'backfill-extraction')),
  module_item_id uuid REFERENCES public.module_items(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'partial')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  claimed_by uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  heartbeat_at timestamptz,
  -- 'extract' and 'backfill-extraction' jobs always need a parent item.
  -- Only 'cleanup-storage' is allowed to have a NULL module_item_id
  -- because its sole purpose is to survive the parent's deletion.
  CONSTRAINT module_item_required_for_extract
    CHECK (kind = 'cleanup-storage' OR module_item_id IS NOT NULL)
);

COMMENT ON TABLE public.extraction_jobs IS
  'Durable queue for PDF/PPTX extraction work. Service-role only; claim via claim_next_extraction_job RPC.';

-- ── Indexes ────────────────────────────────────────────────────
-- Primary claim path: find oldest pending (or expired-running) job of any kind.
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_claim
  ON public.extraction_jobs (created_at)
  WHERE status IN ('pending', 'running');

-- Look up all jobs for a given module item (for cancellation + admin UI).
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_module_item
  ON public.extraction_jobs (module_item_id);

-- Discriminator-aware listing (e.g. only extracts, only cleanups).
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_kind_status
  ON public.extraction_jobs (kind, status);

-- ── RLS ────────────────────────────────────────────────────────
ALTER TABLE public.extraction_jobs ENABLE ROW LEVEL SECURITY;

-- No policies: only service-role (admin client) can read/write this table.
-- Mirrors the invite_redirects pattern.

-- ── Atomic claim ───────────────────────────────────────────────
-- Called by the worker at src/app/api/extraction-worker/kick.
-- Atomically finds the oldest pending-or-stale-running job and marks it
-- running under the caller's worker_id, with a TTL. Returns NULL if no job.
--
-- The WHERE clause treats `status='running' AND claim_expires_at < now()` as
-- re-claimable, which means a worker that died mid-job (Cloud Run recycle,
-- OOM, network blip) has its job picked up on the next kick after TTL expiry.
--
-- FOR UPDATE SKIP LOCKED guarantees two concurrent workers each grab a
-- different row (or one gets NULL), never the same one.
CREATE OR REPLACE FUNCTION public.claim_next_extraction_job(
  p_worker_id uuid,
  p_claim_ttl_seconds int DEFAULT 900
)
RETURNS public.extraction_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed public.extraction_jobs;
BEGIN
  -- Poison-pill guard: `attempts < max_attempts` stops us from forever
  -- re-claiming a job that consistently crashes the worker. Once a job
  -- has burned through its attempts it stays in 'pending' (or stale
  -- 'running') with attempts = max_attempts and is invisible to this
  -- claim. A periodic sweep (PR 3) marks those as 'failed'.
  UPDATE public.extraction_jobs
  SET
    status = 'running',
    claimed_by = p_worker_id,
    claim_expires_at = now() + make_interval(secs => p_claim_ttl_seconds),
    started_at = COALESCE(started_at, now()),
    attempts = attempts + 1,
    heartbeat_at = now()
  WHERE id = (
    SELECT id
    FROM public.extraction_jobs
    WHERE
      attempts < max_attempts
      AND (
        status = 'pending'
        OR (status = 'running' AND claim_expires_at < now())
      )
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING * INTO claimed;

  RETURN claimed;
END;
$$;

COMMENT ON FUNCTION public.claim_next_extraction_job IS
  'Atomically claims the next pending (or expired-running) extraction job for the given worker. Returns NULL if the queue is empty. Use this — not supabase-js .select()/.update() — to avoid pooler-related lock loss.';

-- ── Supersede prior jobs on re-upload ──────────────────────────
-- Called by enqueueExtractionJob() before inserting a new row, so that
-- a professor re-uploading a file doesn't end up with two workers racing
-- against the same module_item_id.
CREATE OR REPLACE FUNCTION public.cancel_pending_extraction_jobs(
  p_module_item_id uuid
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cancelled_count int;
BEGIN
  UPDATE public.extraction_jobs
  SET
    status = 'failed',
    error = CASE
      WHEN error IS NULL OR error = '' THEN '[superseded by newer job]'
      ELSE error || E'\n[superseded by newer job]'
    END,
    completed_at = now()
  WHERE
    module_item_id = p_module_item_id
    AND status IN ('pending', 'running');

  GET DIAGNOSTICS cancelled_count = ROW_COUNT;
  RETURN cancelled_count;
END;
$$;

COMMENT ON FUNCTION public.cancel_pending_extraction_jobs IS
  'Marks all pending/running jobs for a module item as failed=superseded. Call this before enqueueing a new extract job for the same item to avoid racing workers.';

-- ── Cleanup trigger on module item delete ──────────────────────
-- When a professor deletes a lecture, we enqueue a cleanup-storage job
-- so the worker can remove the extracted images from the bucket. We can't
-- do the storage delete from a Postgres trigger (no outbound network),
-- so we let the worker handle it on its next kick.
--
-- CRITICAL: we insert the cleanup row with module_item_id = NULL.
-- If we used OLD.id for the FK, the ON DELETE CASCADE on module_items
-- would wipe our newly-inserted row the moment the DELETE proceeds past
-- this BEFORE trigger. Setting NULL + storing the id in payload keeps
-- the cleanup job alive after the parent is gone. The CHECK constraint
-- on the table enforces that only 'cleanup-storage' kind may omit it.
CREATE OR REPLACE FUNCTION public.enqueue_cleanup_on_module_item_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only enqueue if there's anything to clean up. Non-lecture items have
  -- no extraction output.
  IF OLD.item_type = 'lecture' THEN
    INSERT INTO public.extraction_jobs (kind, module_item_id, status, payload)
    VALUES (
      'cleanup-storage',
      NULL,
      'pending',
      jsonb_build_object(
        'moduleItemId', OLD.id,
        'content', OLD.content,
        'deletedAt', now()
      )
    );
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_module_item_cleanup ON public.module_items;
CREATE TRIGGER trg_module_item_cleanup
  BEFORE DELETE ON public.module_items
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_cleanup_on_module_item_delete();

-- ── Grants ─────────────────────────────────────────────────────
-- Explicit grants for the service_role so the admin client can call the RPCs.
-- (service_role already bypasses RLS on the table itself.)
GRANT EXECUTE ON FUNCTION public.claim_next_extraction_job(uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_pending_extraction_jobs(uuid) TO service_role;

-- The trigger function is invoked by whichever role deletes a module_items
-- row (typically `authenticated` — a professor deleting a lecture). Even
-- though the body runs as SECURITY DEFINER, the invoker still needs EXECUTE
-- on the function or the DELETE fails with "permission denied". Grant to
-- the roles that can delete module items today.
GRANT EXECUTE ON FUNCTION public.enqueue_cleanup_on_module_item_delete() TO authenticated, service_role;
