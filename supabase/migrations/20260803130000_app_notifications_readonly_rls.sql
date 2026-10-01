-- Close a client write-hole on app_notifications.
--
-- The app writes this table ONLY via the admin client (notifications-actions.ts — mark-read,
-- dismiss, and clear-all all run server-side, service_role bypassing RLS). But the table
-- shipped a FOR UPDATE and a FOR DELETE policy scoped only to `recipient_id = auth.uid()`.
-- Supabase grants DML to `authenticated` by default, so a student could, via a direct
-- PostgREST call with the anon key:
--   * PATCH any column on their own rows — e.g. clear `dismissed_at` to un-dismiss, or
--     overwrite title/body/is_read — and
--   * DELETE their rows outright,
-- hard-wiping the notification history the soft-delete design was built to preserve.
--
-- Fix: drop both write policies, leaving SELECT-only for the recipient — mirroring feed_items,
-- which is correctly read-only for the client. No app behavior changes (all writes are
-- admin-client). See .claude/rules/security-migrations.md ("FOR ALL is a write hole").

DROP POLICY IF EXISTS "Recipients can update own notifications" ON public.app_notifications;
DROP POLICY IF EXISTS "Recipients can delete own notifications" ON public.app_notifications;
