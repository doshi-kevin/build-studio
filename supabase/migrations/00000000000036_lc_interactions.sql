-- Phase 2: generic interactions + responses for the unified Live Classroom.
--
-- Replaces the old 8-table classroom schema (live_polls, poll_responses,
-- live_quizzes, quiz_responses, session_questions, question_upvotes,
-- session_participants, classroom_sessions) with two generic tables that
-- can host every "interaction" type (poll, quiz, question, future kinds)
-- and one row per response.
--
-- Triggers fan out broadcast events on the room's authoritative topic via
-- lc_send_event(). Aggregate updates are debounced server-side using a
-- pg_advisory_xact_lock + last_aggregate_at column to avoid emitting an
-- event per submission under burst load (e.g., 100 students answering
-- a poll at once).
--
-- This migration is purely additive — no UI consumer wires up to it yet.
-- Phase 3 builds the unified UI; Phase 5 drops the old 8 tables.

-- ── lc_interactions ──────────────────────────────────────────────────

CREATE TABLE lc_interactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id            uuid NOT NULL REFERENCES lc_rooms(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('poll','quiz','question')),
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  created_by         uuid NOT NULL REFERENCES profiles(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  opened_at          timestamptz,
  closed_at          timestamptz,
  last_aggregate_at  timestamptz
);

CREATE INDEX idx_lc_interactions_room_status ON lc_interactions (room_id, status);
CREATE INDEX idx_lc_interactions_room_created ON lc_interactions (room_id, created_at DESC);

ALTER TABLE lc_interactions ENABLE ROW LEVEL SECURITY;

-- Professors: full control over interactions in rooms they own.
CREATE POLICY "prof manages interactions in own rooms"
  ON lc_interactions FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM lc_rooms r WHERE r.id = lc_interactions.room_id AND r.prof_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM lc_rooms r WHERE r.id = lc_interactions.room_id AND r.prof_id = auth.uid()));

-- Students: read-only access to interactions in rooms for sections they're enrolled in.
-- (Drafts are visible too; the UI hides drafts. Server-side, the open/closed gate
--  is enforced by the action layer rather than RLS to allow a "scheduled" UX later.)
CREATE POLICY "students view interactions in enrolled rooms"
  ON lc_interactions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lc_rooms r
      JOIN enrollments e ON e.section_id = r.section_id
      WHERE r.id = lc_interactions.room_id
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled','completed')
    )
  );

-- ── lc_responses ─────────────────────────────────────────────────────

CREATE TABLE lc_responses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id  uuid NOT NULL REFERENCES lc_interactions(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES profiles(id),
  response        jsonb NOT NULL,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interaction_id, student_id)
);
CREATE INDEX idx_lc_responses_interaction ON lc_responses (interaction_id);
CREATE INDEX idx_lc_responses_student ON lc_responses (student_id);

ALTER TABLE lc_responses ENABLE ROW LEVEL SECURITY;

-- Professors: read all responses to interactions in their rooms.
CREATE POLICY "prof reads responses in own rooms"
  ON lc_responses FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM lc_interactions i
    JOIN lc_rooms r ON r.id = i.room_id
    WHERE i.id = lc_responses.interaction_id AND r.prof_id = auth.uid()
  ));

-- Students: read own response.
CREATE POLICY "students read own responses"
  ON lc_responses FOR SELECT TO authenticated
  USING (student_id = auth.uid());

-- Students: insert own response when interaction is open.
CREATE POLICY "students insert own responses"
  ON lc_responses FOR INSERT TO authenticated
  WITH CHECK (
    student_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM lc_interactions i
      JOIN lc_rooms r ON r.id = i.room_id
      JOIN enrollments e ON e.section_id = r.section_id
      WHERE i.id = lc_responses.interaction_id
        AND i.status = 'open'
        AND e.student_id = auth.uid()
        AND e.status IN ('enrolled','completed')
    )
  );

-- ── Trigger: broadcast on interaction lifecycle ──────────────────────

CREATE OR REPLACE FUNCTION lc_interactions_after_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM lc_send_event(
      NEW.room_id,
      'interaction_created',
      jsonb_build_object('id', NEW.id, 'kind', NEW.kind, 'payload', NEW.payload, 'status', NEW.status)
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM lc_send_event(
      NEW.room_id,
      CASE NEW.status
        WHEN 'open'   THEN 'interaction_opened'
        WHEN 'closed' THEN 'interaction_closed'
        ELSE 'interaction_updated'
      END,
      jsonb_build_object('id', NEW.id, 'kind', NEW.kind, 'status', NEW.status)
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.payload IS DISTINCT FROM OLD.payload THEN
    -- Q&A upvotes / answered flag flip the payload but not the status; emit a
    -- generic update so the UI can re-render the affected row.
    PERFORM lc_send_event(
      NEW.room_id,
      'interaction_updated',
      jsonb_build_object('id', NEW.id, 'kind', NEW.kind, 'status', NEW.status, 'payload', NEW.payload)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lc_interactions_after_change ON lc_interactions;
CREATE TRIGGER trg_lc_interactions_after_change
  AFTER INSERT OR UPDATE ON lc_interactions
  FOR EACH ROW
  EXECUTE FUNCTION lc_interactions_after_change();

-- ── Trigger: server-aggregated counts on every response, debounced ───
--
-- Recomputes the aggregate cheaply (indexed query), caches it on the
-- interaction's payload, and emits aggregate_updated at most once per
-- 500ms per interaction. closeInteraction() emits one final unconditional
-- aggregate_updated so the UI sees the absolute final count.

CREATE OR REPLACE FUNCTION lc_responses_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_int             lc_interactions%ROWTYPE;
  v_agg             jsonb;
  v_should_broadcast boolean;
BEGIN
  -- Serialize aggregate writes per interaction.
  PERFORM pg_advisory_xact_lock(hashtext('lc_int:' || NEW.interaction_id::text));

  SELECT * INTO v_int FROM lc_interactions WHERE id = NEW.interaction_id;

  IF v_int.kind = 'poll' THEN
    SELECT jsonb_object_agg(choice_id, cnt)
      INTO v_agg
      FROM (
        SELECT jsonb_array_elements_text(response->'choiceIds') AS choice_id, COUNT(*) AS cnt
        FROM lc_responses
        WHERE interaction_id = NEW.interaction_id
        GROUP BY 1
      ) s;
    IF v_agg IS NULL THEN v_agg := '{}'::jsonb; END IF;
  ELSE
    -- Quizzes (and any future kind) — track submission count.
    SELECT jsonb_build_object('submissions', COUNT(*))
      INTO v_agg
      FROM lc_responses
      WHERE interaction_id = NEW.interaction_id;
  END IF;

  -- Cache the aggregate so getRoomSnapshot can read it without recomputing.
  UPDATE lc_interactions
     SET payload = payload || jsonb_build_object('counts', v_agg)
   WHERE id = NEW.interaction_id;

  v_should_broadcast := v_int.last_aggregate_at IS NULL
    OR v_int.last_aggregate_at < now() - interval '500 milliseconds';

  IF v_should_broadcast THEN
    UPDATE lc_interactions SET last_aggregate_at = now() WHERE id = NEW.interaction_id;
    PERFORM lc_send_event(
      v_int.room_id,
      'aggregate_updated',
      jsonb_build_object('interactionId', NEW.interaction_id, 'aggregate', v_agg)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lc_responses_after_insert ON lc_responses;
CREATE TRIGGER trg_lc_responses_after_insert
  AFTER INSERT ON lc_responses
  FOR EACH ROW
  EXECUTE FUNCTION lc_responses_after_insert();
