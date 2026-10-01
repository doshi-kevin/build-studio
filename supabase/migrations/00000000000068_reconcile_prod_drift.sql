-- Reconcile schema drift: add objects that exist in PRODUCTION but were never
-- captured as committed migrations, so a fresh local `supabase db reset` produces
-- a schema that matches prod.
--
-- Background: an audit (local-from-migrations vs. prod) found 5 objects and 8
-- columns present in prod but absent from the migration set. They were applied
-- to prod out-of-band (dashboard / MCP apply_migration / loose scripts) and the
-- corresponding migration files were lost in an earlier renumbering, or never
-- created. This migration is the single source-of-truth catch-up.
--
-- IDEMPOTENT BY DESIGN: every statement uses IF NOT EXISTS / CREATE OR REPLACE /
-- DROP POLICY IF EXISTS, so applying this to PROD (which already has everything)
-- is a safe no-op. On a fresh local DB it creates the missing objects.
--
-- All DDL (column types, defaults, constraints, indexes, RLS policies) was pulled
-- VERBATIM from prod via the introspection catalog — not hand-invented. In
-- particular the reaction-table SELECT policies are intentionally permissive
-- (USING true) because that is exactly prod's current state.
--
-- NOT handled here (needs a human decision — see PR description):
--   • department_faculty.role  and  events.created_at  exist LOCALLY but NOT in
--     prod (reverse drift). Reconciling those means DROPPING columns, which is
--     destructive and could break app code — deliberately left out.
--   • SECURITY FLAG: the reaction tables and invite_redirects use permissive
--     SELECT policies (USING true) replicated from prod. This is broader than the
--     CLAUDE.md "never return rows to anon/authenticated unconditionally" rule.
--     Replicated to MATCH prod, not endorsed — flagged for a separate security pass.

BEGIN;

-- ── 1. invite_redirects ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invite_redirects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_id text NOT NULL UNIQUE,
  action_link text NOT NULL,
  purpose text NOT NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_invite_redirects_short_id ON public.invite_redirects (short_id);
CREATE INDEX IF NOT EXISTS idx_invite_redirects_created_by ON public.invite_redirects (created_by);
CREATE INDEX IF NOT EXISTS idx_invite_redirects_expires_at ON public.invite_redirects (expires_at);
ALTER TABLE public.invite_redirects ENABLE ROW LEVEL SECURITY;

-- ── 2. dm_read_cursors ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.dm_read_cursors (
  channel_id uuid NOT NULL REFERENCES public.dm_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_dm_read_cursors_user ON public.dm_read_cursors (user_id);
ALTER TABLE public.dm_read_cursors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own cursors" ON public.dm_read_cursors;
CREATE POLICY "Users can read own cursors" ON public.dm_read_cursors
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can upsert own cursors" ON public.dm_read_cursors;
CREATE POLICY "Users can upsert own cursors" ON public.dm_read_cursors
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can update own cursors" ON public.dm_read_cursors;
CREATE POLICY "Users can update own cursors" ON public.dm_read_cursors
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ── 3. discussion_message_reactions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.discussion_message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.discussion_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (char_length(emoji) >= 1 AND char_length(emoji) <= 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_disc_msg_reactions_message ON public.discussion_message_reactions (message_id);
CREATE INDEX IF NOT EXISTS idx_disc_msg_reactions_user ON public.discussion_message_reactions (user_id);
ALTER TABLE public.discussion_message_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read reactions in their channels" ON public.discussion_message_reactions;
CREATE POLICY "Anyone can read reactions in their channels" ON public.discussion_message_reactions
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can insert own reactions" ON public.discussion_message_reactions;
CREATE POLICY "Users can insert own reactions" ON public.discussion_message_reactions
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can delete own reactions" ON public.discussion_message_reactions;
CREATE POLICY "Users can delete own reactions" ON public.discussion_message_reactions
  FOR DELETE USING (user_id = auth.uid());

-- ── 4. project_chat_message_reactions ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_chat_message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.project_chat_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (char_length(emoji) >= 1 AND char_length(emoji) <= 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_proj_msg_reactions_message ON public.project_chat_message_reactions (message_id);
CREATE INDEX IF NOT EXISTS idx_proj_msg_reactions_user ON public.project_chat_message_reactions (user_id);
ALTER TABLE public.project_chat_message_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read reactions in their channels" ON public.project_chat_message_reactions;
CREATE POLICY "Anyone can read reactions in their channels" ON public.project_chat_message_reactions
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can insert own reactions" ON public.project_chat_message_reactions;
CREATE POLICY "Users can insert own reactions" ON public.project_chat_message_reactions
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can delete own reactions" ON public.project_chat_message_reactions;
CREATE POLICY "Users can delete own reactions" ON public.project_chat_message_reactions
  FOR DELETE USING (user_id = auth.uid());

-- ── 5. institutions_with_counts (view) ─────────────────────────────────────
CREATE OR REPLACE VIEW public.institutions_with_counts AS
  SELECT i.id, i.name, i.slug, i.status, i.created_at, i.updated_at,
         count(p.id) AS total_users,
         count(p.id) FILTER (WHERE p.role = 'institution_admin'::text) AS admin_count
  FROM public.institutions i
  LEFT JOIN public.profiles p ON p.institution_id = i.id
  GROUP BY i.id;

-- ── 6. Missing columns on existing tables (exact prod types/defaults) ──────
ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS scheduled_publish_at timestamptz;

ALTER TABLE public.quiz_questions
  ADD COLUMN IF NOT EXISTS code_snippet jsonb,
  ADD COLUMN IF NOT EXISTS image_path text;

ALTER TABLE public.quiz_answers
  ADD COLUMN IF NOT EXISTS override_points numeric,
  ADD COLUMN IF NOT EXISTS override_reason text;

ALTER TABLE public.quiz_proctoring_logs
  ADD COLUMN IF NOT EXISTS keystroke_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.project_teams
  ADD COLUMN IF NOT EXISTS planning_doc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS submission jsonb;

ALTER TABLE public.project_phases
  ADD COLUMN IF NOT EXISTS assigned_to jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
