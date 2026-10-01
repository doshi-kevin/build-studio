-- Phase 4 hardening: distributed rate limit for drawing stroke persistence.
--
-- The original persistStrokeBatch action used an in-memory Map keyed by
-- user id to enforce 1-batch-per-second-per-user. That breaks under
-- multi-instance deployments (Cloud Run with concurrency, Vercel scale-out)
-- because a malicious client could bypass the limit by hitting a
-- different server instance.
--
-- This function uses pg_try_advisory_xact_lock to serialize batch writes
-- per (user, room). The lock is released at transaction end, so it
-- naturally enforces "one batch per server-side transaction" — which is
-- the right granularity for this rate limit.
--
-- Returns true if the caller acquired the lock and may proceed; false
-- if another batch from the same user is in flight (caller drops silently).

CREATE OR REPLACE FUNCTION lc_try_drawings_lock(p_user_id uuid, p_room_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_try_advisory_xact_lock(
    hashtext('lc_drawings:' || p_user_id::text || ':' || p_room_id::text)
  );
$$;
