-- Phase 1: lc_rooms transport swap
--
-- The slide-sync feature now flows through realtime.send() called from
-- the lc_rooms_after_update trigger (added in migration 34), not through
-- postgres_changes. Pull lc_rooms out of the supabase_realtime
-- publication so the WAL decoder doesn't waste cycles on every update.
--
-- IMPORTANT: only apply this migration AFTER the new code (Phase 1) is
-- deployed. Until then, the production app uses the old useRoom hook
-- which subscribes via postgres_changes — applying this migration first
-- would silently break slide sync for live users.

ALTER PUBLICATION supabase_realtime DROP TABLE lc_rooms;
