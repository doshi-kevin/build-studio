-- Migration: persist_ai_outcome_alignments — atomic, manual-preserving write.
--
-- The outcome_alignment pipeline (Slice 2b) regenerates the AI-proposed
-- alignment rows for a section on every run, but must NEVER clobber a
-- professor's manual edits. This RPC does that atomically (one plpgsql txn):
-- delete this section's existing source='ai' rows, then insert the fresh AI
-- rows as drafts. source='manual' rows are left untouched. Service-role only
-- (the pipeline runs under the admin/service-role client).

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
  -- Replace only the AI-authored rows; manual overrides survive.
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
    NULLIF(r->>'evidence_source_id', '')::uuid,
    r->>'evidence_text',
    NULLIF(r->>'attainment', '')::numeric,
    'ai',
    'draft',
    p_created_by
  FROM jsonb_array_elements(p_rows) AS r
  -- Skip an indicator that already has a manual override (don't duplicate it).
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

COMMENT ON FUNCTION public.persist_ai_outcome_alignments IS
  'Atomically replace a section''s AI-authored outcome alignments (source=ai) with a fresh set, preserving any source=manual rows. Service-role only.';

REVOKE ALL ON FUNCTION public.persist_ai_outcome_alignments(uuid, uuid, uuid, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.persist_ai_outcome_alignments(uuid, uuid, uuid, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_ai_outcome_alignments(uuid, uuid, uuid, jsonb) TO service_role;
