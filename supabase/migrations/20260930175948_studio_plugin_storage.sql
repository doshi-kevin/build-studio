-- ============================================================
-- Studio plugin storage: projects, versions, installations, approvals, records
-- ============================================================
-- Design: docs/designs/studio/studio-storage.md (local). Rules cite
-- docs/reference/studio-plugin-rules.md (v2); the manifest contract is
-- docs/reference/studio-plugin-manifest.md.
--
-- A plugin PROJECT is reusable source owned by a professor. Publishing freezes a
-- VERSION. An INSTALLATION puts one version into exactly one course section. An
-- APPROVAL row means "this section's professor approved this version" (rules 1.5,
-- 8.2). RECORDS are plugin data and belong to an installation, never to a version,
-- so one version installed in two sections keeps two separate sets of data (rule 2.4).
--
-- The approvals table is the spine. An installation's current version, and the
-- version stamped on every record, are foreign keys into it. So the database itself
-- refuses a version from another project, or one this section never approved.
--
-- SERVER-ONLY ON PURPOSE (rule 3.3, .claude/rules/security-migrations.md). RLS is on
-- with no policies, and every client grant is revoked. Who may see a record depends
-- on its collection's access rule in the manifest, which a SQL policy can't read, so
-- the trusted server decides per viewer. The constraints and triggers below are the
-- second line of defense against a bug in that server code.
--
-- Not here, deliberately: attempts (grading slice), breaking collection changes
-- (refused at publish in v1), partial capability approval (approval is all or nothing).
-- ============================================================

-- ── Tables ───────────────────────────────────────────────────────────

create table if not exists public.studio_plugin_projects (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  owner_id       uuid not null references public.profiles(id) on delete restrict,
  slug           text not null check (slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and char_length(slug) <= 40),
  name           text not null check (char_length(name) between 1 and 80),
  -- Work in progress. Its shape belongs to the builder slice; versions never read it.
  draft          jsonb,
  status         text not null default 'active' check (status in ('active', 'archived')),
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (institution_id, owner_id, slug)
);

create table if not exists public.studio_plugin_versions (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.studio_plugin_projects(id),
  institution_id   uuid not null references public.institutions(id) on delete cascade,
  version          text not null check (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  -- Validated by parseManifest (src/lib/studio/manifest.ts) before it is inserted.
  manifest         jsonb not null,
  bridge_version   text not null check (bridge_version in ('v1')),
  source           jsonb not null,
  -- One bundle per view, so a student's frame never receives professor code.
  student_bundle   text not null,
  professor_bundle text not null,
  bundle_sha256    text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  published_by     uuid not null references public.profiles(id),
  published_at     timestamptz not null default now(),
  unique (project_id, version),
  -- Target of the composite keys that pin a version to its project.
  unique (id, project_id),
  check (manifest ->> 'version' = version and manifest ->> 'bridgeVersion' = bridge_version)
);

create table if not exists public.studio_plugin_installations (
  id                 uuid primary key default gen_random_uuid(),
  institution_id     uuid not null references public.institutions(id) on delete cascade,
  section_id         uuid not null references public.course_sections(id) on delete cascade,
  project_id         uuid not null references public.studio_plugin_projects(id),
  current_version_id uuid not null,
  status             text not null default 'active' check (status in ('active', 'archived')),
  installed_by       uuid not null references public.profiles(id),
  archived_at        timestamptz,
  archived_by        uuid references public.profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, project_id),
  -- The current version belongs to this installation's project.
  foreign key (current_version_id, project_id) references public.studio_plugin_versions(id, project_id)
);

-- A section installs a project at most once at a time. Archived installs don't count.
create unique index if not exists uq_studio_installation_active
  on public.studio_plugin_installations (section_id, project_id)
  where status = 'active';

create index if not exists idx_studio_installations_section
  on public.studio_plugin_installations (section_id);

create table if not exists public.studio_plugin_approvals (
  installation_id uuid not null,
  version_id      uuid not null,
  project_id      uuid not null,
  institution_id  uuid not null references public.institutions(id) on delete cascade,
  approved_by     uuid not null references public.profiles(id),
  approved_at     timestamptz not null default now(),
  primary key (installation_id, version_id),
  -- These two keys share project_id, which forces the version and the installation
  -- to belong to the same project.
  foreign key (installation_id, project_id)
    references public.studio_plugin_installations(id, project_id) on delete cascade,
  foreign key (version_id, project_id) references public.studio_plugin_versions(id, project_id)
);

