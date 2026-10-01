-- ============================================================
-- Studio pre-publish validator: results, review, settings, artifact hash, skill bindings
-- ============================================================
-- Reference: docs/reference/studio-plugin-validator.md. Builds on the storage,
-- publication and student-quota migrations.
--
-- The validator answers one question: does this exact, immutable plugin version meet
-- Scholera's publication requirements? Its verdict lives here, append-only, and the
-- publication gate (src/lib/studio/prepublish.ts) reads it. A version reaches students
-- only with a passing static run AND a passing runtime run, both for the version's exact
-- artifact hash and a ruleset at or above the minimum.
--
-- Every table is SERVER-ONLY ON PURPOSE, like every Studio table: RLS on, no policies,
-- client grants revoked. The trusted server (src/lib/studio/db.ts) is the only reader
-- and writer. The guards below are the second line of defense: results can't be
-- rewritten once final, a review needs a super admin, and nothing can point at a
-- version from another institution.
-- ============================================================

-- ── The artifact hash on each version ─────────────────────────────────
-- sha256 over the canonical artifact: manifest, source and both bundles
-- (src/lib/studio/validator/artifact.ts). Set once at publish; versions are immutable,
-- so it never changes. Null only for versions published before this migration, which
-- therefore can't pass validation until republished.
alter table public.studio_plugin_versions
  add column if not exists artifact_sha256 text check (artifact_sha256 ~ '^[0-9a-f]{64}$');

-- ── Validator settings ────────────────────────────────────────────────
-- One row. `min_accepted_ruleset`: the oldest ruleset whose verdicts still allow
-- showing a version to students, or activating one in a visible installation. Raised
-- only when a validator change closes a real gap; ordinary improvements leave it alone,
-- so live courses aren't broken by them.
create table if not exists public.studio_validator_settings (
  id                   boolean primary key default true check (id),
  min_accepted_ruleset integer not null default 1 check (min_accepted_ruleset >= 1),
  updated_at           timestamptz not null default now()
);
insert into public.studio_validator_settings (id) values (true) on conflict (id) do nothing;

alter table public.studio_validator_settings enable row level security;
revoke all on public.studio_validator_settings from public, anon, authenticated;
grant all on public.studio_validator_settings to service_role;

-- ── Validation runs ───────────────────────────────────────────────────
-- One row per run of one stage. `error` means the validator failed, not the plugin;
-- it never counts as passed.
create table if not exists public.studio_plugin_validations (
  id                uuid primary key default gen_random_uuid(),
  version_id        uuid not null references public.studio_plugin_versions(id) on delete cascade,
  institution_id    uuid not null references public.institutions(id) on delete cascade,
  stage             text not null check (stage in ('static', 'runtime')),
  status            text not null default 'pending'
                    check (status in ('pending', 'running', 'passed', 'failed', 'needs_review', 'error')),
  artifact_sha256   text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  validator_version text not null check (char_length(validator_version) between 1 and 40),
  ruleset_version   integer not null check (ruleset_version >= 1),
  runtime_version   text not null check (runtime_version in ('v1')),
  trigger           text not null check (trigger in ('publish', 'professor', 'ruleset_change', 'retry', 'test')),
  requested_by      uuid references public.profiles(id),
  browser           text check (char_length(browser) <= 120),
  runner            text check (char_length(runner) <= 60),
  ai_model          text check (char_length(ai_model) <= 80),
  ai_rubric_version text check (char_length(ai_rubric_version) <= 40),
  -- Bounded and code-free: an error code and a short, fixed message.
  error             jsonb check (error is null or (jsonb_typeof(error) = 'object' and octet_length(error::text) <= 2048)),
  -- The callback token's hash for runtime runs: only the runner holding the token
  -- can report, and only once.
  callback_sha256   text check (callback_sha256 ~ '^[0-9a-f]{64}$'),
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists idx_studio_validations_version
  on public.studio_plugin_validations (version_id, stage, ruleset_version, created_at desc);

-- One active run per version, stage, ruleset and artifact: double clicks and retries
-- can't stack browser or AI work.
create unique index if not exists uq_studio_validations_active
  on public.studio_plugin_validations (version_id, stage, ruleset_version, artifact_sha256)
  where status in ('pending', 'running');

alter table public.studio_plugin_validations enable row level security;
revoke all on public.studio_plugin_validations from public, anon, authenticated;
grant all on public.studio_plugin_validations to service_role;

-- A run belongs to its version's institution, moves only forward
-- (pending, running, final), and never changes once final.
create or replace function public.studio_validations_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.studio_plugin_versions v where v.id = new.version_id and v.institution_id = new.institution_id
    ) then
      raise exception 'Tenant mismatch: a validation must be in its version''s institution' using errcode = 'check_violation';
    end if;
    if new.status not in ('pending', 'running') then
      raise exception 'A validation starts pending or running' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status not in ('pending', 'running') then
    raise exception 'A finished validation can''t change' using errcode = 'check_violation';
  end if;
  if new.version_id <> old.version_id or new.institution_id <> old.institution_id or new.stage <> old.stage
     or new.artifact_sha256 <> old.artifact_sha256 or new.ruleset_version <> old.ruleset_version
     or new.validator_version <> old.validator_version or new.runtime_version <> old.runtime_version
     or new.created_at <> old.created_at then
    raise exception 'A validation''s identity can''t change' using errcode = 'check_violation';
  end if;
  if old.status = 'running' and new.status = 'pending' then
    raise exception 'A validation can''t go back to pending' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_validations_guard on public.studio_plugin_validations;
