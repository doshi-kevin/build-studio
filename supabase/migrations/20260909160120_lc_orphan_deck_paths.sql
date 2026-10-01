-- Which live-classroom deck files are safe to delete.
--
-- The reaper endpoint cannot work this out for itself: PostgREST only exposes
-- the `public` and `graphql_public` schemas, so a Supabase client asking for
-- storage.objects gets
--
--   PGRST106 Invalid schema: storage
--
-- (Found by the endpoint's own dry run, before anything was scheduled.)
--
-- So the two halves live where each is possible. The set logic runs here, in
-- SQL, next to lc_rooms. The deletion runs in the route through the Storage
-- API, because storage.protect_delete() blocks DELETE from storage.objects —
-- which is what killed the pg_cron job this replaces.
--
-- SELECT only. Nothing here deletes, and nothing here can: the trigger that
-- broke the old job would block it just the same.
--
-- Keeps a deck while its room is live, and for p_keep_after past the end of the
-- session, which covers a professor reopening the tab straight after class.
-- Anything else is scratch: promote-deck-material.ts copies uploads worth
-- keeping into the course-materials bucket, so this bucket is not the record.
--
-- Oldest first, so a bounded batch drains a backlog deterministically rather
-- than revisiting the same rows each run.

create or replace function public.lc_orphan_deck_paths(
  p_keep_after interval default '1 hour',
  p_limit int default 500
)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'live-classroom-decks'
     and not exists (
       select 1
         from lc_rooms r
        where o.name like r.id::text || '/%'
          and (
            r.status = 'live'
            or (r.ended_at is not null and r.ended_at > now() - p_keep_after)
          )
     )
   order by o.created_at
   limit p_limit
$$;

comment on function public.lc_orphan_deck_paths(interval, int) is
  'Deck object paths safe to delete. Read-only; the route deletes via the Storage API.';

-- Service-only. CREATE FUNCTION grants EXECUTE to PUBLIC by default and
-- anon/authenticated inherit it, so revoke all three, then hand it back to the
-- one caller. The grant is not optional: revoking PUBLIC also strips
-- service_role where it has no explicit grant, and the route would 500 on
-- "permission denied for function".
revoke execute on function public.lc_orphan_deck_paths(interval, int) from public, anon, authenticated;
grant execute on function public.lc_orphan_deck_paths(interval, int) to service_role;
