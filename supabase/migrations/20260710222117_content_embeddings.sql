-- Persistent embeddings layer for course content (the data-intelligence layer).
--
-- Replaces the throwaway JS-cosine skill↔page matching: the extraction worker now
-- persists page + skill vectors here (one row per embeddable chunk), and skill→page
-- matching for the material-viewer reference rail becomes a pgvector query
-- (match_skill_pages below). Extensible to quizzes/transcripts later via source_type.
--
-- All reads/writes go through server actions and the extraction worker (admin
-- client). Client-facing RLS is deliberately SELECT-only (a FOR ALL policy would
-- open a PostgREST write hole) and scoped to professors of the owning institution —
-- rows hold course-content text, so students get nothing directly.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE content_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  -- What this chunk is. No FK on source_id on purpose — it's polymorphic
  -- (module item today; quiz/transcript ids later). Orphans are purged by the
  -- extraction worker's cleanup-storage job when a module item is deleted.
  source_type TEXT NOT NULL CHECK (source_type IN ('pdf_page', 'skill')),
  source_id UUID NOT NULL,
  -- Set for pdf_page rows; NULL for skills. A page that exceeds the embedding
  -- model's input limit becomes multiple rows (metadata.chunkIndex).
  page_number INTEGER,
  -- 1536 dims (Matryoshka truncation of gemini-embedding-001's 3072): pgvector
  -- can't index above 2000 dims, and cosine is scale-invariant so the
  -- un-normalized truncated vectors work with <=> as-is.
  embedding extensions.vector(1536) NOT NULL,
  text TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_embeddings_source ON content_embeddings(source_type, source_id);
CREATE INDEX idx_content_embeddings_institution ON content_embeddings(institution_id);
-- ANN index for cross-material semantic search / RAG. The per-item reference-rail
-- match below scans one document's rows exactly; this index serves institution- or
-- section-wide "find content like X" queries.
CREATE INDEX idx_content_embeddings_hnsw ON content_embeddings
  USING hnsw (embedding extensions.vector_cosine_ops);

ALTER TABLE content_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Institution professors read content embeddings"
  ON content_embeddings FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.institution_id = content_embeddings.institution_id
        AND p.role = 'professor'
    )
  );

-- No INSERT/UPDATE/DELETE policies on purpose: writes are worker/server-action-only
-- (admin client).

-- Skill→page matching, pushed down to Postgres. For each stored skill vector of the
-- given module items, returns the pages of the SAME item whose content is closest by
-- cosine similarity (1 - <=>), deduped across a page's chunks (max wins), filtered by
-- p_threshold, capped at p_top_n pages per skill, ranked best-first. Re-running with a
-- different threshold re-matches without re-embedding anything.
CREATE OR REPLACE FUNCTION public.match_skill_pages(
  p_module_item_ids UUID[],
  p_threshold DOUBLE PRECISION,
  p_top_n INTEGER
)
RETURNS TABLE (
  module_item_id UUID,
  skill TEXT,
  page_number INTEGER,
  similarity DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
  SELECT s.source_id AS module_item_id,
         s.text AS skill,
         ranked.page_number,
         ranked.similarity
  FROM content_embeddings s
  CROSS JOIN LATERAL (
    SELECT p.page_number,
           MAX(1 - (p.embedding <=> s.embedding)) AS similarity
    FROM content_embeddings p
    WHERE p.source_type = 'pdf_page'
      AND p.source_id = s.source_id
      AND p.page_number IS NOT NULL
    GROUP BY p.page_number
    HAVING MAX(1 - (p.embedding <=> s.embedding)) >= p_threshold
    ORDER BY similarity DESC
    LIMIT p_top_n
  ) ranked
  WHERE s.source_type = 'skill'
    AND s.source_id = ANY(p_module_item_ids)
  ORDER BY s.source_id, s.text, ranked.similarity DESC
$$;

-- Service-role only (H2 pattern, migration 20260626184930): callable by the server
-- actions / worker, never via client PostgREST RPC.
REVOKE EXECUTE ON FUNCTION public.match_skill_pages(UUID[], DOUBLE PRECISION, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_skill_pages(UUID[], DOUBLE PRECISION, INTEGER)
  TO service_role;
