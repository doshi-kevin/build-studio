-- Fix: course-materials storage RLS policies throw 22P02 on non-UUID folder prefixes.
--
-- Bug: migration 00000000000048 defined the course-materials SELECT/DELETE
-- policies casting (storage.foldername(name))[n]::uuid UNCONDITIONALLY in every
-- branch. For paths whose relevant segment is a non-UUID literal — e.g.
-- 'formula-sheets/<section>/<quiz>/...', 'quiz-images/<section>/...', or a
-- malformed 'warehouse/...' — that cast raises 22P02 (invalid input syntax for
-- type uuid), which aborts the WHOLE policy evaluation. The browser client's
-- createSignedUrl() (used right after upload for a preview URL) then returns 400,
-- so the app never saves the URL. This broke formula-sheet upload and
-- question-bank image upload end-to-end; paths that happen to start with the
-- section UUID worked only by luck.
--
-- Fix: a pure-SQL, IMMUTABLE STRICT safe_cast_uuid() that returns NULL for
-- non-UUID input instead of throwing, and rewrite both policies to wrap EVERY
-- folder-segment cast in it. Behaviour is unchanged for valid UUIDs:
-- is_section_member(NULL) and (NULL = auth.uid()) both evaluate to false, so a
-- non-UUID / unknown prefix cleanly DENIES (no broadening of access) instead of
-- erroring. A plain SQL function (not plpgsql with EXCEPTION) is used so the
-- planner can inline it and avoid a per-row subtransaction/savepoint.
--
-- Security note: this only rewrites two EXISTING storage.objects policies on the
-- course-materials bucket. Tenant scoping is unchanged (is_section_member /
-- is_section_owner_or_staff); the guard can only make a previously-throwing row
-- evaluate to false (deny), never to true (allow). No table/RLS is removed.

BEGIN;

-- ── 1. Safe UUID cast helper ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.safe_cast_uuid(p_val text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_val ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN p_val::uuid
    ELSE NULL
  END;
$$;

-- Pure, data-free string parser. Granted to anon too: storage.objects RLS is
-- shared across all buckets, so an anon read of any public bucket may evaluate
-- this policy — anon must be able to execute the function or the read errors.
GRANT EXECUTE ON FUNCTION public.safe_cast_uuid(text) TO authenticated, anon;

-- ── 2. Rewrite SELECT policy with guarded casts ────────────────────
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
    )
  );

-- ── 3. Rewrite DELETE policy with guarded casts ────────────────────
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
    )
  );

COMMIT;
