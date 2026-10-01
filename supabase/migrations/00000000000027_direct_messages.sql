-- Migration: Direct Messages (DMs) — global 1-to-1 chat between any two
-- users. One thread per unordered user pair. Reused from both course
-- discussions ("People" panel in the section sidebar) and project team
-- workspaces ("People" panel in the team sidebar) — whichever surface
-- you open, the thread is the same row.
--
-- Path layout for DM attachments:
--   `dms/{channelId}/{yyyy}/{mm}/{uuid}.{ext}`
--
-- Bucket: reused `chat-attachments` (private, 25 MB, PDF + images).
-- RLS on storage.objects is extended here to allow DM channel
-- participants to read/write when the first path segment is 'dms'.
--
-- Created: 2026-04-15

-- ═══════════════════════════════════════════════════════════════
-- 1. TABLES
-- ═══════════════════════════════════════════════════════════════

-- dm_channels — one row per unordered user pair. `user_a_id` is always
-- the lower UUID so the UNIQUE constraint actually matches any pair
-- order at insert time. Use the helper `public.dm_channel_for_pair`
-- below to look up / create without re-implementing the sort on callers.
CREATE TABLE IF NOT EXISTS public.dm_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_b_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dm_channels_pair_sorted CHECK (user_a_id < user_b_id),
  CONSTRAINT dm_channels_pair_unique UNIQUE (user_a_id, user_b_id)
);

COMMENT ON TABLE public.dm_channels IS
  '1-to-1 DM thread between two users. Row key (user_a_id, user_b_id) is stored in sorted-UUID order so unordered pair lookup is a single constraint match.';

