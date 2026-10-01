-- Migration: soft-delete for chat messages. Adds `deleted_at` +
-- `deleted_by_id` to the three message tables (DMs, course discussions,
-- team project chat) so a user can retract a message without losing the
-- row or breaking thread ordering. The UI renders soft-deleted rows as a
-- grey "This message was deleted" tombstone.
--
-- Why soft-delete over hard-delete:
--   - Preserves message order + reply context for bystanders.
--   - Lets realtime subscribers pick up the change via UPDATE events
--     (hard DELETEs need a separate postgres_changes filter).
--   - Keeps audit trail of who cleared it (author vs. staff moderation).
--
-- Created: 2026-04-15

ALTER TABLE public.dm_messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.discussion_messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.project_chat_messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.dm_messages.deleted_at IS
  'Soft-delete timestamp. When non-null, the client shows a tombstone and hides the original content + attachment.';
COMMENT ON COLUMN public.discussion_messages.deleted_at IS
  'Soft-delete timestamp. When non-null, the client shows a tombstone and hides the original content + attachment.';
COMMENT ON COLUMN public.project_chat_messages.deleted_at IS
  'Soft-delete timestamp. When non-null, the client shows a tombstone and hides the original content + attachment.';
