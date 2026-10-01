-- Give institutions the standard updated_at trigger (#742).
--
-- This is a PREREQUISITE, not a nicety. The house convention for edit-form
-- concurrency (.claude/rules/data-access.md) is an optimistic guard that puts the
-- row's updated_at in the UPDATE's WHERE clause and treats zero rows as a conflict.
-- That convention rests on every participating table having an
-- update_<table>_updated_at trigger, and the rule says to verify it before relying
-- on the column on a new table.
--
-- institutions does NOT have one. Verified against production: the only trigger on
-- the table is sync_institution_status_to_members_trigger. The column exists and has
-- a now() DEFAULT, so it is set at INSERT and then never advances again. (One
-- super-admin action sets it by hand; that is the only thing maintaining it, and
-- only on that one path.)
--
-- So without this trigger, .eq('updated_at', expected) would match FOREVER: the
-- guard would look installed, every save would still report success, and the lost
-- update would continue silently. A non-fix that reads as fixed is worse than the
-- bug it was meant to close.
--
-- update_updated_at() sets NEW.updated_at = now() unconditionally, so it also
-- overrides the hand-set value on the super-admin path. That is fine -- that path
-- sets it to now() anyway -- and it makes institutions behave like every other core
-- table.

DROP TRIGGER IF EXISTS update_institutions_updated_at ON public.institutions;

CREATE TRIGGER update_institutions_updated_at
  BEFORE UPDATE ON public.institutions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();