CREATE TABLE IF NOT EXISTS public.dm_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES public.dm_channels(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  attachment_url TEXT,
  attachment_path TEXT,
  attachment_name TEXT,
  attachment_size INTEGER,
  attachment_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dm_messages IS
  'Messages inside a DM channel. Mirrors discussion_messages shape so the same client bubble + hook patterns can render either.';

-- ═══════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════

-- Look up channels by either participant.
CREATE INDEX IF NOT EXISTS idx_dm_channels_user_a ON public.dm_channels(user_a_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_channels_user_b ON public.dm_channels(user_b_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_dm_messages_channel ON public.dm_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_dm_messages_channel_created
  ON public.dm_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_messages_author ON public.dm_messages(author_id);

-- ═══════════════════════════════════════════════════════════════
-- 3. HELPERS
-- ═══════════════════════════════════════════════════════════════

-- Participant check — used by DM RLS and by storage.objects RLS (see §6)
-- Keep it SECURITY DEFINER + STABLE so Postgres caches the result within
-- a single statement; otherwise every message read would re-evaluate it.
CREATE OR REPLACE FUNCTION public.is_dm_participant(p_channel_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.dm_channels
    WHERE id = p_channel_id
      AND (user_a_id = p_user_id OR user_b_id = p_user_id)
  );
$$;

-- Touch `updated_at` + `last_message_at` when a new message lands. Kept
-- as a trigger (not an app-layer write) so optimistic clients never fall
-- out of sync with the server-assigned timestamp used for ordering.
CREATE OR REPLACE FUNCTION public.touch_dm_channel_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.dm_channels
  SET last_message_at = NEW.created_at,
      updated_at = now()
  WHERE id = NEW.channel_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dm_messages_touch_channel ON public.dm_messages;
CREATE TRIGGER trg_dm_messages_touch_channel
  AFTER INSERT ON public.dm_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_dm_channel_on_message();

-- ═══════════════════════════════════════════════════════════════
-- 4. ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.dm_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dm_messages ENABLE ROW LEVEL SECURITY;

-- Channels — only participants can see the row. The SELECT policy also
-- gates list-my-DMs queries because the client-side filter (`eq(user_a_id,
-- me).or(user_b_id, me)`) would otherwise be a denial-of-service read of
-- the whole table for authenticated users.
DROP POLICY IF EXISTS "DM participants can read channel" ON public.dm_channels;
CREATE POLICY "DM participants can read channel"
  ON public.dm_channels FOR SELECT
  USING (user_a_id = auth.uid() OR user_b_id = auth.uid());

-- Inserts/updates for channels are driven through the server action
-- (using the service-role admin client), never by the browser — so we
-- don't grant INSERT/UPDATE on the anon role at all. The service role
-- bypasses RLS, which is the correct shape here.

-- Messages — read if you're a participant of the parent channel.
DROP POLICY IF EXISTS "DM messages: participants can read" ON public.dm_messages;
CREATE POLICY "DM messages: participants can read"
  ON public.dm_messages FOR SELECT
  USING (public.is_dm_participant(channel_id, auth.uid()));

-- Messages — write as yourself, and only if you're a participant of the
-- parent channel. Belt-and-braces with the server action check.
DROP POLICY IF EXISTS "DM messages: participants can write" ON public.dm_messages;
CREATE POLICY "DM messages: participants can write"
  ON public.dm_messages FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND public.is_dm_participant(channel_id, auth.uid())
  );

-- ═══════════════════════════════════════════════════════════════
-- 5. REALTIME
-- ═══════════════════════════════════════════════════════════════

-- Add to publication if it's not already a member. Unlike ADD TABLE,
-- there's no IF NOT EXISTS form, so wrap in a DO block that checks
-- pg_publication_tables first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'dm_channels'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.dm_channels';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'dm_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.dm_messages';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 6. STORAGE RLS — extend chat-attachments bucket to allow DM paths
-- ═══════════════════════════════════════════════════════════════
--
-- Existing policies only permit team members on paths where the first
-- segment is a team UUID. DM attachments use `dms/{channelId}/...`, so
-- the first segment is the literal 'dms' and the channel id is the
-- second segment. Replace the read + insert policies with an OR between
-- the two layouts.

DROP POLICY IF EXISTS "Team members can read chat attachments" ON storage.objects;
DROP POLICY IF EXISTS "Team or DM participants can read chat attachments" ON storage.objects;
CREATE POLICY "Chat attachments: read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'chat-attachments'
    AND (
      -- Team layout: {teamId}/{channelId}/...
      (
        (storage.foldername(name))[1] !~ '^[a-zA-Z]+$'
        AND public.is_team_member(
          (storage.foldername(name))[1]::uuid,
          auth.uid()
        )
      )
      OR
      -- DM layout: dms/{channelId}/...
      (
        (storage.foldername(name))[1] = 'dms'
        AND public.is_dm_participant(
          (storage.foldername(name))[2]::uuid,
          auth.uid()
        )
      )
      OR
      -- Course discussions layout: discussions/{sectionId}/{channelId}/...
      (
        (storage.foldername(name))[1] = 'discussions'
        AND public.is_enrolled_or_professor(
          (storage.foldername(name))[2]::uuid,
          auth.uid()
        )
      )
    )
  );

DROP POLICY IF EXISTS "Team members can upload chat attachments" ON storage.objects;
DROP POLICY IF EXISTS "Team or DM participants can upload chat attachments" ON storage.objects;
CREATE POLICY "Chat attachments: upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'chat-attachments'
    AND owner = auth.uid()
    AND (
      (
        (storage.foldername(name))[1] !~ '^[a-zA-Z]+$'
        AND public.is_team_member(
          (storage.foldername(name))[1]::uuid,
          auth.uid()
        )
      )
      OR
      (
        (storage.foldername(name))[1] = 'dms'
        AND public.is_dm_participant(
          (storage.foldername(name))[2]::uuid,
          auth.uid()
        )
      )
      OR
      (
        (storage.foldername(name))[1] = 'discussions'
        AND public.is_enrolled_or_professor(
          (storage.foldername(name))[2]::uuid,
          auth.uid()
        )
      )
    )
  );

-- DELETE policy from migration 025 still applies (author-owned deletes).
