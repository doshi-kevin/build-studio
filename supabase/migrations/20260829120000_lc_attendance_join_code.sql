-- Attendance join code for a live classroom session (#82).
--
-- Attendance was recorded for any enrolled student who opened the room URL, so a student at
-- home was marked present. The professor now shows a short code on the projector, and only a
-- student who can read that screen can claim attendance.
--
-- SCOPE: the code gates ATTENDANCE, not the room. A student without it still sees the slides
-- and answers polls; they are simply not marked present. Gating the room would punish a
-- legitimately remote student and turn a dropped connection into a lost lecture, which is a
-- much bigger harm than an unearned tick. Issue #772 tracks the residual hole (a student in
-- the room texting the code to a friend), deliberately unsolved for now.
--
-- ── Why this is its own table, not a column on lc_rooms ────────────────────────────────
-- The policy "students view rooms in enrolled sections" lets any enrolled student SELECT
-- their section's lc_rooms row with their own browser session. A join_code column there
-- would be readable by exactly the people it exists to gate — one API call from home and the
-- feature is worth nothing. Row-level security cannot help, because the row is legitimately
-- theirs to read; it is this one FIELD that must not be. Postgres has no row-level answer to
-- that, so the code lives on a row students have no policy for at all.
--
-- ── Uniqueness ─────────────────────────────────────────────────────────────────────────
-- "No two classes share a code" cannot be a property of the random generator; with enough
-- rooms a birthday collision is inevitable and would silently mark the wrong class present.
-- The unique index makes a duplicate IMPOSSIBLE and the generator simply retries when it
-- loses. Randomness picks a candidate; the database decides.
--
-- The row is created when a class STARTS and deleted when it ends, so a code is only ever
-- taken while it is on a screen somewhere. That also stops the namespace filling up over a
-- term without a sweep job.
--
-- ── Alphabet ───────────────────────────────────────────────────────────────────────────
-- 4 characters over a 31-character alphabet with the ambiguous glyphs removed (no O/0, no
-- I/1/L). 923,521 combinations, which the index makes sufficient regardless. Short because
-- it is read from the back of a lecture hall and often said aloud; guessing is prevented by
-- rate-limiting attempts, not by length.

CREATE TABLE IF NOT EXISTS lc_room_codes (
  room_id    uuid PRIMARY KEY REFERENCES lc_rooms(id) ON DELETE CASCADE,
  code       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lc_room_codes IS
  'Attendance code shown on the projector for a running live class (#82). Deliberately not a '
  'column on lc_rooms: students can read their own section''s lc_rooms row, and could then '
  'read the code they are supposed to be gated by. One row per live class, deleted when the '
  'class ends.';

-- The guarantee. No status predicate is needed because the row only exists while live.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lc_room_codes_code ON lc_room_codes (code);

/* Same argument as the unique index: if length and alphabet are the reason a short code is
   safe, they belong here and not only in the generator that happens to produce them. */
ALTER TABLE lc_room_codes DROP CONSTRAINT IF EXISTS lc_room_codes_code_shape;
ALTER TABLE lc_room_codes
  ADD CONSTRAINT lc_room_codes_code_shape
  CHECK (code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$');

ALTER TABLE lc_room_codes ENABLE ROW LEVEL SECURITY;

-- The professor of that room, and nobody else. Students get NO policy, which under RLS means
-- no access — that absence is the whole security property, so do not add one.
DROP POLICY IF EXISTS "prof reads own room code" ON lc_room_codes;
CREATE POLICY "prof reads own room code" ON lc_room_codes
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      WHERE r.id = lc_room_codes.room_id
        AND r.prof_id = (SELECT auth.uid())
    )
  );

-- No INSERT/UPDATE/DELETE policies: writes happen only through the service-role client in
-- startLiveClass, and releases happen in the trigger below.

/* Supabase grants `authenticated` full DML on every new table in the public schema. RLS with
   no write policy already refuses those writes, but the grant is the same gap that shipped a
   real bug in e890af2e, so it is taken away rather than left to one layer. SELECT stays, and
   the policy above is what actually narrows it to the professor. */
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON lc_room_codes FROM authenticated;
REVOKE ALL ON lc_room_codes FROM anon;

/* Release the code the moment the class stops being live, from EVERY path that ends one:
   the professor's End class button, cancelling a scheduled session, and the
   lc_auto_end_stale_rooms() cron. A trigger covers all three and any future fourth, which
   is why the delete is not written into the end-class action. */
CREATE OR REPLACE FUNCTION lc_release_join_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'live' THEN
    DELETE FROM lc_room_codes WHERE room_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION lc_release_join_code() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_lc_release_join_code ON lc_rooms;
CREATE TRIGGER trg_lc_release_join_code
  AFTER UPDATE OF status ON lc_rooms
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM 'live')
  EXECUTE FUNCTION lc_release_join_code();
