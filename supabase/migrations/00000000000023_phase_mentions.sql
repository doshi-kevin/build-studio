-- Migration: phase mentions in chat
--
-- Adds `mentioned_phase_ids UUID[]` to project_chat_messages so the
-- chat input can @-mention a project phase (in addition to the existing
-- user mentions). The renderer turns each id into a hover-preview chip
-- that surfaces the phase's items on hover.
--
-- We do NOT enforce a foreign-key array — phases are scoped to the
-- team that owns the channel, the server action validates membership
-- before persisting, and a deleted phase id simply renders as a plain
-- "@phase" chip (no preview) instead of breaking the message render.
--
-- Created: 2026-04-15

ALTER TABLE public.project_chat_messages
  ADD COLUMN IF NOT EXISTS mentioned_phase_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.project_chat_messages.mentioned_phase_ids IS
  'UUIDs of project_phases mentioned via @phase in the message body. Server-verified to belong to the channel''s team.';
