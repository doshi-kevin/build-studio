-- ============================================================
-- Studio storage: per-student quota, and the limits as named settings
-- ============================================================
-- Reference: docs/reference/studio-plugin-publication.md ("Storage quota"). Builds on
-- 20261001181829_studio_publication.sql, which capped each installation.
--
-- The gap it closes: with only an installation cap, one student could fill a class's
-- whole allowance and every classmate would get "storage full". Now each student also
-- has their own allowance inside each installation.
--
-- Who counts against what:
--   - Every record counts toward its installation.
--   - A record with an owner (a perStudent record: one student's own work) also counts
--     toward that student. Students only ever write their own perStudent records
--     (src/lib/studio/policy.ts), so the owner is the author.
--   - A record with no owner (shared or staffOnly, written by staff) counts toward the
--     installation only. Staff content is the course itself, capped by the installation.
--
-- The limits move out of SQL functions into one named settings row, which the trigger
-- and the trusted server both read. Changing a limit is an update to that row, not a
-- migration, and there is no second copy to drift.
-- ============================================================

-- ── The limits ────────────────────────────────────────────────────────
-- SERVER-ONLY ON PURPOSE, like every Studio table: RLS on, no policies, client grants
-- revoked. One row (the primary key can only be true).
create table if not exists public.studio_plugin_limits (
  id                       boolean primary key default true check (id),
  installation_max_records bigint not null check (installation_max_records > 0),
  installation_max_bytes   bigint not null check (installation_max_bytes > 0),
  student_max_records      bigint not null check (student_max_records > 0),
  student_max_bytes        bigint not null check (student_max_bytes > 0),
  updated_at               timestamptz not null default now(),
  check (student_max_records <= installation_max_records and student_max_bytes <= installation_max_bytes)
);

alter table public.studio_plugin_limits enable row level security;
revoke all on public.studio_plugin_limits from public, anon, authenticated;
grant all on public.studio_plugin_limits to service_role;

-- V1 values. Installation: 50,000 records, 50 MiB (unchanged from the last migration).
-- Student: 1,000 records, 1 MiB per installation. A student's whole allowance is 2% of
-- the installation's bytes, so filling a class's storage takes 50 students at their
-- limit rather than one.
insert into public.studio_plugin_limits
  (id, installation_max_records, installation_max_bytes, student_max_records, student_max_bytes)
values (true, 50000, 52428800, 1000, 1048576)
on conflict (id) do nothing;

-- ── Per-student counters ──────────────────────────────────────────────
-- SERVER-ONLY ON PURPOSE. Only the trigger below writes it.
create table if not exists public.studio_plugin_student_usage (
  installation_id uuid not null references public.studio_plugin_installations(id) on delete cascade,
  student_id      uuid not null references public.profiles(id) on delete cascade,
  institution_id  uuid not null references public.institutions(id) on delete cascade,
  record_count    bigint not null default 0 check (record_count >= 0),
  record_bytes    bigint not null default 0 check (record_bytes >= 0),
  updated_at      timestamptz not null default now(),
  primary key (installation_id, student_id)
);

create index if not exists idx_studio_student_usage_student
  on public.studio_plugin_student_usage (student_id);

alter table public.studio_plugin_student_usage enable row level security;
revoke all on public.studio_plugin_student_usage from public, anon, authenticated;
grant all on public.studio_plugin_student_usage to service_role;

-- ── The usage trigger, now with both allowances ───────────────────────
-- Which allowance refused a write is in the error's hint ('installation' or 'student'),
-- so the server never has to read the message text.
-- Order is always: the installation's row, then the student's row. Two writers can't
-- lock them in opposite orders, so they can't deadlock. Each is one conditional UPDATE
-- under its row lock: it either fits or changes nothing. Raising undoes the whole write.
create or replace function public.studio_records_track_usage()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  lim       public.studio_plugin_limits%rowtype;
  v_records bigint;
  v_bytes   bigint;
begin
  if tg_op = 'DELETE' then
    -- No row when the whole installation is being deleted: nothing left to count.
    update public.studio_plugin_usage
       set record_count = record_count - 1,
           record_bytes = record_bytes - octet_length(old.data::text),
           updated_at = now()
     where installation_id = old.installation_id;
    if old.owner_id is not null then
      update public.studio_plugin_student_usage
         set record_count = record_count - 1,
             record_bytes = record_bytes - octet_length(old.data::text),
             updated_at = now()
       where installation_id = old.installation_id and student_id = old.owner_id;
    end if;
    return null;
  end if;

  -- No limits row means no one decided what fits: refuse rather than allow everything.
  select * into lim from public.studio_plugin_limits where id;
  if not found then
    raise exception 'Studio storage limits are missing' using errcode = 'program_limit_exceeded';
  end if;

  if tg_op = 'INSERT' then
    v_records := 1;
    v_bytes := octet_length(new.data::text);
  else
    v_records := 0;
    v_bytes := octet_length(new.data::text) - octet_length(old.data::text);
  end if;

  update public.studio_plugin_usage
     set record_count = record_count + v_records,
         record_bytes = record_bytes + v_bytes,
         updated_at = now()
   where installation_id = new.installation_id
     -- A write that shrinks or keeps usage always fits, even over a limit lowered later.
     and (v_records <= 0 or record_count + v_records <= lim.installation_max_records)
     and (v_bytes <= 0 or record_bytes + v_bytes <= lim.installation_max_bytes);
  if not found then
    raise exception 'Studio storage quota reached for installation %', new.installation_id
      using errcode = 'program_limit_exceeded', hint = 'installation';
  end if;

  if new.owner_id is not null then
    -- The student's first record here creates their row. A concurrent first write by the
    -- same student waits on the key, then finds the row.
    insert into public.studio_plugin_student_usage (installation_id, student_id, institution_id)
    values (new.installation_id, new.owner_id, new.institution_id)
    on conflict (installation_id, student_id) do nothing;

    update public.studio_plugin_student_usage
       set record_count = record_count + v_records,
           record_bytes = record_bytes + v_bytes,
           updated_at = now()
     where installation_id = new.installation_id and student_id = new.owner_id
       and (v_records <= 0 or record_count + v_records <= lim.student_max_records)
       and (v_bytes <= 0 or record_bytes + v_bytes <= lim.student_max_bytes);
    if not found then
      raise exception 'Studio storage quota reached for this student in installation %', new.installation_id
        using errcode = 'program_limit_exceeded', hint = 'student';
    end if;
  end if;
  return null;
end;
$$;

-- Students' existing records. Locked so nothing is written between this count and the
-- trigger above counting the next write; the migration's transaction holds the lock.
lock table public.studio_plugin_records in share row exclusive mode;
insert into public.studio_plugin_student_usage (installation_id, student_id, institution_id, record_count, record_bytes)
select r.installation_id, r.owner_id, min(r.institution_id::text)::uuid, count(*), coalesce(sum(octet_length(r.data::text)), 0)
  from public.studio_plugin_records r
 where r.owner_id is not null
 group by r.installation_id, r.owner_id
on conflict (installation_id, student_id) do nothing;

-- The old hard-coded limit functions are replaced by the settings row.
drop function if exists public.studio_installation_max_records();
drop function if exists public.studio_installation_max_bytes();

revoke execute on function public.studio_records_track_usage() from public, anon, authenticated;
