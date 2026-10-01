-- Publish `topics` for Supabase Realtime so the professor's open tab learns the
-- moment background extraction inserts new topic rows (topic-review notifications).
--
-- No RLS change: `topics` already has RLS (see 20260624194443). Realtime
-- postgres_changes respects RLS per subscriber, so a professor only receives
-- INSERT events for sections they can already read — no cross-tenant leak.
-- Guarded so re-running is a no-op (ALTER PUBLICATION has no IF NOT EXISTS).

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'topics'
  ) then
    alter publication supabase_realtime add table public.topics;
  end if;
end $$;
