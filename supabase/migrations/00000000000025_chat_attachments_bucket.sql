-- Migration: chat-attachments storage bucket + RLS
--
-- Creates the private `chat-attachments` bucket that backs team chat
-- uploads (PDFs + images only, 25 MB cap). Delivery is via short-lived
-- signed URLs minted server-side — never public — so the bucket stays
-- private and hotlinks expire.
--
-- Path layout: `{teamId}/{channelId}/{yyyy}/{mm}/{uuid}.{ext}`
-- RLS on storage.objects uses the existing `public.is_team_member()`
-- SECURITY DEFINER helper (added in migration 011) to avoid the
-- cross-schema join cost on every read/write.
--
-- Follow-ups (tracked, not in this migration):
--   1. Background cleanup worker for orphaned attachments when a
--      message/team/channel is deleted (chat deletes cascade at the
--      table level, but files in Storage are not touched).
--   2. Server-side magic-byte sniffing on upload for real MIME
--      enforcement — bucket-level allowed_mime_types only checks
--      headers and is easy to spoof.
--
-- Created: 2026-04-15

-- ── 1. Bucket ────────────────────────────────────────────────────
INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'chat-attachments',
  'chat-attachments',
  false,
  26214400, -- 25 MB
  ARRAY[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── 2. RLS policies on storage.objects ───────────────────────────
--
-- The first path segment is the team UUID. We membership-check it via
-- is_team_member(), which bypasses project_members RLS and is STABLE
-- so Postgres caches the result within a statement.

DROP POLICY IF EXISTS "Team members can read chat attachments" ON storage.objects;
CREATE POLICY "Team members can read chat attachments"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'chat-attachments'
    AND public.is_team_member(
      (storage.foldername(name))[1]::uuid,
      auth.uid()
    )
  );

DROP POLICY IF EXISTS "Team members can upload chat attachments" ON storage.objects;
CREATE POLICY "Team members can upload chat attachments"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'chat-attachments'
    AND owner = auth.uid()
    AND public.is_team_member(
      (storage.foldername(name))[1]::uuid,
      auth.uid()
    )
  );

-- Authors can delete their own uploads (for message-delete UX). The
-- ownership check is on storage.objects.owner, which is auto-populated
-- to auth.uid() at upload time.
DROP POLICY IF EXISTS "Authors can delete their chat attachments" ON storage.objects;
CREATE POLICY "Authors can delete their chat attachments"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'chat-attachments'
    AND owner = auth.uid()
  );