create trigger trg_studio_validations_guard
  before insert or update on public.studio_plugin_validations
  for each row execute function public.studio_validations_guard();

-- ── Validation checks ─────────────────────────────────────────────────
-- One row per check per run. Never the plugin's code: a plain message and bounded
-- metadata (an API name, a line number, a measured value).
create table if not exists public.studio_plugin_validation_checks (
  validation_id uuid not null references public.studio_plugin_validations(id) on delete cascade,
  check_id      text not null check (check_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and char_length(check_id) <= 80),
  rule_refs     text[] not null default '{}' check (cardinality(rule_refs) <= 10),
  stage         text not null check (stage in ('static', 'runtime')),
  status        text not null check (status in ('passed', 'failed', 'warning', 'needs_review', 'skipped', 'error')),
  severity      text not null check (severity in ('security', 'reliability', 'policy', 'quality')),
  message       text not null check (char_length(message) between 1 and 500),
  metadata      jsonb not null default '{}'::jsonb
                check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4096),
  created_at    timestamptz not null default now(),
  primary key (validation_id, check_id)
);

alter table public.studio_plugin_validation_checks enable row level security;
revoke all on public.studio_plugin_validation_checks from public, anon, authenticated;
grant all on public.studio_plugin_validation_checks to service_role;

drop trigger if exists trg_studio_validation_checks_immutable on public.studio_plugin_validation_checks;
create trigger trg_studio_validation_checks_immutable
  before update on public.studio_plugin_validation_checks
  for each row execute function public.studio_refuse_update();

-- Checks are written only while their run is still open.
create or replace function public.studio_validation_checks_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if not exists (
    select 1 from public.studio_plugin_validations v
     where v.id = new.validation_id and v.status in ('pending', 'running') and v.stage = new.stage
  ) then
    raise exception 'Checks can only be added to an open validation of the same stage' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_validation_checks_guard on public.studio_plugin_validation_checks;
create trigger trg_studio_validation_checks_guard
  before insert on public.studio_plugin_validation_checks
  for each row execute function public.studio_validation_checks_guard();

-- ── Reviews ───────────────────────────────────────────────────────────
-- A Scholera reviewer's decision on one `needs_review` check. Append-only. The
-- reviewer must be a super admin and must not be whoever published the version, so a
-- professor can never resolve their own escalation.
create table if not exists public.studio_plugin_validation_reviews (
  validation_id uuid not null,
  check_id      text not null,
  decision      text not null check (decision in ('approved', 'rejected')),
  reviewer_id   uuid not null references public.profiles(id),
  reason        text not null check (char_length(reason) between 1 and 500),
  created_at    timestamptz not null default now(),
  primary key (validation_id, check_id),
  foreign key (validation_id, check_id)
    references public.studio_plugin_validation_checks(validation_id, check_id) on delete cascade
);

alter table public.studio_plugin_validation_reviews enable row level security;
revoke all on public.studio_plugin_validation_reviews from public, anon, authenticated;
grant all on public.studio_plugin_validation_reviews to service_role;

drop trigger if exists trg_studio_validation_reviews_immutable on public.studio_plugin_validation_reviews;
create trigger trg_studio_validation_reviews_immutable
  before update on public.studio_plugin_validation_reviews
  for each row execute function public.studio_refuse_update();

