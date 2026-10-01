-- Migration: harden persist_ai_outcome_alignments against non-uuid evidence ids.
--
-- The pipeline can emit evidence with a non-uuid source id (e.g. a CLO whose id
-- lives in course_sections.settings JSON like "lo-6"). The prior version cast
-- evidence_source_id directly to uuid, so ONE such row aborted the entire insert
-- ("invalid input syntax for type uuid") → the whole run persisted 0 rows and the
-- job failed. Gather now sends null for CLOs, but harden the RPC too: only cast
-- when the value is uuid-shaped, else store null. One malformed id can no longer
-- zero out an otherwise-good run.

CREATE OR REPLACE FUNCTION public.persist_ai_outcome_alignments(
  p_section_id uuid,
  p_institution_id uuid,
  p_created_by uuid,
  p_rows jsonb
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_count int;
BEGIN
  DELETE FROM public.course_outcome_alignments
  WHERE section_id = p_section_id AND source = 'ai';

  INSERT INTO public.course_outcome_alignments (
    section_id, institution_id, indicator_id, level,
    evidence_source_type, evidence_source_id, evidence_text, attainment,
    source, status, created_by
  )
  SELECT
    p_section_id,
    p_institution_id,
    (r->>'indicator_id')::uuid,
    r->>'level',
    r->>'evidence_source_type',
    -- Only accept a uuid-shaped source id; anything else (e.g. a CLO's "lo-6")
    -- becomes null rather than aborting the whole insert.
    CASE
      WHEN r->>'evidence_source_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (r->>'evidence_source_id')::uuid
      ELSE NULL
    END,
    r->>'evidence_text',
    NULLIF(r->>'attainment', '')::numeric,
    'ai',
    'draft',
    p_created_by
  FROM jsonb_array_elements(p_rows) AS r
  WHERE NOT EXISTS (
    SELECT 1 FROM public.course_outcome_alignments existing
    WHERE existing.section_id = p_section_id
      AND existing.indicator_id = (r->>'indicator_id')::uuid
      AND existing.source = 'manual'
  );

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_ai_outcome_alignments(uuid, uuid, uuid, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.persist_ai_outcome_alignments(uuid, uuid, uuid, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_ai_outcome_alignments(uuid, uuid, uuid, jsonb) TO service_role;
