-- Persist a notification history. The "View all notifications" page reads the same
-- feed_items / app_notifications rows the bell does, so the bell's "Clear all" / dismiss —
-- which HARD-DELETED those rows — wiped the history too. Switch the bell to a soft-delete:
-- dismissing/clearing sets dismissed_at (the bell filters these out), while the history page
-- keeps showing the row. Additive + nullable, so existing rows and behavior are unaffected.

ALTER TABLE public.feed_items ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;
ALTER TABLE public.app_notifications ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

-- The bell's hot query is "this recipient's NOT-dismissed rows, newest first". Rows are no
-- longer deleted (history accumulates), so a partial index over the not-dismissed set keeps
-- that query scanning only the active rows.
CREATE INDEX IF NOT EXISTS idx_feed_items_recipient_active
  ON public.feed_items(recipient_id, created_at DESC)
  WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_app_notifications_recipient_active
  ON public.app_notifications(recipient_id, created_at DESC)
  WHERE dismissed_at IS NULL;
