-- CRITICAL: drop legacy permissive policies on storage.objects.
--
-- Postgres OR's RLS policies within a command, so the tenant-scoped
-- policies added in mig 47 (proctoring), 48 (course-materials), and
-- 49 (live-classroom-decks) were unioned with these older permissive
-- policies — making the lockdowns no-ops in production.
--
-- Specifically:
--   • "Allow public reads" — SELECT on course-materials with NO path
--     predicate. Any authenticated user could read every byte.
--   • "Allow authenticated uploads" — INSERT to course-materials with
--     no path check. Any user could write anywhere.
--   • "Allow authenticated deletes" — DELETE from course-materials.
--   • "Public read live-classroom-decks" — SELECT on the deck bucket
--     with NO predicate beyond bucket_id. Any user could read all decks.
--   • "Professors upload to live-classroom-decks" — INSERT only checked
--     role='professor', not the specific room ownership, so any prof
--     could upload to any room (mixing across tenants).
--   • "Professors delete from live-classroom-decks" — same flaw on DELETE.
--
-- After this migration, the strict policies from migrations 47/48/49
-- are the ONLY policies on these buckets, and they correctly enforce
-- tenant isolation via lc_user_can_access_room(),
-- is_section_member(), and is_section_owner_or_staff().

BEGIN;

DROP POLICY IF EXISTS "Allow public reads" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated deletes" ON storage.objects;

DROP POLICY IF EXISTS "Public read live-classroom-decks" ON storage.objects;
DROP POLICY IF EXISTS "Professors upload to live-classroom-decks" ON storage.objects;
DROP POLICY IF EXISTS "Professors delete from live-classroom-decks" ON storage.objects;

COMMIT;
