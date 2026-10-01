-- Take the write grants on user_memory away from `authenticated`.
--
-- Supabase grants every role INSERT, UPDATE, DELETE, TRUNCATE and REFERENCES on
-- a new table by default. `user_memory` has row-level security on and exactly
-- one policy, an owner-only SELECT, so today those grants are inert: with no
-- INSERT policy, row-level security refuses the write.
--
-- Two reasons not to leave it there.
--
-- The first is that "inert" depends on a policy that does not exist. Anyone who
-- later adds a permissive write policy — the obvious thing to do if you want a
-- user to edit their own row from the browser — turns these grants into a write
-- path straight into that user's own system prompt. Nothing about the table
-- announces that it is a prompt store rather than ordinary user data.
--
-- The second is TRUNCATE, which row-level security does not cover at all. It is
-- a table-level privilege and no policy can hold it back.
--
-- Nothing in the application loses anything. Every read and write of this table
-- goes through the service-role admin client: lib/memory/preferences.ts for the
-- writes, and the two preference panes for the reads and deletes. SELECT stays
-- so the owner-read policy still means something.

revoke insert, update, delete, truncate, references on public.user_memory from authenticated;
revoke insert, update, delete, truncate, references on public.user_memory from anon;
