-- Dedicated PUBLIC bucket for professor-uploaded notebook/verbal cell images.
--
-- Why PUBLIC (deliberate, signed off in docs/designs/assignments-grading/assignment-studio-consolidated.md):
-- A cell image reference is persisted INSIDE the notebook/verbal markdown
-- (assignments.settings) and later rendered in three places, one of which is the
-- downloaded standalone HTML export (export-html.tsx) -- a file with no app session
-- that cannot re-sign a private URL or call an app route. A stored signed URL from
-- the private `course-materials` bucket would expire and 404; base64 inlining blows
-- the 5MB studioDocSchema cap. A stable public URL is the only reference that
-- resolves at all three render points. The tradeoff -- professor-authored assignment
-- images are readable by anyone with the URL -- is acceptable: this is assignment
-- content, not user PII. This is the first public bucket in the project; the choice
-- is intentional, not an oversight.
--
-- SVG is intentionally excluded from allowed_mime_types: an SVG opened directly on
-- the storage origin can execute embedded script. In-app it is only ever rendered
-- through StudioMarkdown as a plain <img> (no script), but a public direct URL is
-- not, so we keep raster formats only. Screenshots/graphs are png/jpeg/gif/webp.
--
-- Path layout: {sectionId}/cell-images/{assignmentId}/{file}
-- All app writes go through the admin client after a staff check in uploadCellImage
-- (service_role bypasses RLS); the INSERT/DELETE policies below are the last line of
-- defense against a direct, client-side storage call.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'assignment-cell-images',
  'assignment-cell-images',
  true,
  5242880, -- 5 MB
  ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Read: public. This is a public bucket by design (see header) -- images must resolve
-- in the offline HTML export with no session. Objects are served via the public
-- endpoint; this explicit policy documents that public read is deliberate.
CREATE POLICY "Assignment cell images: public read"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'assignment-cell-images');

-- Upload: only the section's professor/TA/grader may write under a section folder
-- (segment 1 = sectionId).
CREATE POLICY "Assignment cell images: section staff can upload"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'assignment-cell-images'
    AND public.is_section_owner_or_staff(((storage.foldername(name))[1])::uuid)
  );

-- Delete: section staff only (cleanup on replace).
CREATE POLICY "Assignment cell images: section staff can delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'assignment-cell-images'
    AND public.is_section_owner_or_staff(((storage.foldername(name))[1])::uuid)
  );
