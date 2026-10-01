-- Live Classroom Broadcast Foundation (Phase 0)
--
-- This migration lays the architectural primitives for moving the Live
-- Classroom feature from Supabase `postgres_changes` (CDC over WAL) onto
-- Supabase `Broadcast` (the trigger-driven `realtime.send()` pattern).
--
-- What it adds:
--   1. `lc_events` — append-only replay buffer for per-room broadcast events
--      so clients can recover missed events after a disconnect.
--   2. `lc_user_can_access_room()` — helper used by both the broadcast
--      triggers and the realtime.messages topic-authorization policies.
--   3. `lc_send_event()` — generic broadcaster: optionally persists to
--      `lc_events`, then calls realtime.send() on the room's private topic.
--   4. `lc_rooms_after_update()` — first concrete trigger: broadcasts
--      `slide_changed` and `room_ended` events.
--   5. RLS on `realtime.messages` for the two-topic model:
--        - `room:<uuid>`        — authoritative topic, READ only for clients.
--        - `room:<uuid>:ephem`  — ephemeral topic, READ + WRITE for clients
--                                 (used in Phase 4 for live drawing strokes).
--      Authoritative events flow only via SECURITY DEFINER triggers, which
--      bypass realtime.messages RLS, so a malicious client cannot spoof
--      authoritative events on the `room:<uuid>` topic.
--   6. `pg_cron` job that prunes events older than 10 minutes from rooms
--      that are no longer live.
--
-- No existing UI consumer wires up to this yet — Phase 1 will swap the
-- slide-sync transport and Phase 2+ will add interactions/Q&A/drawings.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── lc_events: append-only replay buffer ─────────────────────────────

CREATE TABLE lc_events (
  seq         BIGSERIAL PRIMARY KEY,
  room_id     uuid NOT NULL REFERENCES lc_rooms(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lc_events_room_seq    ON lc_events (room_id, seq);
CREATE INDEX idx_lc_events_created_at  ON lc_events (created_at);

-- RLS enabled but no client SELECT policy: replay flows through the
-- getEventsSince() server action with the admin client.
ALTER TABLE lc_events ENABLE ROW LEVEL SECURITY;

-- ── Helper: can this user access this room? ──────────────────────────
--
-- SECURITY DEFINER so it can read lc_rooms + enrollments without the
-- caller needing direct SELECT privileges. Used by both the broadcast
-- triggers (which always succeed because they run as the table owner)
-- and the realtime.messages authorization policies (which run as the
-- subscribing user).

CREATE OR REPLACE FUNCTION lc_user_can_access_room(p_user_id uuid, p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM lc_rooms r
    WHERE r.id = p_room_id
      AND (
        r.prof_id = p_user_id
        OR EXISTS (
          SELECT 1
          FROM enrollments e
          WHERE e.section_id = r.section_id
            AND e.student_id = p_user_id
            AND e.status IN ('enrolled', 'completed')
        )
      )
  );
$$;

-- ── Generic broadcaster: persist + send ──────────────────────────────
--
-- p_persist=true   → write to lc_events first, capture seq, broadcast with seq.
-- p_persist=false  → broadcast with seq=null (ephemeral, not replayable).
--
-- Returns the seq of the persisted event (or NULL when p_persist=false).
--
-- NOTE: realtime.send() signature is (payload jsonb, event text, topic text,
-- private boolean). The 4-arg form is canonical (Supabase Broadcast docs).

CREATE OR REPLACE FUNCTION lc_send_event(
  p_room_id    uuid,
  p_event_type text,
  p_data       jsonb,
  p_persist    boolean DEFAULT true
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq     bigint;
  v_payload jsonb;
BEGIN
  IF p_persist THEN
    INSERT INTO lc_events (room_id, event_type, payload)
    VALUES (p_room_id, p_event_type, p_data)
    RETURNING seq INTO v_seq;
  ELSE
    v_seq := NULL;
  END IF;

  v_payload := jsonb_build_object(
    'seq',  v_seq,
    'ts',   now(),
    'type', p_event_type,
    'data', p_data
  );

  PERFORM realtime.send(
    v_payload,
    p_event_type,
    'room:' || p_room_id::text,
    true  -- private channel
  );

  RETURN v_seq;
END;
$$;

-- ── lc_rooms triggers: slide-changed + room-ended ────────────────────
--
-- Slide changes broadcast the new slide index. When a room ends, broadcast
-- a room_ended event AND immediately purge the room's events from the
-- replay buffer (no point retaining them).

CREATE OR REPLACE FUNCTION lc_rooms_after_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.current_slide IS DISTINCT FROM OLD.current_slide THEN
    PERFORM lc_send_event(
      NEW.id,
      'slide_changed',
      jsonb_build_object('slideIndex', NEW.current_slide)
    );
  END IF;

  IF NEW.status = 'ended' AND OLD.status = 'live' THEN
    PERFORM lc_send_event(
      NEW.id,
      'room_ended',
      jsonb_build_object()
    );
    DELETE FROM lc_events WHERE room_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lc_rooms_after_update ON lc_rooms;
CREATE TRIGGER trg_lc_rooms_after_update
  AFTER UPDATE ON lc_rooms
  FOR EACH ROW
  EXECUTE FUNCTION lc_rooms_after_update();

-- ── Topic authorization on realtime.messages ─────────────────────────
--
-- Two-topic model:
--   `room:<uuid>`        — authoritative events from triggers only.
--                          Clients can SELECT (subscribe + receive) but
--                          NOT INSERT (so they cannot spoof slide_changed,
--                          room_ended, etc.). Triggers bypass this policy
--                          because they run as SECURITY DEFINER from the
--                          table owner.
--   `room:<uuid>:ephem`  — ephemeral client-emitted events (drawings,
--                          future cursors/reactions). Clients can SELECT
--                          and INSERT.
--
-- The READ policy accepts either topic. The INSERT policy is restricted
-- to the `:ephem` suffix.

DROP POLICY IF EXISTS "lc room read access" ON realtime.messages;
CREATE POLICY "lc room read access"
  ON realtime.messages FOR SELECT
  TO authenticated
  USING (
    (realtime.topic() ~ '^room:[0-9a-f-]{36}(:ephem)?$')
    AND lc_user_can_access_room(
      (SELECT auth.uid()),
      (regexp_match(realtime.topic(), '^room:([0-9a-f-]{36})(:ephem)?$'))[1]::uuid
    )
  );

DROP POLICY IF EXISTS "lc room ephem write access" ON realtime.messages;
CREATE POLICY "lc room ephem write access"
  ON realtime.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    (realtime.topic() ~ '^room:[0-9a-f-]{36}:ephem$')
    AND lc_user_can_access_room(
      (SELECT auth.uid()),
      (regexp_match(realtime.topic(), '^room:([0-9a-f-]{36}):ephem$'))[1]::uuid
    )
  );

-- ── pg_cron: prune stale replay buffer entries ───────────────────────
--
-- Runs every 5 minutes, deletes events older than 10 minutes from rooms
-- that are no longer live. Live rooms keep a rolling 10-minute window
-- so reconnecting clients can replay any event from the recent past.
-- The endRoom trigger purges immediately.

SELECT cron.schedule(
  'lc_events_prune',
  '*/5 * * * *',
  $$
    DELETE FROM lc_events
     WHERE created_at < now() - interval '10 minutes'
       AND room_id NOT IN (SELECT id FROM lc_rooms WHERE status = 'live');
  $$
);
