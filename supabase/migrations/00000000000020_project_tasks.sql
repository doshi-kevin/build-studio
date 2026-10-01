-- Migration: chat system messages
--
-- Extends project_chat_messages with a `kind` discriminator plus
-- structured system-event columns so we can post WhatsApp-style
-- inline system messages into the chat feed.
--
-- System messages (kind='system') are emitted by server actions using
-- the service-role admin client (bypasses RLS) and by a Postgres
-- trigger on project_members INSERT for the one lifecycle event
-- (member joined) where no single actor owns the write.
--
-- Created: 2026-04-15
-- Note: an earlier draft of this migration also created a
-- `project_tasks` table for a chat-to-task feature; that feature was
-- removed in migration 00000000000022 and its definitions were
-- pruned from this file so fresh setups don't recreate the table.

-- ══════════════════════════════════════════════════════════════════
-- project_chat_messages — system message columns
-- ══════════════════════════════════════════════════════════════════
-- System messages (kind='system') are authored by the platform, not a
-- user: author_id becomes nullable. A `kind` discriminator lets
-- MessageBubble branch on render time. `system_event` names the
-- canonical event (phase_assigned, phase_status_changed, doc_created,
-- member_joined). `system_payload` holds the structured references the
-- renderer needs to resolve names and build inline links.

ALTER TABLE public.project_chat_messages
  ALTER COLUMN author_id DROP NOT NULL;

ALTER TABLE public.project_chat_messages
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user'
    CHECK (kind IN ('user','system'));

ALTER TABLE public.project_chat_messages
  ADD COLUMN IF NOT EXISTS system_event TEXT;

ALTER TABLE public.project_chat_messages
  ADD COLUMN IF NOT EXISTS system_payload JSONB;

-- User messages must always have an author; system messages always do not.
ALTER TABLE public.project_chat_messages
  ADD CONSTRAINT project_chat_messages_author_kind_ck
  CHECK (
    (kind = 'user'   AND author_id IS NOT NULL AND system_event IS NULL)
    OR
    (kind = 'system' AND author_id IS NULL     AND system_event IS NOT NULL)
  );

COMMENT ON COLUMN public.project_chat_messages.kind IS 'Message kind discriminator. "user" = normal chat; "system" = inline WhatsApp-style event.';
COMMENT ON COLUMN public.project_chat_messages.system_event IS 'Canonical system event name, e.g. phase_assigned, phase_status_changed, doc_created, member_joined.';
COMMENT ON COLUMN public.project_chat_messages.system_payload IS 'Structured payload with actor_id, entity refs, and old/new state for the renderer to resolve.';

-- Hot path for "recent system messages in a channel"
CREATE INDEX IF NOT EXISTS idx_project_chat_messages_channel_kind_created
  ON public.project_chat_messages(channel_id, kind, created_at DESC);

-- Adjust the read policy so system messages (which have NULL author_id)
-- are still readable by team members. The existing policy checks team
-- membership via the channel, so it already covers this — no change
-- needed. We do, however, need the INSERT policy to remain author-
-- scoped for user messages only. The existing policy requires
-- `author_id = auth.uid()`, which naturally blocks client-side inserts
-- of system messages (author_id is NULL). System messages are written
-- exclusively by the admin client, which bypasses RLS.

-- ══════════════════════════════════════════════════════════════════
-- Trigger: emit "member joined" system message
-- ══════════════════════════════════════════════════════════════════
-- project_members INSERT → post a system message into the team's
-- default channel announcing the new member. This is the one event
-- where no server action owns the write (invite acceptance fires from
-- team-invitations-actions via adminDb.insert), so a trigger is the
-- right primitive. All other system-event emissions stay in server
-- actions so the actor is rich.

CREATE OR REPLACE FUNCTION public.emit_member_joined_system_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_default_channel_id UUID;
  v_payload JSONB;
BEGIN
  -- Look up the team's default channel. If it doesn't exist yet
  -- (team was created before a channel), silently skip — the
  -- member-joined copy is nice-to-have, not load-bearing.
  SELECT id INTO v_default_channel_id
  FROM public.project_chat_channels
  WHERE team_id = NEW.team_id AND is_default = true
  LIMIT 1;

  IF v_default_channel_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_payload := jsonb_build_object(
    'member_id', NEW.user_id,
    'team_id',   NEW.team_id,
    'role',      NEW.role
  );

  INSERT INTO public.project_chat_messages (
    channel_id,
    author_id,
    content,
    kind,
    system_event,
    system_payload
  ) VALUES (
    v_default_channel_id,
    NULL,
    '',
    'system',
    'member_joined',
    v_payload
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_members_emit_join ON public.project_members;
CREATE TRIGGER trg_project_members_emit_join
  AFTER INSERT ON public.project_members
  FOR EACH ROW
  EXECUTE FUNCTION public.emit_member_joined_system_message();

-- ══════════════════════════════════════════════════════════════════
-- Realtime publication
-- ══════════════════════════════════════════════════════════════════
-- project_chat_messages is already in supabase_realtime (added by the
-- earlier project-chat migration), so system messages flow through
-- the same channel as user messages with no further setup.
