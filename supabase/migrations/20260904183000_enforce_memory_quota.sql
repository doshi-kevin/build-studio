-- A hard ceiling on how many memory rows one person can hold in one slot.
--
-- The application already trims to MULTI_VALUE_CAP (3) after each write. This
-- exists for the cases application code cannot cover: a caller that forgets to
-- trim, a burst of concurrent writes, or a trim whose delete quietly failed.
--
-- It EVICTS rather than raising. An earlier version raised an exception at the
-- ceiling, which deadlocks: the application trims only AFTER a successful
-- insert, so once a slot is full every later insert is rejected and the trim
-- that would free space never runs. That slot would be dead for that user
-- forever, with no path back. A database is better placed to keep its own
-- invariant than to refuse and hope somebody else fixes it.

CREATE OR REPLACE FUNCTION enforce_user_memory_quota()
RETURNS TRIGGER AS $$
DECLARE
  ceiling CONSTANT integer := 10;
BEGIN
  -- Scope matches trimSlot exactly, so the database and the application agree on
  -- what "a slot" means. `section_id` is nullable and NULL = NULL is not true in
  -- SQL, hence the explicit branch rather than a plain equality.
  DELETE FROM user_memory
  WHERE id IN (
    SELECT id FROM user_memory
    WHERE user_id = NEW.user_id
      AND institution_id = NEW.institution_id
      AND kind = NEW.kind
      AND ((section_id IS NULL AND NEW.section_id IS NULL) OR (section_id = NEW.section_id))
    ORDER BY observed_at DESC
    -- Keep the newest (ceiling - 1); this insert becomes the newest of all.
    OFFSET ceiling - 1
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
-- Pinned so the function cannot be steered by a caller's search_path, which the
-- Supabase advisor flags on any function without one.
SET search_path = public, pg_temp;

-- Postgres has no CREATE TRIGGER IF NOT EXISTS, so drop first to stay re-runnable.
DROP TRIGGER IF EXISTS enforce_user_memory_quota_trigger ON user_memory;

CREATE TRIGGER enforce_user_memory_quota_trigger
BEFORE INSERT ON user_memory
FOR EACH ROW
EXECUTE FUNCTION enforce_user_memory_quota();

COMMENT ON FUNCTION enforce_user_memory_quota() IS
  'Evicts the oldest rows so no (user, institution, section, slot) exceeds 10. The application trims to 3; this is the backstop for a caller that does not, and it evicts rather than raising so a full slot can never lock a user out.';
