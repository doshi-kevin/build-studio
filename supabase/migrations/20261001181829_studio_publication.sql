-- ============================================================
-- Studio publication: student visibility, storage quota, kill switch
-- ============================================================
-- Reference: docs/reference/studio-plugin-publication.md. Builds on
-- 20260930175948_studio_plugin_storage.sql.
--
-- Two different things are "published". A VERSION row is a frozen code release; it
-- exists for its owner's Studio only. STUDENT VISIBILITY (new here) says whether the
-- students of one section may open one installation. It always applies to that
-- installation's current version, which the deferred approval key already guarantees
-- was approved.
--
-- The checks a professor must pass before showing a plugin (entitlement, kill switch,
-- release gate, pre-publish validation) live in the trusted server, like every other
-- Studio authorization. This file adds what the database can hold on its own: the
-- allowed values, "an archived installation can't be shown again", the actor's
-- institution, and an exact storage count that concurrent writes can't overshoot.
-- ============================================================

-- ── Student visibility ───────────────────────────────────────────────

alter table public.studio_plugin_installations
  add column if not exists student_visibility text not null default 'hidden'
    check (student_visibility in ('hidden', 'visible')),
  add column if not exists visibility_changed_at timestamptz,
  add column if not exists visibility_changed_by uuid references public.profiles(id);

-- Every version must have code for both views. `not null` alone allowed ''.
alter table public.studio_plugin_versions
  add constraint studio_plugin_versions_bundles_not_empty
  check (char_length(student_bundle) > 0 and char_length(professor_bundle) > 0);

-- The installation guard from the storage migration, plus two rules: an installation
-- moves to `visible` only while active, and whoever changes visibility is in its
-- institution.
create or replace function public.studio_installations_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if tg_op = 'UPDATE' and (
    new.section_id <> old.section_id or new.project_id <> old.project_id or new.institution_id <> old.institution_id
  ) then
    raise exception 'An installation can''t move to another section, project or institution'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.archived_by is distinct from old.archived_by and new.archived_by is not null
     and not exists (
       select 1 from public.profiles p where p.id = new.archived_by and p.institution_id = new.institution_id
     ) then
    raise exception 'Tenant mismatch: whoever archives an installation must be in its institution'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.student_visibility = 'visible' and old.student_visibility <> 'visible'
     and new.status <> 'active' then
    raise exception 'An archived installation can''t be shown to students' using errcode = 'check_violation';
  end if;
  if new.visibility_changed_by is not null
     and (tg_op = 'INSERT' or new.visibility_changed_by is distinct from old.visibility_changed_by)
     and not exists (
       select 1 from public.profiles p where p.id = new.visibility_changed_by and p.institution_id = new.institution_id
     ) then
    raise exception 'Tenant mismatch: whoever changes visibility must be in the installation''s institution'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if new.student_visibility <> 'hidden' then
      raise exception 'A new installation starts hidden from students' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.course_sections cs where cs.id = new.section_id and cs.institution_id = new.institution_id
    ) then
      raise exception 'Tenant mismatch: an installation must be in its section''s institution'
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.studio_plugin_projects p
       where p.id = new.project_id and p.institution_id = new.institution_id and p.status = 'active'
    ) then
      raise exception 'An installation needs an active project in the same institution (rule 2.4)'
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.profiles p where p.id = new.installed_by and p.institution_id = new.institution_id
    ) then
      raise exception 'Tenant mismatch: whoever installs must be in the installation''s institution'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

-- The one write path for visibility. NOT an authorization boundary: the caller is the
-- trusted server, which has already verified that p_actor_id is this section's
-- professor and run the publication checks. The section is passed so a call naming an
-- installation from another section changes nothing. Returns whether anything changed.
create or replace function public.studio_set_student_visibility(
  p_installation_id uuid,
  p_section_id      uuid,
  p_visibility      text,
  p_actor_id        uuid
)
returns boolean
language plpgsql
set search_path to 'public'
as $$
declare
  v_current text;
  v_status  text;
begin
  if p_visibility is null or p_visibility not in ('hidden', 'visible') then
    raise exception 'Visibility must be hidden or visible' using errcode = 'check_violation';
  end if;

  select student_visibility, status into v_current, v_status
    from public.studio_plugin_installations
   where id = p_installation_id and section_id = p_section_id
     for update;
  if not found then
    raise exception 'Studio installation % not found in that section', p_installation_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_current = p_visibility then
    return false;
  end if;
  if p_visibility = 'visible' and v_status <> 'active' then
    raise exception 'An archived installation can''t be shown to students' using errcode = 'check_violation';
  end if;

  update public.studio_plugin_installations
     set student_visibility = p_visibility, visibility_changed_at = now(), visibility_changed_by = p_actor_id
   where id = p_installation_id;
  return true;
end;
$$;

-- ── Storage quota ────────────────────────────────────────────────────
-- One counter row per installation, kept in step with its records by a trigger in the
-- same transaction as the write. Taking space is one conditional UPDATE: it either
-- fits under the limit or changes nothing, and the row lock makes concurrent writers
-- to the same installation queue. So two requests can't both take the last slot.
--
-- Bytes are octet_length(data::text): the size of the JSON as Postgres stores and
-- prints it. Every record counts, archived or not, because it still takes space.