-- The current version must be approved for this installation (rules 1.5, 8.2).
-- Deferred to commit, because installing writes the installation and its first
-- approval in one transaction and each row points at the other.
alter table public.studio_plugin_installations
  drop constraint if exists studio_plugin_installations_current_version_approved;
alter table public.studio_plugin_installations
  add constraint studio_plugin_installations_current_version_approved
  foreign key (id, current_version_id)
  references public.studio_plugin_approvals(installation_id, version_id)
  deferrable initially deferred;

create table if not exists public.studio_plugin_records (
  id              uuid primary key default gen_random_uuid(),
  institution_id  uuid not null references public.institutions(id) on delete cascade,
  section_id      uuid not null references public.course_sections(id) on delete cascade,
  installation_id uuid not null references public.studio_plugin_installations(id) on delete cascade,
  -- The version that wrote the record. Must be approved for this installation.
  version_id      uuid not null,
  collection      text not null check (collection ~ '^[a-z][a-zA-Z0-9]{0,39}$'),
  -- The student a perStudent record belongs to; null for shared and staffOnly.
  owner_id        uuid references public.profiles(id),
  author_id       uuid not null references public.profiles(id),
  data            jsonb not null check (jsonb_typeof(data) = 'object'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  archived_at     timestamptz,
  foreign key (installation_id, version_id)
    references public.studio_plugin_approvals(installation_id, version_id)
);

create index if not exists idx_studio_records_lookup
  on public.studio_plugin_records (installation_id, collection, owner_id)
  where archived_at is null;

-- Deleting a section cascades here, and this table grows with every answer.
create index if not exists idx_studio_records_section
  on public.studio_plugin_records (section_id);

-- ── Server-only: default deny for every client role ──────────────────

alter table public.studio_plugin_projects      enable row level security;
alter table public.studio_plugin_versions      enable row level security;
alter table public.studio_plugin_installations enable row level security;
alter table public.studio_plugin_approvals     enable row level security;
alter table public.studio_plugin_records       enable row level security;

revoke all on public.studio_plugin_projects,
              public.studio_plugin_versions,
              public.studio_plugin_installations,
              public.studio_plugin_approvals,
              public.studio_plugin_records
  from public, anon, authenticated;
grant all on public.studio_plugin_projects,
             public.studio_plugin_versions,
             public.studio_plugin_installations,
             public.studio_plugin_approvals,
             public.studio_plugin_records
  to service_role;

-- ── Guards ───────────────────────────────────────────────────────────
-- Same shape as the enforce_*_tenant_match triggers in 00000000000055: read the
-- parent, raise check_violation on a mismatch.

-- A project lives in its owner's institution, and never moves: its versions and
-- installations are stamped with that institution.
create or replace function public.studio_projects_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if tg_op = 'UPDATE' and new.institution_id <> old.institution_id then
    raise exception 'A project can''t move to another institution' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = new.owner_id and p.institution_id = new.institution_id
  ) then
    raise exception 'Tenant mismatch: studio_plugin_projects.institution_id must equal the owner''s institution'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_projects_guard on public.studio_plugin_projects;
create trigger trg_studio_projects_guard
  before insert or update of institution_id, owner_id on public.studio_plugin_projects
  for each row execute function public.studio_projects_guard();

-- Publishing. Runs on every insert, so no code path can skip it. The project row
-- is locked so two concurrent publishes can't both pass the "higher version" check.
create or replace function public.studio_versions_before_insert()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  proj record;
  prev record;
  coll text;
begin
  select institution_id, slug, status into proj
    from public.studio_plugin_projects where id = new.project_id for update;
  if not found then
    raise exception 'Studio project % not found', new.project_id using errcode = 'foreign_key_violation';
  end if;
  if proj.status <> 'active' then
    raise exception 'Studio project % is archived and can''t publish', new.project_id using errcode = 'check_violation';
  end if;
  if new.institution_id <> proj.institution_id then
    raise exception 'Tenant mismatch: a version must be in its project''s institution' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = new.published_by and p.institution_id = new.institution_id
  ) then
    raise exception 'Tenant mismatch: a version''s publisher must be in its institution' using errcode = 'check_violation';
  end if;
  if new.manifest ->> 'id' is distinct from proj.slug then
    raise exception 'The manifest id must equal the project slug %', proj.slug using errcode = 'check_violation';
  end if;

  select v.version, v.manifest into prev
    from public.studio_plugin_versions v
   where v.project_id = new.project_id
   order by string_to_array(v.version, '.')::int[] desc
   limit 1;

  if found then
    if string_to_array(new.version, '.')::int[] <= string_to_array(prev.version, '.')::int[] then
      raise exception 'Version % must be higher than the last published version %', new.version, prev.version
        using errcode = 'check_violation';
    end if;
    -- Version 1 allows only compatible changes: every collection stays exactly as it
    -- was. Breaking collection changes are deferred (studio-plugin-manifest.md).
    for coll in select jsonb_object_keys(prev.manifest -> 'collections') loop
      if (new.manifest -> 'collections' -> coll) is distinct from (prev.manifest -> 'collections' -> coll) then
        raise exception 'Collection % changed or was removed; breaking collection changes aren''t supported yet', coll
          using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_studio_versions_before_insert on public.studio_plugin_versions;
