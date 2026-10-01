-- #658 (realtime half) — the room snapshot correctly redacts a question's voter list, but
-- the broadcast did not, so the moment anyone upvoted, every student in the room received
-- the FULL `upvotedBy` array over the WebSocket and the client merged it straight into
-- state. The redaction held on reload and leaked live, which is the worse half.
--
-- Cause: this trigger sanitizes only `NEW.kind = 'quiz'`. A question broadcast NEW.payload
-- verbatim. Never covered rather than regressed.
--
-- Fix: drop `upvotedBy` from question broadcasts entirely. Per-recipient personalisation is
-- impossible here — one broadcast goes to the whole room — but it is also unnecessary: the
-- client merges with `{ ...q.payload, ...evt.payload }`, so OMITTING the key leaves each
-- viewer's own `upvotedBy` (already redacted to just themselves by the snapshot) intact
-- while the `upvotes` COUNT still updates live. Nobody learns who else voted.
--
-- `authorName` is dropped for anonymous questions too. askQuestion stores null there today,
-- so this changes nothing now — it means a future write that forgets cannot leak the asker
-- through this path.
create or replace function public.lc_interactions_after_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  ELSIF NEW.kind = 'question' THEN
    -- Who voted is never broadcast (#658). The client keeps its own redacted list.
    v_payload := v_payload - 'upvotedBy';
    IF (v_payload->>'anonymous')::boolean IS TRUE THEN
      v_payload := v_payload - 'authorName';
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
$function$;

comment on function public.lc_interactions_after_change() is
  'Broadcasts interaction changes with a student-safe payload: quiz answers stripped, and a question''s voter list (and an anonymous asker''s name) never broadcast (#658).';
