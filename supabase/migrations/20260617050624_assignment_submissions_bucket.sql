-- Dedicated PRIVATE bucket for student submission files.
--
-- Why not reuse `course-materials`: its SELECT policy grants read to ANY enrolled
-- section member on `{sectionId}/…` (see migration 48). Submission files placed
-- there would let a student mint a signed URL to a classmate's submission — a
-- cross-student IDOR. Here, only the student owner (path segment 3) or the
-- section's staff can read. All app access is server-side via the admin client
-- (service_role bypasses RLS); these policies are the last-line-of-defense for
-- any direct, client-side storage call.
--
-- Path layout: {sectionId}/{assignmentId}/{studentId}/{file}

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('assignment-submissions', 'assignment-submissions', false, 26214400) -- 25 MB
ON CONFLICT (id) DO NOTHING;

-- Read: the student who owns the file, or the section's professor/TA/grader.
CREATE POLICY "Assignment submissions: read (owner or section staff)"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'assignment-submissions'
    AND (
      (storage.foldername(name))[3]::uuid = auth.uid()
      OR public.is_section_owner_or_staff(((storage.foldername(name))[1])::uuid)
    )
  );

-- Upload: only the owning student writes their own folder (segment 3 = uid).
CREATE POLICY "Assignment submissions: owner can upload"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'assignment-submissions'
    AND (storage.foldername(name))[3]::uuid = auth.uid()
  );

-- Delete: the owning student or section staff (e.g. cleanup on resubmit).
CREATE POLICY "Assignment submissions: owner or staff can delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'assignment-submissions'
    AND (
      (storage.foldername(name))[3]::uuid = auth.uid()
      OR public.is_section_owner_or_staff(((storage.foldername(name))[1])::uuid)
    )
  );
