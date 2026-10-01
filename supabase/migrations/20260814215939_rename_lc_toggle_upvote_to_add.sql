-- #642 part 1 — lc_toggle_upvote never toggled. It returns early when the user has
-- already upvoted, so the "remove" half of the name does not exist.
--
-- The product behaviour is deliberate, not missing: QuestionList disables the button
-- once `hasUpvoted`, and its handler early-returns too, so no affordance ever offered
-- an undo. Renaming is therefore the honest fix rather than implementing removal —
-- adding an un-vote path would be a product change nobody asked for, while a function
-- called "toggle" invites the next reader to assume the branch is there and simply
-- broken.
--
-- The add half is already correct and concurrency-safe: SELECT … FOR UPDATE plus a
-- membership check on upvotedBy, which is why two simultaneous upvotes landed on
-- exactly 2 under real concurrency.
--
-- Deploy safety: the old name is KEPT as a thin delegating wrapper rather than
-- dropped. Between this migration and the new build reaching every instance, running
-- app code still calls lc_toggle_upvote; dropping it would 404 those calls for the
-- length of the rollout. The wrapper can be dropped in a later release once nothing
-- references it.

create or replace function public.lc_add_upvote(p_interaction_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_payload    jsonb;
  v_upvoted_by jsonb;
  v_already    boolean;
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

  -- Idempotent by design: a second upvote from the same user is a no-op, NOT a
  -- removal. See the header.
  IF v_already THEN
    RETURN v_payload;
  END IF;

  v_payload := jsonb_set(v_payload, '{upvotes}', to_jsonb(COALESCE((v_payload->>'upvotes')::int, 0) + 1));
  v_payload := jsonb_set(v_payload, '{upvotedBy}', v_upvoted_by || to_jsonb(p_user_id::text));

  UPDATE lc_interactions SET payload = v_payload WHERE id = p_interaction_id;

  RETURN v_payload;
END;
$function$;

comment on function public.lc_add_upvote(uuid, uuid) is
  'Adds one upvote to a question, idempotent per user. Deliberately has NO removal branch — the UI offers no un-vote. Replaces the misleadingly named lc_toggle_upvote (#642).';

-- Backwards-compatible shim for in-flight app instances. Delegates; adds nothing.
create or replace function public.lc_toggle_upvote(p_interaction_id uuid, p_user_id uuid)
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
  SELECT public.lc_add_upvote(p_interaction_id, p_user_id);
$function$;

comment on function public.lc_toggle_upvote(uuid, uuid) is
  'DEPRECATED shim — never toggled; delegates to lc_add_upvote. Kept only so app code mid-rollout keeps working. Drop once no caller references it (#642).';

-- Server-only RPCs: the client roles must not reach these directly.
revoke execute on function public.lc_add_upvote(uuid, uuid) from anon, authenticated;
revoke execute on function public.lc_toggle_upvote(uuid, uuid) from anon, authenticated;
