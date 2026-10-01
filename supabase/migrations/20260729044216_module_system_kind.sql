-- Give the app's two container modules a stable identity that isn't their title.
--
-- "Quiz Uploads" (mig 20260612141203) and "Classroom Uploads" (mig 20260720174305)
-- are system-owned buckets: uploads land in them, the roadmap routes their files
-- to the off-map bench instead of the canvas, and each is find-or-created once per
-- section. All of that keyed on the literal TITLE STRING, in three places at once
-- — the find-or-create lookup, the partial unique index, and the roadmap adapter.
--
-- So a professor who creates or renames a module to exactly "Classroom Uploads"
-- adopts the container: their module wins the find-or-create, live-classroom decks
-- start landing in it, and its contents vanish from the canvas into the bench.
-- Nothing crashes (the caller handles the 23505 by re-selecting by title), but the
-- identity of a system bucket should not be a string a user can type.
--
-- `system_kind` is NULL for every ordinary module — only the app ever sets it, via
-- the admin client. Titles stay as they are: they are still what the professor
-- reads on the Modules page, they are just no longer load-bearing.
--
-- No RLS change: `modules` already has RLS, and this adds a column + indexes only.

ALTER TABLE public.modules
  ADD COLUMN IF NOT EXISTS system_kind text;

/* The CHECK goes in its own guarded statement, NOT inline on the ADD COLUMN:
   `ADD COLUMN IF NOT EXISTS` skips the whole statement when the column already
   exists (a re-run, or a partially-applied migration), which would silently leave
   this column — the identity of a system-owned container — unconstrained text. */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'modules_system_kind_check'
  ) THEN
    ALTER TABLE public.modules
      ADD CONSTRAINT modules_system_kind_check
      CHECK (system_kind IS NULL OR system_kind IN ('quiz_uploads', 'classroom_uploads'));
  END IF;
END $$;

COMMENT ON COLUMN public.modules.system_kind IS
  'Marks an app-owned container module (quiz_uploads / classroom_uploads) whose '
  'files live in the roadmap''s off-map bench rather than on the canvas. NULL for '
  'a professor''s own module. Set only by the server; never keyed on the title, '
  'which a professor can rename.';

-- Backfill from the titles that were the identity until now.
--
-- Matched EXACTLY (case-sensitive, untrimmed), because that is precisely what the
-- indexes being replaced enforced: `WHERE title = 'Quiz Uploads'`. A module a
-- professor named `quiz uploads` never collided with the container and was never
-- treated as one, so a looser `lower(btrim(...))` match here could hand it the
-- marker instead — and with `ORDER BY created_at` it would win whenever it is the
-- older row. That would silently redirect every future upload into a professor's
-- own module. Only rows the old index governed are containers.
--
-- Oldest row per section still wins, matching the de-duplication both original
-- migrations performed before creating their indexes (so in practice there is
-- exactly one of each per section already).
WITH ranked AS (
  SELECT id,
         CASE title
           WHEN 'Quiz Uploads' THEN 'quiz_uploads'
           WHEN 'Classroom Uploads' THEN 'classroom_uploads'
         END AS kind,
         row_number() OVER (PARTITION BY section_id, title ORDER BY created_at, id) AS rn
  FROM public.modules
  WHERE title IN ('Quiz Uploads', 'Classroom Uploads')
)
UPDATE public.modules m
SET system_kind = r.kind
FROM ranked r
WHERE m.id = r.id AND r.rn = 1 AND r.kind IS NOT NULL;

-- Re-key the single-instance guarantee onto the marker. Dropping the title-based
-- indexes is the point: with them in place, a professor naming a module
-- "Quiz Uploads" would collide with the container instead of just being ignored.
DROP INDEX IF EXISTS modules_one_quiz_uploads_per_section;
DROP INDEX IF EXISTS modules_one_classroom_uploads_per_section;

CREATE UNIQUE INDEX IF NOT EXISTS modules_one_system_kind_per_section
  ON public.modules (section_id, system_kind)
  WHERE system_kind IS NOT NULL;
