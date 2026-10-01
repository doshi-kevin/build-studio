-- Storage lockdown — Phase 1: proctoring-snapshots only.
--
-- Phase 1 of the storage tenant-isolation work (the follow-up doc this
-- originally cited was never committed). We start with
-- proctoring-snapshots because it's:
--   1. The most sensitive data (student PII via webcam captures)
--   2. The smallest bucket (~16 files, ~100KB)
--   3. Already wired up with createSignedUrl on the upload path
--      (saveProctoringSnapshot uses a 7-day signed URL), so flipping
--      the bucket to private doesn't immediately break read paths
--      that were minted within the past week.
--
-- Other public buckets (course-materials, live-classroom-decks,
-- project-chat) require migrating dozens of read sites and are
-- tracked as remaining work in the followup doc — not in this migration.
--
-- After this migration:
--   • Bucket flipped to public=false; the existing /object/public/...
--     URLs in the snapshot_url column STOP RESOLVING. New uploads
--     mint fresh 7-day signed URLs, so the next exam works.
--   • RLS on storage.objects gates SELECT to section professor + active
--     TAs; gates INSERT to authenticated callers (the saveProctoringSnapshot
--     server action uses the admin client, which bypasses RLS anyway).

BEGIN;

-- ── 1. Flip bucket to private ──────────────────────────────────────
-- Allowed mime types are unchanged (images only). file_size_limit is
-- unset on this bucket; left alone.
UPDATE storage.buckets
  SET public = false
  WHERE id = 'proctoring-snapshots';

-- ── 2. Helper: section_owner_or_active_staff ──────────────────────
-- True if auth.uid() is the section's professor OR an active TA/grader
-- on that section. SECURITY DEFINER so it can read course_sections /
-- section_staff regardless of caller's RLS.
--
-- Reused below by the RLS policy. Could be reused by future bucket
-- policies (live-classroom-decks etc.) once those are locked down.

CREATE OR REPLACE FUNCTION public.is_section_owner_or_staff(p_section_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.course_sections cs
     WHERE cs.id = p_section_id
       AND cs.professor_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1
      FROM public.section_staff ss
     WHERE ss.section_id = p_section_id
       AND ss.staff_id   = auth.uid()
       AND ss.status     = 'active'
       AND ss.ends_at    > now()
  );
$$;

REVOKE ALL ON FUNCTION public.is_section_owner_or_staff(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_section_owner_or_staff(uuid) TO authenticated;

-- ── 3. RLS policies on storage.objects for proctoring-snapshots ───
-- Path layout: `{sectionId}/{quizId}/{attemptId}/{timestampOffset}.jpg`
-- The first folder segment is the sectionId — RLS extracts it via
-- `storage.foldername(name)[1]` and runs is_section_owner_or_staff().

DROP POLICY IF EXISTS "Proctoring snapshots: section staff can read"
  ON storage.objects;
CREATE POLICY "Proctoring snapshots: section staff can read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'proctoring-snapshots'
    AND public.is_section_owner_or_staff(
      ((storage.foldername(name))[1])::uuid
    )
  );

-- Students upload via the admin client (saveProctoringSnapshot
-- server action), which bypasses RLS. We still add a fallback
-- INSERT policy gated to authenticated users so SDK-side uploads
-- aren't completely blocked, but primary write is via service role.
DROP POLICY IF EXISTS "Proctoring snapshots: authenticated can upload"
  ON storage.objects;
CREATE POLICY "Proctoring snapshots: authenticated can upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'proctoring-snapshots'
    AND auth.uid() IS NOT NULL
  );

-- Section professor / staff can delete (e.g., for cleanup workflows).
DROP POLICY IF EXISTS "Proctoring snapshots: section staff can delete"
  ON storage.objects;
CREATE POLICY "Proctoring snapshots: section staff can delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'proctoring-snapshots'
    AND public.is_section_owner_or_staff(
      ((storage.foldername(name))[1])::uuid
    )
  );

COMMIT;
