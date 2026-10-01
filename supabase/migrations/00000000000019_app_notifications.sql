-- Migration: app_notifications + chat mentions
--
-- Introduces a generic app_notifications table (bell-menu surface) and
-- augments project_chat_messages with a mentioned_user_ids column so we can
-- render inline highlighting of @user pills AND emit notifications for each
-- mentioned team member.
--
-- Notifications in this MVP are created from the server action
-- (app/(dashboard)/student/courses/[sectionId]/projects/chat-actions.ts).
-- A future slice may add Postgres triggers for lifecycle events (phase
-- assigned, task due, etc.) — those will reuse this same table.

-- ══════════════════════════════════════════════════════════════════
-- 1. app_notifications — recipient-centric bell notifications
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.app_notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_id      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL CHECK (char_length(title) <= 300),
  body          TEXT CHECK (body IS NULL OR char_length(body) <= 1000),
  link_url      TEXT CHECK (link_url IS NULL OR char_length(link_url) <= 500),
  is_read       BOOLEAN NOT NULL DEFAULT false,
  read_at       TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_notifications IS 'Per-user in-app bell notifications. Recipient-centric; one row per delivery.';
COMMENT ON COLUMN public.app_notifications.kind IS 'Discriminator e.g. chat_mention, task_assigned, phase_assigned. No CHECK constraint so future kinds are additive.';

-- Hot path: "give me my unread notifications, newest first"
CREATE INDEX IF NOT EXISTS idx_app_notifications_recipient_created
  ON public.app_notifications(recipient_id, created_at DESC);

-- Hot path: unread count badge
CREATE INDEX IF NOT EXISTS idx_app_notifications_recipient_unread
  ON public.app_notifications(recipient_id)
  WHERE is_read = false;

-- ── RLS ──────────────────────────────────────────────────────────
ALTER TABLE public.app_notifications ENABLE ROW LEVEL SECURITY;

-- Recipients can read their own notifications.
CREATE POLICY "Recipients can read own notifications"
  ON public.app_notifications FOR SELECT
  USING (recipient_id = auth.uid());

-- Recipients can mark their own notifications as read (and only that field
-- — enforced at the server action layer; RLS allows full UPDATE but we only
-- expose a markAsRead action).
CREATE POLICY "Recipients can update own notifications"
  ON public.app_notifications FOR UPDATE
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

-- INSERT happens from the service-role admin client (server actions and
-- future triggers), so no INSERT policy is needed — admin bypasses RLS.

-- Recipients can delete their own (dismissing) — optional, nice to have.
CREATE POLICY "Recipients can delete own notifications"
  ON public.app_notifications FOR DELETE
  USING (recipient_id = auth.uid());

-- ══════════════════════════════════════════════════════════════════
-- 2. project_chat_messages.mentioned_user_ids
-- ══════════════════════════════════════════════════════════════════
-- Used for:
--   (a) Server action parses mentions, writes the ID list so the client
--       can render highlighted pills deterministically instead of
--       attempting name-matching on a free-form string.
--   (b) Notification fanout (server action reads this list, inserts one
--       app_notifications row per mentioned user).

ALTER TABLE public.project_chat_messages
  ADD COLUMN IF NOT EXISTS mentioned_user_ids UUID[] NOT NULL DEFAULT '{}'::uuid[];

COMMENT ON COLUMN public.project_chat_messages.mentioned_user_ids IS 'User IDs extracted from @mentions in content. Drives inline highlighting and notification delivery.';

-- GIN index for "does this message mention user X?" lookups.
CREATE INDEX IF NOT EXISTS idx_project_chat_messages_mentioned
  ON public.project_chat_messages USING GIN (mentioned_user_ids);

-- ══════════════════════════════════════════════════════════════════
-- 3. Realtime publication
-- ══════════════════════════════════════════════════════════════════
-- Add app_notifications to the realtime publication so the bell UI gets
-- live updates without polling.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.app_notifications;
    EXCEPTION
      WHEN duplicate_object THEN NULL; -- Already in publication; ignore.
    END;
  END IF;
END $$;
