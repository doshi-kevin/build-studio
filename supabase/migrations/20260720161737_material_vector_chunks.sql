-- Migration: material_vector_chunks — Postgres source of truth for the
-- module-PDF embedding pipeline (design: docs/designs/modules/module-embedding-pinecone-system-design.md).
--
-- One row per embedded PDF page. Pinecone holds the vector (a disposable,
-- rebuildable projection); THIS table holds the page text, breadcrumb, sync
-- state, and provenance — if Pinecone vanished tonight, these rows + the PDFs
-- in course-materials rebuild it. The Pinecone vector id is DERIVED
-- ({module_item_id}#p{page}), never stored (a stored copy drifts after
-- re-ingestion).
--
-- RLS: SELECT-only for section owner/staff (mirrors background_jobs). All
-- writes come from the service-role embedding worker — no client write path,
-- hence no INSERT/UPDATE/DELETE policy (see .claude/rules/security-migrations.md
-- on FOR ALL being a write hole).

CREATE TABLE IF NOT EXISTS public.material_vector_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  module_id uuid NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  module_item_id uuid NOT NULL REFERENCES public.module_items(id) ON DELETE CASCADE,
  page_number int NOT NULL CHECK (page_number >= 1),
  -- What was embedded alongside the page image (course › module › item › heading).
  breadcrumb text NOT NULL DEFAULT '',
  -- Extracted page text — hydrated at retrieval time so Pinecone never carries
  -- content (RLS here is the last line of defense). May be empty for scanned pages.
  content text NOT NULL DEFAULT '',
  -- sha256 over (page text + rendered-image bytes + model + chunker version);
  -- unchanged hash ⇒ the worker skips re-embedding on re-upload.
  content_hash text NOT NULL,
  embedding_model text NOT NULL,
  embedding_dim int NOT NULL,
  chunker_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'indexed', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotent per-page upserts + the natural key for hydration.
  CONSTRAINT uq_material_vector_chunks_page UNIQUE (module_item_id, page_number)
);

COMMENT ON TABLE public.material_vector_chunks IS
  'Source-of-truth rows for module-PDF page embeddings. One row per page; the Pinecone vector id is derived as {module_item_id}#p{zero-padded page_number}. Written only by the service-role embedding worker.';

-- FK/filter columns are not auto-indexed (uq covers module_item_id lookups).
CREATE INDEX IF NOT EXISTS idx_material_vector_chunks_section
  ON public.material_vector_chunks (section_id);
CREATE INDEX IF NOT EXISTS idx_material_vector_chunks_institution
  ON public.material_vector_chunks (institution_id);
CREATE INDEX IF NOT EXISTS idx_material_vector_chunks_module
  ON public.material_vector_chunks (module_id);

ALTER TABLE public.material_vector_chunks ENABLE ROW LEVEL SECURITY;

-- Read: section owner or active staff (same audited helper background_jobs uses).
-- Student read access arrives with the first student-facing consumer, in its own
-- reviewed migration — hydration today is server-side via the admin client.
CREATE POLICY "Section owner/staff can read material vector chunks"
  ON public.material_vector_chunks FOR SELECT
  TO authenticated
  USING (public.is_section_owner_or_staff(section_id));
