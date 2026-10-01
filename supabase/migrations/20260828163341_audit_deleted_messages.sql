-- #678: retain every deleted message for audit, serve none of it.
--
-- THE DECISION. Nothing is permanently deleted from the database. A soft-deleted message and its
-- attachment metadata stay retrievable for a later audit. What changes is that they stop being
-- reachable by a client.
--
-- WHY THE PREVIOUS ATTEMPT FAILED, so nobody rebuilds it. A view that blanked `content` for
-- soft-deleted rows, with the client repointed at it, does NOT work: `authenticated` still holds
-- SELECT on the base table and PostgREST exposes every relation a role can read, so a channel
-- member reads the original text by changing one word in the URL. Reproduced on production with a
-- real student session. And that grant cannot be revoked while the view uses
-- `security_invoker = on`, because invoker rights check base-table privileges as the CALLING user.
--
-- THE SHAPE. A trigger, in the database, not application code. Three reasons it is the right layer:
--   1. No code path can bypass it. An application-layer copy-then-blank only protects the delete
--      actions that remember to call it.
--   2. It keeps Supabase Realtime working. `authenticated` keeps SELECT on the public table and
--      simply reads an already-blank `content`.
--   3. It is BEFORE UPDATE, so the row is blanked before the WAL record is written. The realtime
--      frame for a soft-delete therefore carries the blanked row, which closes the one residue the
--      view could never cover.
--
-- The archive lives in its own schema. Supabase exposes only `public` over PostgREST, so a table in
-- `audit` is unreachable by any client regardless of grants. Grants are revoked anyway, and RLS is
-- enabled with no policy, because defence in depth on the one table holding moderated content is
-- worth three extra lines.
--
-- ONE trigger function for all THREE message tables. `project_chat_messages` and `dm_messages` have
-- the identical soft-delete shape and had no protection at all. Writing this per-table is how the
-- siblings drift, which is exactly how discussions ended up fixed and the other two not.

create schema if not exists audit;

-- Never reachable from a client. `service_role` gets USAGE only so server code can read the archive.
revoke all on schema audit from public;
revoke all on schema audit from anon, authenticated;
grant usage on schema audit to service_role;

create table if not exists audit.deleted_messages (
  id            bigserial primary key,
  source_table  text        not null,
  message_id    uuid        not null,
  deleted_at    timestamptz not null,
  deleted_by_id uuid,
  -- The FULL pre-blank row as jsonb, deliberately, rather than mirrored columns. The three tables
  -- do not share a column set (project_chat_messages carries kind/system_event/system_payload and
  -- three mention arrays), and a snapshot captures whatever a table gains later without a schema
  -- change here. An audit record that silently stops capturing a new column is worse than useless.
  row_snapshot  jsonb       not null,
  archived_at   timestamptz not null default now(),
  -- One archive row per message. A re-delete must not append a second, already-blanked snapshot on
  -- top of the real one.
  unique (source_table, message_id)
);

comment on table audit.deleted_messages is
  'Pre-blank snapshots of soft-deleted chat messages (#678). Written by a BEFORE UPDATE trigger on '
  'discussion_messages, project_chat_messages and dm_messages. Retained for audit; never served to '
  'a client. In the `audit` schema, which Supabase does not expose over PostgREST.';

alter table audit.deleted_messages enable row level security;
-- Deliberately NO policy: nothing but a role that bypasses RLS (service_role, postgres) can read.

-- Append-only by construction: the trigger runs as its owner, so no client role needs INSERT, and
-- nobody is granted UPDATE or DELETE. An audit trail you can edit is not an audit trail.
revoke all on table audit.deleted_messages from public;
revoke all on table audit.deleted_messages from anon, authenticated;
grant select on table audit.deleted_messages to service_role;

create or replace function audit.archive_and_blank_message()
returns trigger
language plpgsql
security definer
set search_path = public, audit, pg_temp
as $$
begin
  -- Only on the TRANSITION into deleted. Without this guard every later update to an
  -- already-deleted row would try to archive the blanked version.
  if new.deleted_at is not null and old.deleted_at is null then
    insert into audit.deleted_messages (
      source_table, message_id, deleted_at, deleted_by_id, row_snapshot
    )
    values (
      tg_table_name, old.id, new.deleted_at, new.deleted_by_id, to_jsonb(old)
    )
    on conflict (source_table, message_id) do nothing;

    -- `content` is NOT NULL on all three tables, so blank rather than null.
    new.content := '';
    new.attachment_url  := null;
    new.attachment_path := null;
    new.attachment_name := null;
    new.attachment_size := null;
    new.attachment_type := null;
  end if;

  return new;
end $$;

comment on function audit.archive_and_blank_message() is
  'BEFORE UPDATE trigger (#678): on the transition into soft-deleted, snapshots the pre-blank row '
  'into audit.deleted_messages, then blanks content and every attachment column. BEFORE, so the '
  'realtime WAL frame already carries the blanked row.';

revoke all on function audit.archive_and_blank_message() from public;
revoke all on function audit.archive_and_blank_message() from anon, authenticated;

drop trigger if exists trg_archive_and_blank on public.discussion_messages;
create trigger trg_archive_and_blank
  before update on public.discussion_messages
  for each row execute function audit.archive_and_blank_message();

drop trigger if exists trg_archive_and_blank on public.project_chat_messages;
create trigger trg_archive_and_blank
  before update on public.project_chat_messages
  for each row execute function audit.archive_and_blank_message();

drop trigger if exists trg_archive_and_blank on public.dm_messages;
create trigger trg_archive_and_blank
  before update on public.dm_messages
  for each row execute function audit.archive_and_blank_message();

-- Backfill. The trigger only fires on the transition, so rows soft-deleted BEFORE this migration
-- still hold their content in the public table and would stay exposed. Archive them, then blank
-- them. This is the only part of the migration that touches existing data, and it moves the text
-- rather than destroying it.
do $$
declare t text;
begin
  for t in select unnest(array['discussion_messages', 'project_chat_messages', 'dm_messages']) loop
    execute format($f$
      insert into audit.deleted_messages (source_table, message_id, deleted_at, deleted_by_id, row_snapshot)
      select %L, m.id, m.deleted_at, m.deleted_by_id, to_jsonb(m)
        from public.%I m
       where m.deleted_at is not null
      on conflict (source_table, message_id) do nothing
    $f$, t, t);

    execute format($f$
      update public.%I
         set content = '', attachment_url = null, attachment_path = null,
             attachment_name = null, attachment_size = null, attachment_type = null
       where deleted_at is not null
         and (content <> '' or attachment_url is not null or attachment_path is not null)
    $f$, t);
  end loop;
end $$;

-- The redacting view is now a no-op: `content` is blank in the table itself for a deleted row, so
-- its CASE can never fire. Dropping it rather than leaving an abstraction whose header describes a
-- threat model that no longer applies, and so the client reads the same relation realtime streams.
drop view if exists public.discussion_messages_safe;