-- The limits. Replaced by the studio_plugin_limits settings row in
-- 20261001192059_studio_student_quota.sql, which also adds the per-student allowance.
create or replace function public.studio_installation_max_records()
returns bigint language sql immutable as $$ select 50000::bigint $$;

create or replace function public.studio_installation_max_bytes()
returns bigint language sql immutable as $$ select 52428800::bigint $$;

create table if not exists public.studio_plugin_usage (
  installation_id uuid primary key references public.studio_plugin_installations(id) on delete cascade,
  institution_id  uuid not null references public.institutions(id) on delete cascade,
  record_count    bigint not null default 0 check (record_count >= 0),
  record_bytes    bigint not null default 0 check (record_bytes >= 0),
  updated_at      timestamptz not null default now()
);

-- SERVER-ONLY ON PURPOSE, like every Studio table (.claude/rules/security-migrations.md):
-- RLS on with no policies, client grants revoked. Only the trigger below writes it; only
-- the trusted server (src/lib/studio/db.ts, service role) reads it.
alter table public.studio_plugin_usage enable row level security;
revoke all on public.studio_plugin_usage from public, anon, authenticated;
grant all on public.studio_plugin_usage to service_role;

-- Every installation gets its counter row when it's created.
create or replace function public.studio_installations_create_usage()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  insert into public.studio_plugin_usage (installation_id, institution_id)
  values (new.id, new.institution_id)
  on conflict (installation_id) do nothing;
  return null;
end;
$$;

drop trigger if exists trg_studio_installations_create_usage on public.studio_plugin_installations;
create trigger trg_studio_installations_create_usage
  after insert on public.studio_plugin_installations
  for each row execute function public.studio_installations_create_usage();

-- Installations that existed before this migration. The lock keeps records from being
-- written between this count and the trigger below taking over; the migration's
-- transaction holds it until commit.
lock table public.studio_plugin_records in share row exclusive mode;
insert into public.studio_plugin_usage (installation_id, institution_id, record_count, record_bytes)
select i.id, i.institution_id,
       (select count(*) from public.studio_plugin_records r where r.installation_id = i.id),
       (select coalesce(sum(octet_length(r.data::text)), 0) from public.studio_plugin_records r where r.installation_id = i.id)
  from public.studio_plugin_installations i
on conflict (installation_id) do nothing;

-- Runs after the records guard has accepted the row. Raising here undoes the write.
create or replace function public.studio_records_track_usage()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
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
    return null;
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
     and (v_records <= 0 or record_count + v_records <= public.studio_installation_max_records())
     and (v_bytes <= 0 or record_bytes + v_bytes <= public.studio_installation_max_bytes());
  if not found then
    raise exception 'Studio storage quota reached for installation %', new.installation_id
      using errcode = 'program_limit_exceeded';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_studio_records_track_usage on public.studio_plugin_records;
create trigger trg_studio_records_track_usage
  after insert or update of data or delete on public.studio_plugin_records
  for each row execute function public.studio_records_track_usage();

-- ── Global Studio kill switch ────────────────────────────────────────
-- platform_settings.settings.studio = { "disabled": bool }. Read by
-- src/lib/studio/access.ts, which fails closed. Written only here, by a super admin,
-- through the RLS-bound user client: the role check is inside the function, so
-- Postgres re-verifies it even if a server check regresses (the
-- set_institution_ai_policy pattern).
create or replace function public.set_studio_kill_switch(p_disabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_super_admin() then
    raise exception 'permission_denied';
  end if;
  if p_disabled is null then
    raise exception 'invalid_value';
  end if;
  update public.platform_settings
     set settings = jsonb_set(
           settings,
           '{studio}',
           jsonb_build_object('disabled', p_disabled, 'changedAt', now(), 'changedBy', auth.uid())
         ),
         updated_at = now()
   where id = true;
  if not found then
    raise exception 'platform_settings row missing';
  end if;
end;
$$;

-- ── Execute grants ───────────────────────────────────────────────────

revoke execute on function public.studio_installations_guard() from public, anon, authenticated;
revoke execute on function public.studio_set_student_visibility(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.studio_set_student_visibility(uuid, uuid, text, uuid) to service_role;
revoke execute on function public.studio_installations_create_usage() from public, anon, authenticated;
revoke execute on function public.studio_records_track_usage() from public, anon, authenticated;
-- The quota trigger isn't security definer, so it calls these as the writing role.
revoke execute on function public.studio_installation_max_records() from public, anon, authenticated;
revoke execute on function public.studio_installation_max_bytes() from public, anon, authenticated;
grant execute on function public.studio_installation_max_records() to service_role;
grant execute on function public.studio_installation_max_bytes() to service_role;
revoke execute on function public.set_studio_kill_switch(boolean) from public, anon;
grant execute on function public.set_studio_kill_switch(boolean) to authenticated;
