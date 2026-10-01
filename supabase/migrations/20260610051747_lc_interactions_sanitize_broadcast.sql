-- Strip quiz answers from the realtime broadcast.
--
-- The interaction lifecycle trigger broadcast the FULL interaction payload to
-- the room topic — which every enrolled student subscribes to. For quizzes that
-- payload includes each question's `correctChoiceId` + `explanation` (and, once
-- closed, the class `report`). So a student's realtime client received the
-- answer key for a LIVE quiz (via interaction_created on push, and again via
-- interaction_updated on every submission when the counts payload changed) —
-- readable in DevTools BEFORE answering. That defeats anti-cheat regardless of
-- any UI gating.
--
-- Fix: sanitize the broadcast payload for quizzes — remove correctChoiceId +
-- explanation from each question and drop the report. The stored row is
-- unchanged (the professor's report computation and the server-gated reveal
-- paths still read the real answers); only what goes over the wire is reduced.
-- No table/RLS change — this only replaces the trigger function.

CREATE OR REPLACE FUNCTION lc_interactions_after_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payload jsonb;
BEGIN
  -- Build the student-safe payload: for quizzes, never broadcast answers.
  v_payload := NEW.payload;
  IF NEW.kind = 'quiz' THEN
    v_payload := v_payload - 'report';
    IF v_payload ? 'questions' THEN
      v_payload := jsonb_set(
        v_payload,
        '{questions}',
        COALESCE((
          SELECT jsonb_agg((q - 'correctChoiceId' - 'explanation') ORDER BY ord)
          FROM jsonb_array_elements(NEW.payload->'questions') WITH ORDINALITY AS t(q, ord)
        ), '[]'::jsonb)
      );
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM lc_send_event(
      NEW.room_id,
      'interaction_created',
      jsonb_build_object('id', NEW.id, 'kind', NEW.kind, 'payload', v_payload, 'status', NEW.status)
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    -- Status-change events carry no payload (no leak); unchanged.
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
    -- Q&A upvotes / answered flag / quiz counts flip the payload but not the
    -- status; emit a generic update with the sanitized payload.
    PERFORM lc_send_event(
      NEW.room_id,
      'interaction_updated',
      jsonb_build_object('id', NEW.id, 'kind', NEW.kind, 'status', NEW.status, 'payload', v_payload)
    );
  END IF;
  RETURN NEW;
END;
$$;
