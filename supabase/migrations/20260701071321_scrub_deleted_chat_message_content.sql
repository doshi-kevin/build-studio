-- One-time backfill: scrub the retained body/attachments of chat messages that
-- were soft-deleted before deleteMessage() started clearing them.
--
-- Previously deleteMessage() set only deleted_at/deleted_by_id, leaving content
-- and attachment_* intact — so a "deleted" message was still recoverable by any
-- teammate via the REST payload. The action now scrubs these on delete; this
-- backfills rows deleted under the old behavior. deleted_at/deleted_by_id are
-- kept for the tombstone + moderation trail. The migration runner wraps this
-- in a single implicit transaction, so SET LOCAL scopes correctly.
SET LOCAL lock_timeout = '3s';

UPDATE public.project_chat_messages
SET content = '',
    attachment_url = NULL,
    attachment_path = NULL,
    attachment_name = NULL,
    attachment_size = NULL,
    attachment_type = NULL
WHERE deleted_at IS NOT NULL
  AND (content <> '' OR attachment_url IS NOT NULL);
