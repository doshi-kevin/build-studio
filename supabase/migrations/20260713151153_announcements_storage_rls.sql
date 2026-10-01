-- Fix: announcement file attachments can't be uploaded — course-materials
-- storage RLS has no branch for the `announcements/<sectionId>/...` path.
--
-- Bug: announcement attachments upload to `announcements/<sectionId>/<file>` in
-- the private course-materials bucket. The bucket's SELECT policy (mig 48, later
-- hardened by the safe_cast_uuid fix) only allows three path shapes:
--   (a) <sectionId>/...                      (module items)
--   (b) formula-sheets/<sectionId>/...
--   (c) warehouse/<professorId>/...
-- The `announcements/` prefix matches none — branch (a) safe-casts the literal
-- 'announcements' to NULL → is_section_member(NULL) = false. So the browser
-- client's createSignedUrl() right after upload (used for the preview URL)
-- returns 400 "Object not found", the FileUpload widget reports "Upload
-- succeeded but preview URL failed", and the attachment is never saved. Exactly
-- the formula-sheet / question-bank breakage the safe_cast_uuid migration fixed,
-- but for the announcements path.
--
-- Fix: add an `announcements/<sectionId>/...` branch to the SELECT and DELETE
-- policies, mirroring the existing formula-sheets branch. SELECT is gated by
-- is_section_member (enrolled students, staff and the professor may read — same
-- audience the announcement itself targets), DELETE by is_section_owner_or_staff
-- (only the professor / active TAs can remove attachments, never students).
--
-- Reads elsewhere in the app already work because server components re-sign from
-- `filePath` with the admin client (bypasses RLS); this policy only unblocks the
-- browser-side upload-preview sign and same-section signing.
--
-- Security note: rewrites two EXISTING storage.objects policies on the
-- course-materials bucket only. Tenant scoping is unchanged
-- (is_section_member / is_section_owner_or_staff); the new branch can only make a
-- previously-denied `announcements/<sectionId>/` path evaluate to true for a
-- member of that same section. No table/RLS is removed, no bucket made public.

BEGIN;

-- ── SELECT: add announcements/<sectionId>/... branch ───────────────
DROP POLICY IF EXISTS "Course materials: read access" ON storage.objects;
CREATE POLICY "Course materials: read access"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'course-materials'
    AND (
      -- (a) module item paths: first segment is sectionId
      public.is_section_member(public.safe_cast_uuid((storage.foldername(name))[1]))
      OR
      -- (b) formula-sheets/<sectionId>/<quizId>/...
      (
        (storage.foldername(name))[1] = 'formula-sheets'
        AND public.is_section_member(public.safe_cast_uuid((storage.foldername(name))[2]))
      )
      OR
      -- (c) warehouse/<professorId>/... — only the owning professor reads
      (
        (storage.foldername(name))[1] = 'warehouse'
        AND public.safe_cast_uuid((storage.foldername(name))[2]) = auth.uid()
      )
      OR
      -- (d) announcements/<sectionId>/... — any member of the section
      (
        (storage.foldername(name))[1] = 'announcements'
        AND public.is_section_member(public.safe_cast_uuid((storage.foldername(name))[2]))
      )
    )
  );

-- ── DELETE: add announcements/<sectionId>/... branch ───────────────
DROP POLICY IF EXISTS "Course materials: section staff / owners can delete" ON storage.objects;
CREATE POLICY "Course materials: section staff / owners can delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'course-materials'
    AND (
      -- module item paths — only professor or staff (not students)
      public.is_section_owner_or_staff(public.safe_cast_uuid((storage.foldername(name))[1]))
      OR
      (
        (storage.foldername(name))[1] = 'formula-sheets'
        AND public.is_section_owner_or_staff(public.safe_cast_uuid((storage.foldername(name))[2]))
      )
      OR
      (
        (storage.foldername(name))[1] = 'warehouse'
        AND public.safe_cast_uuid((storage.foldername(name))[2]) = auth.uid()
      )
      OR
      (
        (storage.foldername(name))[1] = 'announcements'
        AND public.is_section_owner_or_staff(public.safe_cast_uuid((storage.foldername(name))[2]))
      )
    )
  );

COMMIT;
