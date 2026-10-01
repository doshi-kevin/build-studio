-- Drop the project_tasks table.
--
-- The chat-to-task feature it backed was removed by product decision;
-- the table has no other surface area in the app. The chat system-
-- message columns added alongside it in 00000000000020 (kind,
-- system_event, system_payload) and the member_joined trigger remain
-- in use for non-task events and stay in place.
--
-- Created: 2026-04-15

DROP TABLE IF EXISTS public.project_tasks CASCADE;
