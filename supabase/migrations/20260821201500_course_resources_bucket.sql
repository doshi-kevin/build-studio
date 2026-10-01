-- Provision the course-resources bucket (#704).
--
-- The Course Intel → Resources tab has been dead on arrival for every user: the upload
-- code writes to a `course-resources` bucket that was never created, so every attempt
-- returned 400 NoSuchBucket. Confirmed against the project's storage API — the bucket is
-- absent from the full list, while `src/lib/supabase/storage.ts` has carried a
-- COURSE_RESOURCES_BUCKET constant and a comment calling the bucket "currently unused in
-- production" since the feature shipped. The feature shipped without its storage.
--
-- Created here rather than by hand in one project so it exists in every environment.
--
-- PRIVATE, matching every other user-content bucket here (assignment-submissions,
-- chat-attachments, project-chat). Reads go through signed URLs minted server-side, so
-- there is no public object URL to leak or guess.
--
-- ── Membership: reuse is_course_member(), do not re-inline it ────────────────────
-- The first draft of this migration inlined three EXISTS subqueries over
-- course_sections / enrollments / section_staff. Security review flagged two problems
-- with that, both real:
--
--   1. Those subqueries run as `authenticated`, so they are themselves RLS-filtered —
--      the policy only worked because two independent layers happened to agree.
--   2. `public.is_course_member(uuid)` already exists (SECURITY DEFINER, STABLE) and is
--      already the predicate on the course_resources TABLE. Re-implementing it here means
--      the table and its bucket can silently drift apart.
--
-- Verified against production that the helper is a branch-for-branch match for what the
-- inlined version said: professor of any section of the course, active section_staff with
-- ends_at > now(), or an enrolled/completed student.
--
-- ── The uuid cast needs its own guard ───────────────────────────────────────────
-- `((storage.foldername(name))[1])::uuid` raises 22P02 on a non-uuid first segment. That
-- is fail-CLOSED (the statement aborts, nothing uploads) and it is not a usable DoS — it
-- holds no locks and affects only the caller's own request. But every permissive policy on
-- storage.objects is OR'd together, and Postgres does not GUARANTEE that the cheap
-- `bucket_id = …` comparison is evaluated first. Today it is, by cost, which is why this
-- has not broken chat-attachments uploads. Relying on planner cost ordering for
-- correctness is not acceptable, so the regex guard from the chat-attachments policy is
-- carried over here rather than dropped.
--
-- Path shape is `{courseId}/{baseName}_{timestamp}.{ext}` — see buildStoragePath — so
-- foldername[1] is the course id.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'course-resources',
  'course-resources',
  false,
  26214400,  -- 25 MB, matching assignment-submissions and MAX_RESOURCE_SIZE
  ARRAY[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
    'text/markdown',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/zip'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── Who may write ───────────────────────────────────────────────────────────────
-- The upload runs from the BROWSER (uploadResourceFile uses the anon client), so there is
-- no server action in front of it and RLS is the ONLY control on this write.
--
-- `owner = auth.uid()` is set by storage-api from the JWT `sub` and cannot be forged by
-- the client; it stops uploading under someone else's name, and if a future storage-api
-- ever stopped populating it, this fails closed.

DROP POLICY IF EXISTS "Course resources: upload" ON storage.objects;
CREATE POLICY "Course resources: upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'course-resources'
    AND owner = auth.uid()
    -- Guard before the cast: a non-uuid first segment would abort the statement.
    AND (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
    AND public.is_course_member(((storage.foldername(name))[1])::uuid)
  );

-- ── Who may read ────────────────────────────────────────────────────────────────
-- Reads normally arrive as server-minted signed URLs, which bypass RLS by design, so this
-- governs any direct client read and is the backstop if a future surface reads the bucket
-- with the anon key.

DROP POLICY IF EXISTS "Course resources: read" ON storage.objects;
CREATE POLICY "Course resources: read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'course-resources'
    AND (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
    AND public.is_course_member(((storage.foldername(name))[1])::uuid)
  );

-- ── Who may delete ──────────────────────────────────────────────────────────────
-- Author only, at the storage layer. deleteResourceFile runs from the browser too.
--
-- Deliberately narrow, and NOT the whole story: a professor cannot remove a student's
-- inappropriate upload from their own course through storage. That takedown path lives in
-- the deleteResource server action instead (same change), which soft-hides the metadata
-- row so the resource stops rendering for everyone. Keeping object deletion author-only
-- means a professor's takedown is reversible and auditable rather than destructive.

DROP POLICY IF EXISTS "Course resources: delete own" ON storage.objects;
CREATE POLICY "Course resources: delete own"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'course-resources' AND owner = auth.uid());

COMMIT;
