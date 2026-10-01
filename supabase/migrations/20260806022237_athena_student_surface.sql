-- Student Athena moves onto the Athena chat tables (athena-students.md §7/§9).
--
-- Until now the student surface wrote to `ai_conversations`/`ai_messages` — the
-- retired full-context tutor's tables — while the professor surfaces used
-- `athena_conversations`/`athena_messages`. One feature, two chat stores, and
-- the student rows sat in tables the design has scheduled for deletion.
--
-- The decision (§9, shaping 2026-07-22): reuse the Athena tables with a
-- `surface` discriminator rather than build parallel student_assistant_* tables.
-- The reason is that RLS here is already OWNER-only (user_id = auth.uid()), not
-- role-gated — so a student row is isolated by the policies that already exist,
-- and parallel tables would buy a copied RPC and copied policies for no
-- isolation gain.
--
-- Three changes, all additive except the artifact FK:
--   1. athena_conversations.surface  — 'professor' | 'student', default
--      'professor' so no professor code changes.
--   2. athena_messages.metadata      — the student surface records run rows and
--      attachment paths per message; the professor surface keeps everything in
--      `parts` and simply never writes this.
--   3. athena_artifacts.conversation_id now references athena_conversations.
--
-- Old chats are NOT migrated (§9): `ai_conversations`/`ai_messages` go dormant
-- and are dropped in a later cleanup migration.

-- ── 1. The surface discriminator ─────────────────────────────────────
alter table athena_conversations
  add column surface text not null default 'professor'
    check (surface in ('professor', 'student'));

comment on column athena_conversations.surface is
  'Which Athena surface owns this thread. RLS is owner-only regardless — this '
  'discriminates the LIST, not the authorization.';

-- Deliberately NO second index. The list query is already bound to one
-- (section_id, user_id) pair by idx_athena_conversations_list, which returns at
-- most a few dozen rows for a user in a section; `surface` is a two-value
-- filter applied on top of that, so an index on it would earn nothing and a
-- (section_id, user_id, surface, updated_at) index would force the professor's
-- surface-less list query to sort. See data-access.md — bound the read, don't
-- index a low-cardinality column behind an already-selective prefix.

-- ── 2. Per-message metadata ──────────────────────────────────────────
-- The student surface stores, per answer: the run rows the dock renders as
-- cards on a reopened thread, and (per user message) the storage PATHS of any
-- attached files. Data, never markers — a directive marker stored in message
-- TEXT would be re-parsed on every read and drive the app again each time the
-- student scrolled back through their history.
alter table athena_messages
  add column metadata jsonb not null default '{}'::jsonb;

-- ── 3. Artifacts link to the new conversation table ──────────────────
-- athena_artifacts.conversation_id recorded which chat left a study artifact on
-- the roadmap. It pointed at ai_conversations; the ids it holds belong to rows
-- that are about to be dormant, so they are cleared rather than repointed —
-- there is no correct target for them in the new table. The artifacts
-- themselves are untouched: this is a backlink to the chat, and the column is
-- already nullable ON DELETE SET NULL.
update athena_artifacts set conversation_id = null where conversation_id is not null;

alter table athena_artifacts
  drop constraint athena_artifacts_conversation_id_fkey;

alter table athena_artifacts
  add constraint athena_artifacts_conversation_id_fkey
    foreign key (conversation_id) references athena_conversations(id) on delete set null;

-- ── 4. The append RPC learns metadata ────────────────────────────────
-- Same atomic, gap-free append (per-conversation advisory lock + the UNIQUE
-- backstop); the only change is the new trailing parameter. It DEFAULTs, so the
-- professor's existing 6-argument call is unaffected.
--
-- Dropped and recreated rather than overloaded: two functions of the same name
-- would leave PostgREST resolving between them by argument names, and one of
-- them silently ignoring metadata is exactly the bug that gets shipped.
drop function if exists athena_append_message(uuid, uuid, uuid, uuid, text, jsonb);

create or replace function athena_append_message(
  p_conversation_id uuid,
  p_institution_id  uuid,
  p_section_id      uuid,
  p_user_id         uuid,
  p_role            text,
  p_parts           jsonb,
  p_metadata        jsonb default '{}'::jsonb
) returns integer
language plpgsql as $$
DECLARE
  v_order integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_conversation_id::text, 0));
  SELECT COALESCE(MAX(order_index), 0) + 1 INTO v_order
    FROM athena_messages WHERE conversation_id = p_conversation_id;
  INSERT INTO athena_messages
    (conversation_id, institution_id, section_id, user_id, role, parts, order_index, metadata)
  VALUES
    (p_conversation_id, p_institution_id, p_section_id, p_user_id, p_role, p_parts, v_order,
     COALESCE(p_metadata, '{}'::jsonb));
  RETURN v_order;
END;
$$;

-- Dropping and recreating RESETS every grant, so the new function starts with
-- Postgres's implicit GRANT EXECUTE TO PUBLIC plus Supabase's default-privilege
-- grants to anon and authenticated. Both halves have to go: revoking only the
-- client roles leaves them reaching it through PUBLIC (20260624135948 learned
-- the first half, 20260717060430 had to come back for the second).
--
-- This function is service-role-only — it is called from server code that has
-- already authenticated the caller and verified ownership of the conversation.
revoke execute on function public.athena_append_message(uuid, uuid, uuid, uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
