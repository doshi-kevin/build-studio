-- #638 — "a concurrent poll vote silently disappears from the professor's view".
--
-- The filed diagnosis was a read-modify-write race on payload.counts. That is NOT
-- what this function does, and the data proves it: lc_responses_after_insert already
-- takes pg_advisory_xact_lock on the interaction and RECOMPUTES the aggregate with a
-- GROUP BY over lc_responses, so it never increments a stale snapshot. Checked every
-- poll in production: zero rows where payload->'counts' differs from the counts
-- derived live from lc_responses. The stored aggregate is correct everywhere.
--
-- The real defect is the BROADCAST GATE. Only the first write in a 500ms window
-- pushes an aggregate_updated event:
--
--   v_should_broadcast := last_aggregate_at IS NULL
--     OR last_aggregate_at < now() - interval '500 milliseconds';
--
-- Two students answering together is precisely a sub-500ms burst. The second insert
-- recomputes the CORRECT aggregate ({A:1, B:1}) and then throws it away, so the
-- professor keeps rendering the first insert's snapshot ({A:1}) — one choice frozen
-- at "0% · 0". Nothing repairs it: the professor's view is push-only (no periodic
-- refetch in use-room-channel), so the last write of any burst is the one that
-- decides what stays on screen, and a throttle that drops trailing updates makes
-- "last write" the wrong one. A vote that exists in the table but not on the
-- projector is indistinguishable from a lost vote to the person teaching.
--
-- Fix: always broadcast the recomputed aggregate. The throttle was protecting
-- against channel chatter, but the payload is one small JSONB object per vote, and
-- even a 200-student poll is a trivial number of realtime messages spread over the
-- seconds people actually take to answer. Correctness of what the professor sees
-- outranks that. last_aggregate_at is still maintained, so anything observing write
-- cadence keeps working.
--
-- Everything else in the function is unchanged.

create or replace function public.lc_responses_after_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_int lc_interactions%ROWTYPE;
  v_agg jsonb;
BEGIN
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
    SELECT jsonb_build_object('submissions', COUNT(*))
      INTO v_agg
      FROM lc_responses
      WHERE interaction_id = NEW.interaction_id;
  END IF;

  UPDATE lc_interactions
     SET payload = payload || jsonb_build_object('counts', v_agg),
         last_aggregate_at = now()
   WHERE id = NEW.interaction_id;

  -- Unconditional: see the header. A dropped trailing broadcast reads to the
  -- professor as a lost vote, and this aggregate is always the complete, freshly
  -- derived one for every response recorded so far.
  PERFORM lc_send_event(
    v_int.room_id,
    'aggregate_updated',
    jsonb_build_object('interactionId', NEW.interaction_id, 'aggregate', v_agg)
  );

  RETURN NEW;
END;
$function$;

comment on function public.lc_responses_after_insert() is
  'Recomputes an interaction''s cached counts under an advisory lock and broadcasts them. Broadcasts on EVERY response: a 500ms throttle here silently dropped the trailing update of a burst, freezing a concurrent voter''s choice at 0 on the professor''s screen (#638).';