create trigger trg_studio_versions_before_insert
  before insert on public.studio_plugin_versions
  for each row execute function public.studio_versions_before_insert();

-- Rule 8.4: a published version is frozen, even against our own server code.
-- Approvals are history, so they are append-only for the same reason.
create or replace function public.studio_refuse_update()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  raise exception '% rows are immutable; insert a new row instead', tg_table_name
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists trg_studio_versions_immutable on public.studio_plugin_versions;
create trigger trg_studio_versions_immutable
  before update on public.studio_plugin_versions
  for each row execute function public.studio_refuse_update();

drop trigger if exists trg_studio_approvals_immutable on public.studio_plugin_approvals;
create trigger trg_studio_approvals_immutable
  before update on public.studio_plugin_approvals
  for each row execute function public.studio_refuse_update();

-- An installation's section and project must both be in its institution, and it can
-- never be moved to another section, project or institution afterwards: its records
-- are stamped with that section.
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
  if tg_op = 'INSERT' then
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

drop trigger if exists trg_studio_installations_guard on public.studio_plugin_installations;
create trigger trg_studio_installations_guard
  before insert or update on public.studio_plugin_installations
  for each row execute function public.studio_installations_guard();

create or replace function public.studio_approvals_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if not exists (
    select 1 from public.studio_plugin_installations i
     where i.id = new.installation_id and i.institution_id = new.institution_id
  ) then
    raise exception 'Tenant mismatch: an approval must be in its installation''s institution'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = new.approved_by and p.institution_id = new.institution_id
  ) then
    raise exception 'Tenant mismatch: the approver must be in the installation''s institution'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_approvals_guard on public.studio_plugin_approvals;
create trigger trg_studio_approvals_guard
  before insert on public.studio_plugin_approvals
  for each row execute function public.studio_approvals_guard();

-- Records: the stamps must match the installation, the installation must be active
-- (an archived plugin accepts no new work, rule 3.6), the collection must be one the
-- writing version declared, and a perStudent record must belong to a student enrolled
-- in this section. Field-level validation of `data` stays in the server (Zod, built
-- from the manifest).
create or replace function public.studio_records_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  inst record;
  v_access text;
begin
  if tg_op = 'UPDATE' and (
    new.institution_id <> old.institution_id or new.section_id <> old.section_id
    or new.installation_id <> old.installation_id or new.collection <> old.collection
    or new.owner_id is distinct from old.owner_id or new.author_id <> old.author_id
  ) then
    raise exception 'A record''s stamps can''t change' using errcode = 'check_violation';
  end if;

  select i.institution_id, i.section_id, i.status into inst
    from public.studio_plugin_installations i where i.id = new.installation_id;
  if not found then
    raise exception 'Studio installation % not found', new.installation_id using errcode = 'foreign_key_violation';
  end if;
  if inst.status <> 'active' then
    raise exception 'Studio installation % is archived and accepts no writes', new.installation_id
      using errcode = 'check_violation';
  end if;
  if new.institution_id <> inst.institution_id or new.section_id <> inst.section_id then
    raise exception 'Tenant mismatch: a record must be in its installation''s section and institution'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = new.author_id and p.institution_id = new.institution_id
  ) then
    raise exception 'Tenant mismatch: a record''s author must be in its institution' using errcode = 'check_violation';
  end if;

  select v.manifest -> 'collections' -> new.collection ->> 'access' into v_access
    from public.studio_plugin_versions v where v.id = new.version_id;
  if v_access is null then
    raise exception 'Collection % isn''t declared by the writing version', new.collection
      using errcode = 'check_violation';
  end if;
  if v_access = 'perStudent' then
    if new.owner_id is null or not exists (
      select 1 from public.enrollments e
       where e.section_id = new.section_id and e.student_id = new.owner_id and e.status in ('enrolled', 'completed')
    ) then
      raise exception 'A perStudent record must belong to a student enrolled in its section'
        using errcode = 'check_violation';
    end if;
  elsif new.owner_id is not null then
    raise exception 'Only perStudent records have an owner' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_studio_records_guard on public.studio_plugin_records;