create or replace function public.studio_validation_reviews_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if not exists (
    select 1 from public.studio_plugin_validation_checks c
     where c.validation_id = new.validation_id and c.check_id = new.check_id and c.status = 'needs_review'
  ) then
    raise exception 'Only a check waiting for review can be reviewed' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.profiles p where p.id = new.reviewer_id and p.role = 'super_admin') then
    raise exception 'Only a Scholera super admin can review a validation' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.studio_plugin_validations v
      join public.studio_plugin_versions ver on ver.id = v.version_id
     where v.id = new.validation_id and ver.published_by = new.reviewer_id
  ) then
    raise exception 'A version''s publisher can''t review its validation' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_validation_reviews_guard on public.studio_plugin_validation_reviews;
create trigger trg_studio_validation_reviews_guard
  before insert on public.studio_plugin_validation_reviews
  for each row execute function public.studio_validation_reviews_guard();

-- ── Skill slot bindings ───────────────────────────────────────────────
-- A manifest v2 version declares skill SLOTS ("the concept this practices"), never a
-- section's skill IDs, so it stays reusable across courses (rule 2.4). Each
-- installation binds its slots to its own section's skills here. Publication checks
-- every slot is bound to a skill that still exists and is visible. A deleted skill
-- removes its binding, which blocks publication until the professor binds again.
create table if not exists public.studio_plugin_skill_bindings (
  installation_id uuid not null references public.studio_plugin_installations(id) on delete cascade,
  slot_key        text not null check (slot_key ~ '^[a-z][a-zA-Z0-9]{0,39}$'),
  skill_id        uuid not null references public.skills(id) on delete cascade,
  institution_id  uuid not null references public.institutions(id) on delete cascade,
  bound_by        uuid not null references public.profiles(id),
  bound_at        timestamptz not null default now(),
  primary key (installation_id, slot_key)
);

create index if not exists idx_studio_skill_bindings_skill on public.studio_plugin_skill_bindings (skill_id);

alter table public.studio_plugin_skill_bindings enable row level security;
revoke all on public.studio_plugin_skill_bindings from public, anon, authenticated;
grant all on public.studio_plugin_skill_bindings to service_role;

-- The skill must be in the installation's own section, and everyone in the
-- installation's institution.
create or replace function public.studio_skill_bindings_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  inst record;
begin
  select i.section_id, i.institution_id into inst
    from public.studio_plugin_installations i where i.id = new.installation_id;
  if not found then
    raise exception 'Studio installation % not found', new.installation_id using errcode = 'foreign_key_violation';
  end if;
  if new.institution_id <> inst.institution_id then
    raise exception 'Tenant mismatch: a binding must be in its installation''s institution' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.skills s where s.id = new.skill_id and s.section_id = inst.section_id) then
    raise exception 'A slot can only be bound to a skill of the installation''s own section' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.profiles p where p.id = new.bound_by and p.institution_id = inst.institution_id) then
    raise exception 'Tenant mismatch: whoever binds must be in the installation''s institution' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_skill_bindings_guard on public.studio_plugin_skill_bindings;
create trigger trg_studio_skill_bindings_guard
  before insert or update on public.studio_plugin_skill_bindings
  for each row execute function public.studio_skill_bindings_guard();

-- ── Sizes before content ──────────────────────────────────────────────
-- The validator reads a version's byte sizes first, so an oversized artifact is refused
-- without ever being loaded into the server's memory.
create or replace function public.studio_version_sizes(p_version_id uuid)
returns table (student_bytes bigint, professor_bytes bigint, source_bytes bigint, source_files bigint)
language sql
stable
set search_path to 'public'
as $$
  select octet_length(v.student_bundle)::bigint,
         octet_length(v.professor_bundle)::bigint,
         octet_length(v.source::text)::bigint,
         (select count(*) from jsonb_object_keys(case when jsonb_typeof(v.source) = 'object' then v.source else '{}'::jsonb end))::bigint
    from public.studio_plugin_versions v
   where v.id = p_version_id
$$;

-- ── Results can't be deleted to reopen a decision ─────────────────────
-- Deleting a failed run or a rejected review would let a version be judged again as if
-- it never was. A delete is refused unless it cascades from a parent's deletion (a
-- version or institution being removed), which runs inside the foreign key's own trigger.
create or replace function public.studio_refuse_direct_delete()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if pg_trigger_depth() < 2 then
    raise exception '% rows can''t be deleted', tg_table_name using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_studio_validations_no_delete on public.studio_plugin_validations;
