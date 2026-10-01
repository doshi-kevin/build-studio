-- Migration: append_job_progress — atomic, race-free progress updates.
--
-- Slice 1's worker.reportProgress did a read-modify-write of the progress jsonb.
-- That's safe across workers (one worker owns a job), but a pipeline that
-- reports progress CONCURRENTLY (the outcome_alignment Map fan-out) could lose
-- an update to itself. This RPC makes a single atomic UPDATE that dedupes by
-- label (latest transition wins) and appends — no lost updates under fan-out.
-- Service-role only, mirroring claim_next_job.

CREATE OR REPLACE FUNCTION public.append_job_progress(p_job_id uuid, p_entry jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.background_jobs
  SET progress =
    COALESCE(
      (SELECT jsonb_agg(e)
       FROM jsonb_array_elements(progress) e
       WHERE e->>'label' IS DISTINCT FROM (p_entry->>'label')),
      '[]'::jsonb
    ) || jsonb_build_array(p_entry)
  WHERE id = p_job_id;
$$;

COMMENT ON FUNCTION public.append_job_progress IS
  'Atomically dedupe-by-label and append a progress entry to a background job. Race-free under concurrent fan-out. Service-role only.';

REVOKE ALL ON FUNCTION public.append_job_progress(uuid, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.append_job_progress(uuid, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_job_progress(uuid, jsonb) TO service_role;
