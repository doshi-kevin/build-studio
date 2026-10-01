-- Migration: preclass-audio storage bucket
--
-- Backs the mp3 audio for Pre-Class Primers (see 20260702142225_preclass_primers.sql).
-- Every access is server-mediated:
--   * Write → the generation orchestrator (src/lib/preclass-audio/generate.ts),
--             invoked by the secret-gated /api/preclass-audio/generate route, uploads
--             the synthesized mp3 with the service-role admin client.
--   * Read  → the getPrimer server action mints a short-lived signed URL with the
--             admin client; the browser never touches the bucket directly.
--
-- So this bucket is intentionally DEFAULT-DENY: no storage.objects policies are
-- created, which means anon/authenticated roles can't read or write it at all.
-- Only the service_role (which bypasses RLS) can — matching the athena-attachments
-- bucket. The real authorization gate is the enrollment/feature check in getPrimer.
--
-- Path layout: `{institutionId}/{sectionId}/{moduleItemId}/{sourceHash}.mp3`
-- Tenant-hierarchical so storage mirrors ownership. The sourceHash segment means
-- a regenerate writes a NEW object rather than overwriting, so an in-flight
-- listener on the previous signed URL is never cut off.
--
-- Follow-up (tracked, not here): a storage sweep for mp3s orphaned when a
-- module_item is deleted (the primers row cascade-deletes; the object does not).
--
-- Created: 2026-07-02

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'preclass-audio',
  'preclass-audio',
  false,
  10485760, -- 10 MB (a 5-minute mp3 at 128 kbps is ~4.8 MB; ample headroom)
  ARRAY['audio/mpeg']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