create trigger trg_studio_validations_no_delete
  before delete on public.studio_plugin_validations
  for each row execute function public.studio_refuse_direct_delete();

drop trigger if exists trg_studio_validation_checks_no_delete on public.studio_plugin_validation_checks;
create trigger trg_studio_validation_checks_no_delete
  before delete on public.studio_plugin_validation_checks
  for each row execute function public.studio_refuse_direct_delete();

drop trigger if exists trg_studio_validation_reviews_no_delete on public.studio_plugin_validation_reviews;
create trigger trg_studio_validation_reviews_no_delete
  before delete on public.studio_plugin_validation_reviews
  for each row execute function public.studio_refuse_direct_delete();

-- ── The gate's check and its write, as one decision ──────────────────
-- The server reads the validator's verdict, then writes. Between the two, another request
-- could change what was checked: activate an unchecked version while the tool is hidden,
-- just as it's being shown, or show the tool just as an unchecked version becomes active.
-- So each write now names the state its check saw, and refuses under the installation's
-- row lock if that state changed. The caller checks again and retries.

drop function if exists public.studio_activate_version(uuid, uuid, uuid, boolean);
create or replace function public.studio_activate_version(
  p_installation_id     uuid,
  p_version_id          uuid,
  p_actor_id            uuid,
  p_approve             boolean,
  p_expected_visibility text
)
returns void
language plpgsql
set search_path to 'public'
as $$
declare
  v_visibility text;
begin
  select student_visibility into v_visibility
    from public.studio_plugin_installations
   where id = p_installation_id and status = 'active'
     for update;
  if not found then
    raise exception 'Studio installation % is not active', p_installation_id using errcode = 'check_violation';
  end if;
  if v_visibility is distinct from p_expected_visibility then
    raise exception 'Studio installation % changed while it was being checked', p_installation_id
      using errcode = 'serialization_failure';
  end if;

  if p_approve then
    insert into public.studio_plugin_approvals
      (installation_id, version_id, project_id, institution_id, approved_by)
    select i.id, p_version_id, i.project_id, i.institution_id, p_actor_id
      from public.studio_plugin_installations i
     where i.id = p_installation_id
    on conflict (installation_id, version_id) do nothing;
  end if;

  update public.studio_plugin_installations
     set current_version_id = p_version_id
   where id = p_installation_id;
end;
$$;

drop function if exists public.studio_set_student_visibility(uuid, uuid, text, uuid);
create or replace function public.studio_set_student_visibility(
  p_installation_id     uuid,
  p_section_id          uuid,
  p_visibility          text,
  p_actor_id            uuid,
  -- Showing only: the version whose verdict the server checked. Ignored when hiding,
  -- which is always allowed.
  p_expected_version_id uuid
)
returns boolean
language plpgsql
set search_path to 'public'
as $$
declare
  v_current text;
  v_status  text;
  v_version uuid;
begin
  if p_visibility is null or p_visibility not in ('hidden', 'visible') then
    raise exception 'Visibility must be hidden or visible' using errcode = 'check_violation';
  end if;

  select student_visibility, status, current_version_id into v_current, v_status, v_version
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
  if p_visibility = 'visible' and v_version is distinct from p_expected_version_id then
    raise exception 'Studio installation % changed while it was being checked', p_installation_id
      using errcode = 'serialization_failure';
  end if;

  update public.studio_plugin_installations
     set student_visibility = p_visibility, visibility_changed_at = now(), visibility_changed_by = p_actor_id
   where id = p_installation_id;
  return true;
end;
$$;

-- ── Execute grants ────────────────────────────────────────────────────
revoke execute on function public.studio_activate_version(uuid, uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.studio_activate_version(uuid, uuid, uuid, boolean, text) to service_role;
revoke execute on function public.studio_set_student_visibility(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.studio_set_student_visibility(uuid, uuid, text, uuid, uuid) to service_role;
revoke execute on function public.studio_validations_guard() from public, anon, authenticated;
revoke execute on function public.studio_validation_checks_guard() from public, anon, authenticated;
revoke execute on function public.studio_validation_reviews_guard() from public, anon, authenticated;
revoke execute on function public.studio_skill_bindings_guard() from public, anon, authenticated;
revoke execute on function public.studio_refuse_direct_delete() from public, anon, authenticated;
revoke execute on function public.studio_version_sizes(uuid) from public, anon, authenticated;
grant execute on function public.studio_version_sizes(uuid) to service_role;
