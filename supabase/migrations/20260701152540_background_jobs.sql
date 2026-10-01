-- Migration: background_jobs — the reusable "Athenamite" background-job queue.
--
-- Why: several features need slow work done off the request path (course
-- content analysis, reports, exports). Scholera already solves each the same
-- way (durable Postgres queue + atomic claim RPC + route-kicked worker), but
-- re-implements the plumbing every time. This is the shared foundation: a
-- feature enqueues a job with a `type` + `params`; a generic worker claims it,
-- runs the registered pipeline, and reports progress. First consumer is the
-- Outcomes Alignment feature (design: harshil/outcomes-alignment/).
--
-- Difference from extraction_jobs: that table is service-role-only (RLS on, no
-- policies) because no user reads it. THIS table is CLIENT-READABLE — a course
-- "Alignment" tab + live roster subscribe via Realtime to show job progress.
-- So it carries concrete tenant columns (institution_id + nullable section_id)
-- and a SELECT-only RLS policy composed from existing audited helpers. All
-- WRITES still go through the service-role worker / server actions (admin
-- client), never the client — hence no INSERT/UPDATE/DELETE policy.
--
-- Concrete FK subjects (not a polymorphic subject_type/id) so cascade-delete
-- and referential integrity work and the Realtime RLS check stays cheap.

-- ── Table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,                        -- dispatch key → pipeline registry
  params jsonb NOT NULL DEFAULT '{}'::jsonb,  -- typed input (ids only, never secrets)
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed', 'partial')),
  progress jsonb NOT NULL DEFAULT '[]'::jsonb, -- per-worker: [{label, status, startedAt}] — small
  result jsonb,                               -- COMPACT rollup only; real output lives in domain tables
  summary text,                               -- one-line narratable completion summary
  error text,                                 -- failure message when status = 'failed'
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  section_id uuid REFERENCES public.course_sections(id) ON DELETE CASCADE, -- null = institution-level job
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,       -- who triggered it (audit)
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  claimed_by uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

COMMENT ON TABLE public.background_jobs IS
  'Generic Athenamite background-job queue. Client-readable (SELECT-only RLS by section/institution role); all writes via service-role worker / admin client. Claim via claim_next_job RPC.';

-- ── Indexes ────────────────────────────────────────────────────
-- Claim path: oldest pending (or expired-running) job.
CREATE INDEX IF NOT EXISTS idx_background_jobs_claim
  ON public.background_jobs (created_at)
  WHERE status IN ('pending', 'running');

-- RLS filter + lookups (FK columns are not auto-indexed by Postgres).
CREATE INDEX IF NOT EXISTS idx_background_jobs_section ON public.background_jobs (section_id);
CREATE INDEX IF NOT EXISTS idx_background_jobs_institution ON public.background_jobs (institution_id);

-- Dedup: at most one ACTIVE (pending/running) job per (institution, subject, type).
-- coalesce() gives institution-level jobs (section_id NULL) a stable dedup key,
-- since SQL treats NULLs as distinct in a plain unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_background_jobs_active
  ON public.background_jobs (
    institution_id,
    coalesce(section_id, '00000000-0000-0000-0000-000000000000'::uuid),
    type
  )
  WHERE status IN ('pending', 'running');

-- ── RLS ────────────────────────────────────────────────────────
ALTER TABLE public.background_jobs ENABLE ROW LEVEL SECURITY;

-- SELECT-only for authenticated clients (roster/tab reads, incl. Realtime).
-- No INSERT/UPDATE/DELETE policy → clients cannot write; only the service-role
-- worker and server actions (admin client) mutate. Authorization reuses the
-- existing audited helpers, deny-by-default:
--   • section-scoped job  → professor (owner) OR active section staff
--   • institution-scoped  → institution admin
CREATE POLICY "Section staff / institution admins can read their jobs"
  ON public.background_jobs FOR SELECT
  TO authenticated
  USING (
    (section_id IS NOT NULL AND public.is_section_owner_or_staff(section_id))
    OR (section_id IS NULL AND public.is_admin_of(institution_id))
  );

-- ── Atomic claim ───────────────────────────────────────────────
-- The ONLY way a worker should claim a job (supabase-js can't hold FOR UPDATE
-- across .select()/.update() under the pooler). Mirrors claim_next_extraction_job:
-- oldest pending-or-stale-running row, attempts < max_attempts (poison-pill
-- guard), FOR UPDATE SKIP LOCKED so concurrent workers never grab the same row.
-- Optional p_types filter lets a worker claim only certain job types.
CREATE OR REPLACE FUNCTION public.claim_next_job(
  p_worker_id uuid,
  p_types text[] DEFAULT NULL,
  p_claim_ttl_seconds int DEFAULT 900
)
RETURNS public.background_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed public.background_jobs;
BEGIN
  UPDATE public.background_jobs
  SET
    status = 'running',
    claimed_by = p_worker_id,
    claim_expires_at = now() + make_interval(secs => p_claim_ttl_seconds),
    started_at = COALESCE(started_at, now()),
    attempts = attempts + 1
  WHERE id = (
    SELECT id
    FROM public.background_jobs
    WHERE
      attempts < max_attempts
      AND (p_types IS NULL OR type = ANY(p_types))
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

COMMENT ON FUNCTION public.claim_next_job IS
  'Atomically claims the next pending (or expired-running) background job, optionally filtered by type. Returns NULL if none. Service-role only.';

-- ── Grants ─────────────────────────────────────────────────────
-- claim RPC is worker-only. Supabase auto-grants EXECUTE to anon/authenticated;
-- revoke it so no client can claim/mutate jobs, then grant service_role.
REVOKE ALL ON FUNCTION public.claim_next_job(uuid, text[], int) FROM public;
REVOKE ALL ON FUNCTION public.claim_next_job(uuid, text[], int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_job(uuid, text[], int) TO service_role;
