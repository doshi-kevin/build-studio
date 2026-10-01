-- Lock answer-key / rubric-source PDF reads to section owner or staff only.
--
-- Bug: AI-grading answer-key and rubric-source PDFs are uploaded (see
-- uploadRubricSourcePdf in
-- src/app/(dashboard)/professor/courses/[sectionId]/assignments/actions.ts) to
--   <sectionId>/assignment-rubric-sources/<assignmentId>/<file>
-- in the private course-materials bucket. Because segment [1] of that path is a
-- real section UUID, it falls straight into branch (a) of the bucket's SELECT
-- policy — public.is_section_member(<sectionId>) — which returns TRUE for
-- ENROLLED STUDENTS, not just the professor / staff. A student who guesses or
-- enumerates the path (or is handed a browser-minted signed URL) can read the
-- assignment's answer key. There is no carve-out for this prefix today.
--
-- The formula-sheets and warehouse prefixes are already special-cased in the
-- same policy (mig 48, hardened by the safe_cast_uuid fix, extended for
-- announcements in mig 20260713151153). This migration adds an equivalent
-- carve-out so that the answer-key prefix requires is_section_owner_or_staff
-- (professor + active TAs/graders only), never is_section_member.
--
-- Fix, in the SELECT policy:
--   • Branch (a) (module items + student-visible assignment-pdfs briefs) is
--     narrowed to EXCLUDE the assignment-rubric-sources prefix, so a real
--     section UUID in segment [1] no longer grants students read on answer keys.
--   • A new branch (e) grants read on
--       <sectionId>/assignment-rubric-sources/<assignmentId>/...
--     only when the caller is the section owner or active staff.
--
-- The DELETE policy already gates branch (a) by is_section_owner_or_staff, so
-- rubric-source deletes are already staff-only and need no change; it is left
-- untouched.
--
-- assignment-pdfs (student-facing assignment briefs, path
-- <sectionId>/assignment-pdfs/<assignmentId>/...) intentionally stays under
-- is_section_member — those are meant for students. Only the answer-key /
-- rubric-source prefix is locked down here.
--
-- Security note: rewrites ONE existing storage.objects policy (SELECT) on the
-- course-materials bucket. Tenant scoping is unchanged
-- (is_section_member / is_section_owner_or_staff via safe_cast_uuid); the change
-- can only REMOVE student read on the answer-key prefix and re-grant it to
-- owner/staff. No other prefix's access is weakened, no bucket is made public,
-- and RLS on storage.objects stays enabled. safe_cast_uuid(NULL/non-UUID)
-- returns NULL and both helpers return false for NULL, so unknown prefixes
-- still cleanly deny.

BEGIN;

DROP POLICY IF EXISTS "Course materials: read access" ON storage.objects;
CREATE POLICY "Course materials: read access"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'course-materials'
    AND (
      -- (a) section-scoped paths: first segment is sectionId
      --     (module items + student-visible assignment-pdfs briefs).
      --     Answer-key / rubric sources are carved out to branch (e) below so
      --     enrolled students never read them.
      (
        public.is_section_member(public.safe_cast_uuid((storage.foldername(name))[1]))
        AND (storage.foldername(name))[2] IS DISTINCT FROM 'assignment-rubric-sources'
      )
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
      OR
      -- (e) <sectionId>/assignment-rubric-sources/<assignmentId>/... —
      --     answer-key sources: only the section owner or active staff may read,
      --     never enrolled students.
      (
        (storage.foldername(name))[2] = 'assignment-rubric-sources'
        AND public.is_section_owner_or_staff(public.safe_cast_uuid((storage.foldername(name))[1]))
      )
    )
  );

COMMIT;
