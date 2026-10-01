-- Bug-fix migration for the unified Live Classroom interactions model.
--
-- 1. Atomic upvote toggle: replaces the JS read-modify-write on
--    payload.upvotedBy with a FOR UPDATE + single-statement update
--    inside plpgsql, eliminating the race condition when multiple
--    students upvote the same question concurrently.
--
-- 2. Aggregate trigger on UPDATE: the existing trg_lc_responses_after_insert
--    only fires AFTER INSERT.  When a student changes their answer the upsert
--    performs an UPDATE, so aggregates go stale.  Adding an AFTER UPDATE
--    trigger that calls the same lc_responses_after_insert() function fixes
--    this.

-- ── 1. Atomic upvote RPC ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION lc_toggle_upvote(
  p_interaction_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_payload jsonb;
  v_upvoted_by jsonb;
  v_already boolean;
BEGIN
  SELECT payload INTO v_payload
  FROM lc_interactions
  WHERE id = p_interaction_id
  FOR UPDATE;

  IF v_payload IS NULL THEN
    RETURN NULL;
  END IF;

  v_upvoted_by := COALESCE(v_payload->'upvotedBy', '[]'::jsonb);
  v_already := v_upvoted_by @> to_jsonb(p_user_id::text);

  IF v_already THEN
    RETURN v_payload;
  END IF;

  v_payload := jsonb_set(v_payload, '{upvotes}', to_jsonb(COALESCE((v_payload->>'upvotes')::int, 0) + 1));
  v_payload := jsonb_set(v_payload, '{upvotedBy}', v_upvoted_by || to_jsonb(p_user_id::text));

  UPDATE lc_interactions SET payload = v_payload WHERE id = p_interaction_id;

  RETURN v_payload;
END;
$$;

REVOKE EXECUTE ON FUNCTION lc_toggle_upvote FROM public, authenticated, anon;

-- ── 2. Aggregate trigger on UPDATE ──────────────────────────────────────

DROP TRIGGER IF EXISTS trg_lc_responses_after_update ON lc_responses;
CREATE TRIGGER trg_lc_responses_after_update
  AFTER UPDATE ON lc_responses
  FOR EACH ROW
  EXECUTE FUNCTION lc_responses_after_insert();
