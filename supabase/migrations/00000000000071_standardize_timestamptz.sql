-- Standardize the drifted timestamp columns to timestamptz (fix-forward).
--
-- These columns are `timestamp with time zone` in the repo migrations
-- (base_schema) but bare `timestamp` on PROD (legacy drift; `joined_at` is
-- `date` on prod). Rather than downgrade the migrations to prod's bare type, we
-- converge on the correct, timezone-safe `timestamptz`: convert any column that
-- is STILL stored as `timestamp`/`date` up to `timestamptz`.
--
-- LOSSLESS on prod: prod's session TimeZone is UTC and these columns default to
-- now(), so the stored wall-clock values ARE UTC. `AT TIME ZONE 'UTC'` tags
-- each value as the UTC instant it already represents — no time shift.
--
-- IDEMPOTENT / fresh-build-safe: each column is converted ONLY if it is
-- currently bare `timestamp` (or `date` for joined_at). On a from-migrations
-- database (staging, local, CI) these columns are already `timestamptz`, so
-- every branch is skipped and this migration is a true no-op there.
--
-- ⚠️ PROD IMPACT: a column TYPE change REWRITES the table under an
-- ACCESS EXCLUSIVE lock. Apply during a maintenance window / low traffic.
-- Affected tables: course_sections, courses, department_faculty, departments,
-- enrollments, events, profiles, programs.

do $$
declare
  cols text[][] := array[
    ['course_sections','created_at'], ['course_sections','updated_at'],
    ['courses','created_at'],         ['courses','updated_at'],
    ['department_faculty','created_at'], ['department_faculty','updated_at'],
    ['departments','created_at'],     ['departments','updated_at'],
    ['enrollments','enrolled_at'],
    ['events','timestamp'],
    ['profiles','created_at'],        ['profiles','updated_at'], ['profiles','last_login_at'],
    ['programs','created_at'],        ['programs','updated_at']
  ];
  i int;
  tbl text;
  col text;
  cur text;
begin
  for i in 1 .. array_length(cols, 1) loop
    tbl := cols[i][1];
    col := cols[i][2];
    select data_type into cur
      from information_schema.columns
      where table_schema = 'public' and table_name = tbl and column_name = col;
    if cur = 'timestamp without time zone' then
      execute format(
        'alter table public.%I alter column %I type timestamptz using %I at time zone ''UTC''',
        tbl, col, col);
      raise notice 'converted %.% : timestamp -> timestamptz', tbl, col;
    end if;
  end loop;

  -- department_faculty.joined_at: `date` on prod -> timestamptz (midnight UTC)
  select data_type into cur
    from information_schema.columns
    where table_schema = 'public' and table_name = 'department_faculty' and column_name = 'joined_at';
  if cur = 'date' then
    alter table public.department_faculty
      alter column joined_at type timestamptz using joined_at::timestamp at time zone 'UTC';
    raise notice 'converted department_faculty.joined_at : date -> timestamptz';
  end if;
end $$;
