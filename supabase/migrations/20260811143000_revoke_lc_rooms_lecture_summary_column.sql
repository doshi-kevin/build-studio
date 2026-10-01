-- Issue #550: lc_rooms.lecture_summary is reachable with the anon key.
--
-- The "Catch me up" recap is cached on lc_rooms.lecture_summary, and whether a
-- student may see it is gated ONLY in application code (getLectureSummary checks
-- lecture_summary_enabled). But the row-level policy "students view rooms in
-- enrolled sections" grants SELECT on the WHOLE row, so an enrolled student can
-- bypass that gate with a direct anon-key query:
--     supabase.from('lc_rooms').select('lecture_summary').eq('id', roomId).single()
-- and read a summary the professor explicitly disabled.
--
-- Fix: hide the column at the database layer. Postgres column privileges only
-- take effect once the table-wide SELECT grant is removed, so we revoke SELECT
-- on lc_rooms from anon/authenticated and re-grant it on every column EXCEPT
-- lecture_summary. Row visibility is still governed by the existing RLS policies.
--
-- Server code is unaffected: every legitimate read of lecture_summary goes
-- through the service_role admin client (src/lib/live-classroom/summary/actions.ts,
-- snapshot.ts), which bypasses column grants. No browser client reads lc_rooms
-- directly (all client access is via Realtime broadcast channels), so nothing on
-- the student side loses a column it was actually using.
--
-- The column list is enumerated dynamically at apply time so this survives schema
-- drift between branches. New columns added to lc_rooms AFTER this migration are
-- fail-safe hidden until re-granted; any later migration that adds a
-- student-readable column to lc_rooms must GRANT SELECT on it to anon/authenticated.

revoke select on public.lc_rooms from anon, authenticated;

do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ')
    into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'lc_rooms'
    and column_name <> 'lecture_summary';

  execute format('grant select (%s) on public.lc_rooms to anon, authenticated', cols);
end $$;