create trigger trg_studio_records_guard
  before insert or update on public.studio_plugin_records
  for each row execute function public.studio_records_guard();

drop trigger if exists update_studio_projects_updated_at on public.studio_plugin_projects;
create trigger update_studio_projects_updated_at
  before update on public.studio_plugin_projects
  for each row execute function public.update_updated_at();

drop trigger if exists update_studio_installations_updated_at on public.studio_plugin_installations;
create trigger update_studio_installations_updated_at
  before update on public.studio_plugin_installations
  for each row execute function public.update_updated_at();

drop trigger if exists update_studio_records_updated_at on public.studio_plugin_records;
create trigger update_studio_records_updated_at
  before update on public.studio_plugin_records
  for each row execute function public.update_updated_at();

-- ── Lifecycle functions ──────────────────────────────────────────────
-- Only the operations that need more than one statement. Create project, publish
-- (the insert trigger above does the checks), archive installation and archive
-- project are single guarded statements the server runs directly.
--
-- These are NOT an authorization boundary. The caller is a server action that has
-- already run getAuthUser and verifySectionAccess with the professor role (rule 8.1).
-- p_actor_id is that verified user, recorded as who approved.

-- Install: the installation and its first approval land together, or not at all.
create or replace function public.studio_install_plugin(
  p_section_id uuid,
  p_version_id uuid,
  p_actor_id   uuid
)
returns uuid
language plpgsql
set search_path to 'public'
as $$
declare
  v_project_id     uuid;
  v_institution_id uuid;
  v_installation   uuid;
begin
  select project_id, institution_id into v_project_id, v_institution_id
    from public.studio_plugin_versions where id = p_version_id;
  if not found then
    raise exception 'Studio version % not found', p_version_id using errcode = 'foreign_key_violation';
  end if;

  insert into public.studio_plugin_installations
    (institution_id, section_id, project_id, current_version_id, installed_by)
  values (v_institution_id, p_section_id, v_project_id, p_version_id, p_actor_id)
  returning id into v_installation;

  insert into public.studio_plugin_approvals
    (installation_id, version_id, project_id, institution_id, approved_by)
  values (v_installation, p_version_id, v_project_id, v_institution_id, p_actor_id);

  return v_installation;
end;
$$;

-- Upgrade or roll back one installation. With p_approve, the caller has shown the
-- professor the plugin card for this version and they approved it (rule 8.2); the
-- approval is recorded, idempotently. Without it, the version must already be
-- approved here, which is what makes rollback one step (rule 8.5). Either way the
-- deferred key refuses an unapproved version at commit.
create or replace function public.studio_activate_version(
  p_installation_id uuid,
  p_version_id      uuid,
  p_actor_id        uuid,
  p_approve         boolean
)
returns void
language plpgsql
set search_path to 'public'
as $$
begin
  if p_approve then
    insert into public.studio_plugin_approvals
      (installation_id, version_id, project_id, institution_id, approved_by)
    select i.id, p_version_id, i.project_id, i.institution_id, p_actor_id
      from public.studio_plugin_installations i
     where i.id = p_installation_id and i.status = 'active'
    on conflict (installation_id, version_id) do nothing;
  end if;

  update public.studio_plugin_installations
     set current_version_id = p_version_id
   where id = p_installation_id and status = 'active';
  if not found then
    raise exception 'Studio installation % is not active', p_installation_id using errcode = 'check_violation';
  end if;
end;
$$;

-- Trigger functions aren't callable over PostgREST, but revoke anyway so nothing
-- depends on that. The lifecycle functions are for the server only.
revoke execute on function public.studio_projects_guard()           from public, anon, authenticated;
revoke execute on function public.studio_versions_before_insert()   from public, anon, authenticated;
revoke execute on function public.studio_refuse_update()            from public, anon, authenticated;
revoke execute on function public.studio_installations_guard()      from public, anon, authenticated;
revoke execute on function public.studio_approvals_guard()          from public, anon, authenticated;
revoke execute on function public.studio_records_guard()            from public, anon, authenticated;
revoke execute on function public.studio_install_plugin(uuid, uuid, uuid)            from public, anon, authenticated;
revoke execute on function public.studio_activate_version(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.studio_install_plugin(uuid, uuid, uuid)            to service_role;
grant execute on function public.studio_activate_version(uuid, uuid, uuid, boolean) to service_role;
