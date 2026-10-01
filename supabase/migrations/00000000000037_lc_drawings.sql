-- Phase 4: drawings + presence support
--
-- Two changes:
--   1. Extend lc_send_event with a 5th p_broadcast arg (default true) so
--      callers can persist a `drawing_stroke_batch` row without re-broadcasting
--      it. (Strokes are broadcast directly via channel.send() on the ephemeral
--      topic — the persistence path is for late joiner replay only.)
--   2. Add a 1-minute pg_cron job that prunes drawing_stroke_batch rows
--      older than 60 seconds. Strokes are short-lived state.
--
-- IMPORTANT: drop the old 4-arg lc_send_event first. CREATE OR REPLACE on a
-- different parameter count creates a new overload, not a replacement, so
-- 3-arg calls from existing triggers (which rely on the p_persist default)
-- would otherwise be ambiguous.

DROP FUNCTION IF EXISTS lc_send_event(uuid, text, jsonb, boolean);

CREATE OR REPLACE FUNCTION lc_send_event(
  p_room_id    uuid,
  p_event_type text,
  p_data       jsonb,
  p_persist    boolean DEFAULT true,
  p_broadcast  boolean DEFAULT true
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

  IF p_broadcast THEN
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
      true
    );
  END IF;

  RETURN v_seq;
END;
$$;

-- Faster prune for stroke batches.
SELECT cron.schedule(
  'lc_events_drawings_prune',
  '* * * * *',
  $$
    DELETE FROM lc_events
     WHERE event_type = 'drawing_stroke_batch'
       AND created_at < now() - interval '60 seconds';
  $$
);
