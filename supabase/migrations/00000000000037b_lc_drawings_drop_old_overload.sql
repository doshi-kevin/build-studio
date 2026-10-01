-- Phase 4 fix: drop the old 4-arg lc_send_event so 3-arg trigger calls
-- (which rely on default values) aren't ambiguous between the two overloads.
--
-- Migration 37 (lc_drawings) added a 5-arg `lc_send_event(p_room_id, p_event_type,
-- p_data, p_persist DEFAULT true, p_broadcast DEFAULT true)`. Postgres allows
-- function overloading by arity, so the old 4-arg signature from migration 34
-- still existed alongside it. Trigger callers that omit defaults and pass only
-- 3 args become ambiguous (both signatures match). Dropping the 4-arg overload
-- forces all callers to resolve to the 5-arg version.
--
-- Already applied to prod as a hotfix between migrations 37 and 38; this file
-- exists so fresh dev DBs end up in the same state via `supabase db reset`.

DROP FUNCTION IF EXISTS lc_send_event(uuid, text, jsonb, boolean);
