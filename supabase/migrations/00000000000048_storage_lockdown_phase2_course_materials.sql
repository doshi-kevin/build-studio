-- Storage lockdown — Phase 2: course-materials bucket.
--
-- This is the largest blast-radius bucket. It holds:
--   • module item attachments at `{sectionId}/{moduleId}/{itemId}/...`
--   • formula sheets at `formula-sheets/{sectionId}/{quizId}/...`
--   • professor warehouse files at `warehouse/{professorId}/...`
--
-- Pre-Phase-2 state: public bucket, files served via /object/public/...
-- with no auth check. Cross-tenant material leak via path enumeration.
--
-- Post-Phase-2:
--   • Bucket flipped public=false
--   • Storage RLS gates SELECT by section membership / warehouse ownership
--   • App reads mint short-lived signed URLs at render time using the stored path
--   • Backfill populates `formula_sheet_path` from legacy `formula_sheet_url`
--     where missing, and parses `module_items.content.fileUrl` into
--     `module_items.content.filePath` for the same rows.

BEGIN;

-- ── 1. Backfill paths from existing public URLs ─────────────────────
-- The public URL pattern is:
--   https://<project>.supabase.co/storage/v1/object/public/course-materials/<path>
-- We extract everything after `/course-materials/` to recover the storage path.

-- 1a. Quiz formula sheets — populate formula_sheet_path where missing.
UPDATE public.quizzes
SET formula_sheet_path = regexp_replace(
  formula_sheet_url,
  '^.*/object/public/course-materials/',
  ''
)
WHERE formula_sheet_url IS NOT NULL
  AND formula_sheet_path IS NULL
  AND formula_sheet_url ~ '/object/public/course-materials/';

-- 1b. Module items — populate content.filePath from content.fileUrl where missing.
-- module_items.content is JSONB. Keep all other keys; only add filePath.
UPDATE public.module_items
SET content = jsonb_set(
  content,
  '{filePath}',
  to_jsonb(regexp_replace(
    content ->> 'fileUrl',
    '^.*/object/public/course-materials/',
    ''
  ))
)
WHERE content ? 'fileUrl'
  AND (NOT (content ? 'filePath') OR (content ->> 'filePath') IS NULL OR (content ->> 'filePath') = '')
  AND (content ->> 'fileUrl') ~ '/object/public/course-materials/';

-- ── 2. Helper: is_section_member ────────────────────────────────────
-- True if auth.uid() is the section's professor, an active TA/grader,
-- or an enrolled student. SECURITY DEFINER so it can read across RLS.
-- Used by the storage RLS policy below.

CREATE OR REPLACE FUNCTION public.is_section_member(p_section_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.course_sections cs
     WHERE cs.id = p_section_id
       AND cs.professor_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM public.section_staff ss
     WHERE ss.section_id = p_section_id
       AND ss.staff_id   = auth.uid()
       AND ss.status     = 'active'
       AND ss.ends_at    > now()
  )
  OR EXISTS (
    SELECT 1 FROM public.enrollments e
     WHERE e.section_id = p_section_id
       AND e.student_id = auth.uid()
       AND e.status IN ('enrolled', 'completed')
  );
$$;

REVOKE ALL ON FUNCTION public.is_section_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_section_member(uuid) TO authenticated;

-- ── 3. Flip bucket to private ──────────────────────────────────────
UPDATE storage.buckets
  SET public = false
  WHERE id = 'course-materials';

-- ── 4. RLS policies on storage.objects for course-materials ────────
-- Three path schemas. The CTE-style helper inline expands each one.

DROP POLICY IF EXISTS "Course materials: read access" ON storage.objects;
CREATE POLICY "Course materials: read access"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'course-materials'
    AND (
      -- (a) module item paths: first segment is sectionId
      public.is_section_member(((storage.foldername(name))[1])::uuid)
      OR
      -- (b) formula-sheets/<sectionId>/<quizId>/...
      (
        (storage.foldername(name))[1] = 'formula-sheets'
        AND public.is_section_member(((storage.foldername(name))[2])::uuid)
      )
      OR
      -- (c) warehouse/<professorId>/... — only the owning professor reads
      (
        (storage.foldername(name))[1] = 'warehouse'
        AND ((storage.foldername(name))[2])::uuid = auth.uid()
      )
    )
  );

-- INSERT: allow authenticated users to upload. The actual upload paths use
-- the admin client (service role bypasses RLS), so this is just a
-- belt-and-suspenders rule for SDK uploads from the browser session.
DROP POLICY IF EXISTS "Course materials: authenticated can upload" ON storage.objects;
CREATE POLICY "Course materials: authenticated can upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'course-materials'
    AND auth.uid() IS NOT NULL
  );

-- DELETE: same predicate as SELECT, so a professor can clean up their own
-- section's files and a student can't delete anything.
DROP POLICY IF EXISTS "Course materials: section staff / owners can delete" ON storage.objects;
CREATE POLICY "Course materials: section staff / owners can delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'course-materials'
    AND (
      -- module item paths — only professor or staff (not students)
      public.is_section_owner_or_staff(((storage.foldername(name))[1])::uuid)
      OR
      (
        (storage.foldername(name))[1] = 'formula-sheets'
        AND public.is_section_owner_or_staff(((storage.foldername(name))[2])::uuid)
      )
      OR
      (
        (storage.foldername(name))[1] = 'warehouse'
        AND ((storage.foldername(name))[2])::uuid = auth.uid()
      )
    )
  );

COMMIT;
