-- Schedule Live Classrooms — schema for scheduling lc_rooms ahead of time.
--
-- Adds a 'scheduled' room status + scheduled_at + recurrence grouping, lets
-- slides be pre-rendered against a not-yet-live room (guard relaxations live in
-- the action/route layer), keeps students from peeking at scheduled rooms and
-- their pre-uploaded decks, and lets the background render queue hold more than
-- one active job per section. Attended model: no auto-go-live — the professor
-- still clicks "Start class"; so there is NO exact-time start cron here.

-- ── 1. lc_rooms: scheduled state ─────────────────────────────────────
ALTER TABLE lc_rooms ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
-- Occurrences of one weekly series share this id (null for one-offs). No parent
-- table: each occurrence is its own scheduled lc_rooms row.
ALTER TABLE lc_rooms ADD COLUMN IF NOT EXISTS recurrence_group_id uuid;

-- Relax the status CHECK to allow 'scheduled'. The inline constraint from
-- migration 30 is named lc_rooms_status_check. Default stays 'live' (start-now).
ALTER TABLE lc_rooms DROP CONSTRAINT IF EXISTS lc_rooms_status_check;
ALTER TABLE lc_rooms
  ADD CONSTRAINT lc_rooms_status_check CHECK (status IN ('scheduled','live','ended'));

-- Fast lookup of a section's upcoming sessions (the "Upcoming" list) and of due
-- scheduled rooms for the cleanup sweep.
CREATE INDEX IF NOT EXISTS idx_lc_rooms_section_scheduled
  ON lc_rooms (section_id, scheduled_at)
  WHERE status = 'scheduled';

-- ── 2. Students can't peek at scheduled rooms' decks ─────────────────
-- Slide images live in a public bucket behind unguessable versioned paths (a
-- capability URL, same as today's pre-class render). This closes the remaining
-- gap: the deck ROW (which carries deck_url) must not be readable by students
-- until the class is live. Tightens the migration-30 student SELECT policy to
-- rooms with status IN ('live','ended'); the prof policy is unchanged.
DROP POLICY IF EXISTS "students read decks in enrolled rooms" ON lc_decks;
CREATE POLICY "students read decks in enrolled rooms"
  ON lc_decks FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      JOIN enrollments e ON e.section_id = r.section_id
      WHERE r.id = lc_decks.room_id
        AND r.status IN ('live','ended')   -- block early peek at scheduled decks
        AND e.student_id = (select auth.uid())
        AND e.status IN ('enrolled','completed')
    )
  );

-- ── 3. background_jobs: allow >1 active render job per section ────────
-- The active-unique index caps one pending/running job per (institution,
-- section, type). Slide rendering is per-DECK, and a professor can schedule
-- several lectures for one section at once — each needs its own render. Exempt
-- render_scheduled_deck from the cap (the pipeline is idempotent on deck_url,
-- so a lost/double kick still can't double-render). All other types keep the
-- one-active-per-section guarantee.
DROP INDEX IF EXISTS uq_background_jobs_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_background_jobs_active
  ON public.background_jobs (
    institution_id,
    coalesce(section_id, '00000000-0000-0000-0000-000000000000'::uuid),
    type
  )
  WHERE status IN ('pending', 'running')
    AND type <> 'render_scheduled_deck';

-- ── 4. Cleanup sweep: expire never-started scheduled rooms (24h grace) ─
-- Extends the existing every-15-min lc_rooms_auto_end cron. A scheduled room
-- the professor never started is soft-ended only after a 24h grace, so a
-- delayed/late class is never yanked out from under them (attended model —
-- start requires status IN ('scheduled','live')). Storage cleanup mirrors the
-- live-room path (best-effort; daily reaper handles leftovers).
CREATE OR REPLACE FUNCTION public.lc_auto_end_stale_rooms()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $function$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id::text AS id
      FROM lc_rooms
     WHERE status = 'live'
       AND created_at < now() - interval '12 hours'
  LOOP
    UPDATE lc_rooms
       SET status = 'ended',
           ended_at = now()
     WHERE id = r.id::uuid;

    BEGIN
      DELETE FROM storage.objects
       WHERE bucket_id = 'live-classroom-decks'
         AND name LIKE r.id || '/%';
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;

  -- Scheduled rooms whose start time passed by >24h and were never started.
  FOR r IN
    SELECT id::text AS id
      FROM lc_rooms
     WHERE status = 'scheduled'
       AND scheduled_at IS NOT NULL
       AND scheduled_at < now() - interval '24 hours'
  LOOP
    UPDATE lc_rooms
       SET status = 'ended',
           ended_at = now()
     WHERE id = r.id::uuid;

    BEGIN
      DELETE FROM storage.objects
       WHERE bucket_id = 'live-classroom-decks'
         AND name LIKE r.id || '/%';
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END $function$;
