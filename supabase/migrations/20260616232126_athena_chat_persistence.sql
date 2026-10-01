-- Athena multi-chat persistence — saved, switchable professor↔assistant
-- conversations (ChatGPT/Claude-style), replacing the single per-section
-- localStorage thread. See docs/designs/athena/athena-chat-persistence-design.md.
--
-- Two tables:
--   athena_conversations — one row per chat (per staff user, per section).
--   athena_messages      — the full UIMessage[] turn-by-turn, parts in JSONB
--                          (text / reasoning / tool & draft calls / sources).
--
-- Tenant scoping: every row carries institution_id + section_id + user_id,
-- all written from VERIFIED server context (never the client). These tables
-- are written AND read exclusively by the service role (the /api route and the
-- co-located server actions, which authorize via verifySectionAccess first).
-- So — exactly like lc_attendance / lc_session_reports (migration 20260612…) —
-- RLS is defense-in-depth: a SELECT policy scoped to the owner, and NO
-- INSERT/UPDATE/DELETE policies (service-role writes bypass RLS by design).
--
-- Each staff member's Athena chats are PRIVATE to them (a TA must not read the
-- professor's drafts-in-progress), so the owner scope is user_id = auth.uid().
-- user_id is denormalized onto athena_messages too, so both policies authorize
-- the row LOCALLY with no cross-table JOIN (avoids the RLS planner cliff).

-- ── Conversations ────────────────────────────────────────────────────
CREATE TABLE athena_conversations (
  id                    uuid PRIMARY KEY,                -- client-generated (= useChat chat id); upserted ON CONFLICT DO NOTHING
  institution_id        uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  section_id            uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title                 text,                            -- null until auto-title resolves
  title_locked          boolean NOT NULL DEFAULT false,  -- true once the professor renames it manually
  summary               text,                            -- reserved for Stage 2b rolling-summary compaction (not used in v1)
  summary_through_order integer,                         -- reserved: order_index up to which `summary` covers
  is_archived           boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Sidebar query: this user's non-archived chats in a section, newest activity first.
CREATE INDEX idx_athena_conversations_list
  ON athena_conversations (section_id, user_id, updated_at DESC)
  WHERE NOT is_archived;

ALTER TABLE athena_conversations ENABLE ROW LEVEL SECURITY;

-- Owner-only read (defense-in-depth; real reads go through service-role actions).
CREATE POLICY "owner reads own athena conversations"
  ON athena_conversations FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
-- No INSERT/UPDATE/DELETE policies: all writes happen via the service role.

-- ── Messages ─────────────────────────────────────────────────────────
CREATE TABLE athena_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES athena_conversations(id) ON DELETE CASCADE,
  institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,    -- denormalized for local authz / analytics
  section_id      uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE, -- denormalized
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,        -- denormalized owner → JOIN-free RLS
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  parts           jsonb NOT NULL,                  -- the full UIMessage parts array (everything: text, reasoning, tool/draft, sources)
  order_index     integer NOT NULL,                -- explicit turn order; never trust created_at alone
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Atomic ordering: the route inserts with COALESCE(MAX(order_index),0)+1;
  -- this constraint makes a concurrent duplicate index fail loudly instead of
  -- silently corrupting turn order.
  UNIQUE (conversation_id, order_index)
);

CREATE INDEX idx_athena_messages_conversation
  ON athena_messages (conversation_id, order_index);

ALTER TABLE athena_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner reads own athena messages"
  ON athena_messages FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
-- No INSERT/UPDATE/DELETE policies: all writes happen via the service role.

-- Atomic, gap-free message append. A per-conversation transactional advisory
-- lock serializes concurrent appends to the SAME chat so two turns can't claim
-- the same order_index (the UNIQUE constraint is the backstop). Parameterized —
-- no string-built SQL. Called only via the service role from the API route.
CREATE OR REPLACE FUNCTION athena_append_message(
  p_conversation_id uuid,
  p_institution_id  uuid,
  p_section_id      uuid,
  p_user_id         uuid,
  p_role            text,
  p_parts           jsonb
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_order integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_conversation_id::text, 0));
  SELECT COALESCE(MAX(order_index), 0) + 1 INTO v_order
    FROM athena_messages WHERE conversation_id = p_conversation_id;
  INSERT INTO athena_messages
    (conversation_id, institution_id, section_id, user_id, role, parts, order_index)
  VALUES
    (p_conversation_id, p_institution_id, p_section_id, p_user_id, p_role, p_parts, v_order);
  RETURN v_order;
END;
$$;

-- Keep updated_at fresh whenever a conversation row is touched (rename/archive).
CREATE OR REPLACE FUNCTION set_athena_conversation_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_athena_conversations_updated_at
  BEFORE UPDATE ON athena_conversations
  FOR EACH ROW EXECUTE FUNCTION set_athena_conversation_updated_at();
