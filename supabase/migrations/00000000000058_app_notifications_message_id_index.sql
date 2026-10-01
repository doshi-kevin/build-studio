-- Migration: app_notifications partial expression index on metadata->>'message_id'
--
-- Issue #107 — when a chat message is soft-deleted, the corresponding
-- app_notifications row(s) are cascade-deleted by the server action
-- (deleteDmMessage / deleteMessage for team chat). That cleanup filters
-- on `metadata->>'message_id' = <messageId>`. Add a partial expression
-- index so the DELETE remains cheap as the notifications table grows.
--
-- Partial because notifications of kinds that aren't tied to a message
-- (future task_assigned, phase_assigned, etc.) won't carry a message_id
-- key, and indexing only the rows that do keeps the index compact.

CREATE INDEX IF NOT EXISTS idx_app_notifications_message_id
  ON public.app_notifications ((metadata->>'message_id'))
  WHERE metadata ? 'message_id';

COMMENT ON INDEX public.idx_app_notifications_message_id IS
  'Speeds up cascade-delete of notifications when a chat message is soft-deleted (issue #107).';
