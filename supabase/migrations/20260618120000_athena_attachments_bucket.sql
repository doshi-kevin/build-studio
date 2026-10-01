-- Migration: athena-attachments storage bucket
--
-- Backs file uploads to the Athena professor assistant. Unlike chat-attachments
-- (which the browser writes to directly, so it needs per-team RLS policies),
-- EVERY Athena attachment access is server-mediated:
--   * Upload  → /api/professor-assistant/upload (auth: section staff) using the
--               service-role admin client, which also runs Office→PDF conversion.
--   * Read    → server actions / the chat route mint short-lived signed URLs with
--               the admin client; the browser never touches the bucket directly.
--
-- So this bucket is intentionally DEFAULT-DENY: no storage.objects policies are
-- created, which means anon/authenticated roles can't read or write it at all.
-- Only the service_role (which bypasses RLS) can — exactly the access path above.
-- This is the locked-down end state the storage-lockdown migrations aim for; the
-- real authorization gate is verifySectionAccess + canWriteAsStaff in the route.
--
-- Path layout: `{institutionId}/{sectionId}/{conversationId}/{uuid}.{ext}`
-- Stored bytes are always Gemini-readable (PDF / image / text); Office docs are
-- converted to PDF before upload, so allowed_mime_types omits Office types.
--
-- Follow-ups (tracked, not here): TTL/cleanup sweep for orphaned attachments;
-- server-side magic-byte sniffing (bucket allowed_mime_types is header-only).
--
-- Created: 2026-06-18

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'athena-attachments',
  'athena-attachments',
  false,
  26214400, -- 25 MB (matches the per-file ceiling enforced server-side)
  ARRAY[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'text/plain',
    'text/markdown',
    'text/csv'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
