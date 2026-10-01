-- Make programs.degree_type accept the vocabulary the application actually uses (#714).
--
-- The app and the database disagreed on the WORDS, not just their spelling:
--
--   app  (src/lib/validations/program.ts)  bachelor · master · doctorate · certificate · diploma
--   DB   (CHECK constraint)                bs       · ms     · phd       · certificate · minor
--
-- Only `certificate` overlapped, so four of the five types the UI offers could never be
-- saved — every attempt died on a 23514 check violation, which is why the issue reads
-- "4 of 5 degree types can't be created". The edit-program dialog shipped in #725 is
-- therefore usable today only for certificate programs.
--
-- The app's vocabulary wins. It is what the UI labels, what a reader recognises, and
-- `bs`/`ms`/`phd` bake US-specific shorthand into the data model — `bs` is also narrower
-- than `bachelor` (a Bachelor of Arts isn't a BS). `minor` is CARRIED OVER rather than
-- dropped: it is a real thing an institution may want to record, the database already
-- permitted it, and removing a previously-legal value to tidy up a list would be a
-- product decision disguised as a migration.
--
-- No data migration is needed. Verified against production before writing this: the
-- table holds exactly ONE row and its degree_type is `certificate`, the single value
-- present in both vocabularies. So no existing row can violate the new constraint.
-- (Checked rather than assumed, because a rename-style constraint swap silently fails
-- for every row using an old value, and the failure surfaces as a broken deploy.)
--
-- Keep this list in lockstep with DEGREE_TYPES in src/lib/validations/program.ts.
-- Changing one without the other is precisely the bug being fixed here.

-- Wrapped in a transaction. Without it, a DROP that succeeds followed by an ADD that
-- fails on a violating row leaves the table with NO constraint at all — and the failure
-- surfaces as a broken deploy rather than as a rejected migration. Prod is verified clean
-- (one row, `certificate`), but local, staging and the Scholera Dev sandbox are not
-- verifiable from here, and those are exactly where an old `bs`/`ms`/`phd` row would live.
BEGIN;

-- Map the retired values first, so a non-prod environment holding them migrates instead
-- of failing. No-op on production. `minor` and `certificate` survive as themselves.
UPDATE public.programs SET degree_type = 'bachelor'  WHERE degree_type = 'bs';
UPDATE public.programs SET degree_type = 'master'    WHERE degree_type = 'ms';
UPDATE public.programs SET degree_type = 'doctorate' WHERE degree_type = 'phd';

ALTER TABLE public.programs
  DROP CONSTRAINT IF EXISTS programs_degree_type_check;

ALTER TABLE public.programs
  ADD CONSTRAINT programs_degree_type_check
  CHECK (degree_type = ANY (ARRAY[
    'bachelor'::text,
    'master'::text,
    'doctorate'::text,
    'certificate'::text,
    'diploma'::text,
    'minor'::text
  ]));

COMMIT;
