-- Live Classroom Recording — opt-in, event-sourced replay of the BROADCAST view.
--
-- We do NOT capture pixels. The live classroom is already event-sourced: the
-- broadcast students see is static slide WebP images + vector annotation strokes
-- (lc_slide_annotations, durable, timestamped) + per-slide transcript
-- (lc_transcriptions). A "recording" therefore stores just two new things:
--   1. a durable SLIDE TIMELINE (when each slide/deck was shown) — lc_events,
--      where slide_changed lives, is purged on room end, so we persist our own.
--   2. the professor's MIC AUDIO as one or more self-contained WebM sessions
--      (a tab reload starts a new session; we never byte-concat across sessions).
-- Playback re-renders slides+annotations against the audio clock — privacy-safe
-- by construction (the professor's own screen is never captured) and editable as
-- data. See the /conduct plan.
--
-- Tenant scoping: lc_* tables carry no institution_id; isolation flows through
-- room_id -> lc_rooms -> (prof_id | section enrollments), matching every
-- existing lc_ policy (migrations 30/34/36/61, lc_class_insights 20260615013146).
--
-- Created: 2026-07-03

-- ── 1. Recording record (one row per room) ───────────────────────────
-- Opt-in: a row exists ONLY once the professor starts recording. status
-- lifecycle: recording -> processing (finalize claim) -> ready | failed.
-- `timeline` is the slide spine: [{ts:<epoch ms>, deck_id:<uuid>, slide_index:<int>}],
-- appended atomically by the trigger below (SQL || — no read-modify-write race).
CREATE TABLE lc_recordings (
  room_id               uuid PRIMARY KEY REFERENCES lc_rooms(id) ON DELETE CASCADE,
  status                text NOT NULL DEFAULT 'recording'
    CHECK (status IN ('recording', 'processing', 'ready', 'failed')),
  started_at            timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  duration_ms           integer, -- total audio across sessions, set at finalize
  timeline              jsonb NOT NULL DEFAULT '[]'::jsonb,
  generation_started_at timestamptz, -- finalize claim stamp (stale-retry guard)
  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lc_recordings ENABLE ROW LEVEL SECURITY;

-- Read-only for the room's professor OR an enrolled student (mirrors
-- lc_class_insights_student). Writes are service-role only (the startRecording /
-- finalize orchestrators verify ownership server-side first), so NO
-- insert/update/delete policy — a FOR ALL policy here would be a client write
-- hole (see .claude/rules/security-migrations.md, PR #198). auth.uid() wrapped
-- in a scalar subquery so the planner runs it once per query.
CREATE POLICY "prof or enrolled student reads recording"
  ON lc_recordings FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      WHERE r.id = lc_recordings.room_id
        AND (
          r.prof_id = (select auth.uid())
          OR EXISTS (
            SELECT 1 FROM enrollments e
            WHERE e.section_id = r.section_id
              AND e.student_id = (select auth.uid())
              AND e.status IN ('enrolled', 'completed')
          )
        )
    )
  );

-- ── 2. Audio sessions (one row per continuous MediaRecorder session) ──
-- A separate table (not a jsonb array on lc_recordings) so add = plain INSERT
-- and finish = plain UPDATE — atomic by default, no read-modify-write. A tab
-- reload/crash ends one session and the next Record click starts another;
-- chunks live in storage at {room_id}/{id}/chunk-{seq}.webm and are byte-
-- concatenated per session at finalize into `path` (valid because they share
-- one WebM header lineage; cross-session concat would corrupt).
CREATE TABLE lc_recording_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       uuid NOT NULL REFERENCES lc_rooms(id) ON DELETE CASCADE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  duration_ms   integer,      -- client-reported recorded length, set on finish
  chunk_count   integer NOT NULL DEFAULT 0, -- highest seq + 1, set on finish
  path          text,         -- concatenated object path, set at finalize
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- FK column on a growing table needs its own index (Postgres doesn't auto-index
-- FKs); finalize + getRecording both query sessions by room_id ordered by start.
CREATE INDEX lc_recording_sessions_room_idx
  ON lc_recording_sessions (room_id, started_at);

-- Service-role only: all access is via the getRecording / finalize orchestrators
-- using the admin client. RLS enabled with NO authenticated policy = default-deny
-- for anon/authenticated (intentional, mirrors lc_events). Not a tenant leak —
-- clients never touch this table directly.
ALTER TABLE lc_recording_sessions ENABLE ROW LEVEL SECURITY;

-- ── 3. Slide-timeline trigger on lc_rooms ────────────────────────────
-- Appends a timeline entry to the ACTIVE recording whenever the shown slide or
-- deck changes — in-DB and atomic, so it can't lose an event to a race and it
-- fires no matter how the update was initiated (advanceSlide, switchDeck, or a
-- future/cron path). No-op (0 rows) when no recording is in 'recording' status.
CREATE OR REPLACE FUNCTION lc_recording_append_timeline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.current_slide IS DISTINCT FROM OLD.current_slide
      OR NEW.active_deck_id IS DISTINCT FROM OLD.active_deck_id) THEN
    UPDATE lc_recordings
    SET timeline = timeline || jsonb_build_object(
          'ts', (extract(epoch FROM now()) * 1000)::bigint,
          'deck_id', NEW.active_deck_id,
          'slide_index', NEW.current_slide
        )
    WHERE room_id = NEW.id
      AND status = 'recording';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lc_rooms_recording_timeline
  AFTER UPDATE ON lc_rooms
  FOR EACH ROW
  EXECUTE FUNCTION lc_recording_append_timeline();

-- This is a trigger-only SECURITY DEFINER function; the trigger fires it with
-- definer rights regardless of grants. Postgres grants EXECUTE to PUBLIC by
-- default, which would also expose it as an anon/authenticated RPC
-- (/rest/v1/rpc/…) — a needless SECURITY DEFINER surface. Lock it to internal
-- use only. (Supabase advisor: *_security_definer_function_executable.)
REVOKE EXECUTE ON FUNCTION public.lc_recording_append_timeline() FROM public, anon, authenticated;

-- ── 4. Audio storage bucket (private, default-deny) ───────────────────
-- Every access is server-mediated (mirrors preclass-audio / athena-attachments):
--   * Write → the professor's browser uploads chunks via short-lived signed
--             upload URLs minted by createChunkUploadUrl (admin client) after an
--             ownership check; finalize writes the concatenated object.
--   * Read  → getRecording mints a short-lived signed URL (admin client).
-- No storage.objects policies → anon/authenticated cannot touch the bucket at
-- all; the real gate is the ownership/enrollment check in the server actions.
-- Path layout: {room_id}/{session_id}/chunk-{seq}.webm  (raw chunks)
--              {room_id}/{session_id}.webm               (finalized session)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'live-classroom-recordings',
  'live-classroom-recordings',
  false,
  209715200, -- 200 MB (a 90-min Opus voice track is ~40 MB; ample headroom)
  ARRAY['audio/webm', 'audio/ogg']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
