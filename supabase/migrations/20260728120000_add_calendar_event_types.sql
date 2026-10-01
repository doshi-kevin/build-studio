-- Widen blocked_times.reason so professors can add lectures and other scheduled events to
-- their calendar — not just availability blocks.
--
-- blocked_times is the professor's one-off "busy time" layer: every entry occupies the
-- professor's schedule and prevents students from booking office hours that overlap it —
-- which is exactly the behavior we want for a lecture / exam / seminar as well. The new
-- values are purely additive; existing rows and the table's RLS, ownership, and
-- enrolled-student read scope (20260611220312_scope_blocked_times_and_reaction_rls.sql)
-- are unchanged. This only relaxes a CHECK constraint, so no advisors are implicated.

-- Drop whatever the existing reason CHECK is named (the CREATE TABLE used an inline,
-- auto-named constraint — normally blocked_times_reason_check, but match by definition to
-- be safe) so this migration is robust and re-runnable.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.blocked_times'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%reason%'
  LOOP
    EXECUTE format('ALTER TABLE public.blocked_times DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE public.blocked_times
  ADD CONSTRAINT blocked_times_reason_check
  CHECK (reason IN (
    -- scheduled events
    'lecture', 'seminar', 'exam', 'meeting', 'conference',
    -- availability blocks
    'lunch', 'personal', 'other'
  ));
