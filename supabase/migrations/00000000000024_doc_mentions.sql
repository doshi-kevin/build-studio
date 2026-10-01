-- Migration: doc mentions in chat
--
-- Adds `mentioned_doc_ids UUID[]` to project_chat_messages so the chat
-- input can @-mention a project doc (canvas) alongside users and phases.
-- Renderer swaps each id for a hover-preview chip showing the doc's
-- title, last-updated time, and a short excerpt.
--
-- Same shape and rationale as the @phase mention column added in
-- migration 023: no FK array, server validates membership before
-- persisting, and a deleted doc id renders as a plain "@doc" chip
-- (no preview) instead of breaking the message render.
--
-- Created: 2026-04-15

ALTER TABLE public.project_chat_messages
  ADD COLUMN IF NOT EXISTS mentioned_doc_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.project_chat_messages.mentioned_doc_ids IS
  'UUIDs of project_docs mentioned via @doc in the message body. Server-verified to belong to the channel''s team.';
