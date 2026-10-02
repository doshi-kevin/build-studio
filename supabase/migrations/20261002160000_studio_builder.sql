-- ============================================================
-- Studio builder: draft snapshots, agent runs and their trajectory
-- ============================================================
-- Reference: docs/reference/studio-agent-harness.md. Builds on the storage, publication,
-- student-quota and validator migrations.
--
-- A professor describes a tool. A Scholera-controlled harness drives a model through
-- nine tools to edit a PRIVATE working copy of the draft, checks it, and on success
-- saves one immutable SNAPSHOT and moves the project's draft pointer to it by
-- compare-and-swap. Nothing here publishes, installs or shows anything to students.
--
--   studio_plugin_snapshots        immutable, content-addressed draft states
--   studio_plugin_builder_runs     one agent run per professor message: lifecycle,
--                                  fence, budgets, working copy, approval card, result
--   studio_plugin_builder_steps    append-only trajectory, one row per observable action
--
-- Every table is SERVER-ONLY ON PURPOSE, like every Studio table: RLS on, no policies,
-- client grants revoked. Builder content (the professor's request, generated source,
-- the trajectory, approvals, cost) is owner-only, and only the trusted server
-- (src/lib/studio/db.ts) reads it, after its own owner check. In particular a TA's
-- section access, which lets them read section-scoped background_jobs rows, reaches
-- none of this: slice jobs carry only ids and no section.
--
-- Every write path is a security definer function granted to service_role only. The
-- functions take the caps they enforce as arguments (src/lib/studio/limits.ts is the
-- one home for limits); the CHECK constraints below are backstops at or above them.
-- ============================================================

-- ── Snapshots ─────────────────────────────────────────────────────────
-- hash = sha256 of the canonical {format, compiler, manifest, files} (src/lib/studio/
-- builder/snapshot.ts). Bundles are derived from those inputs by the trusted compiler,
-- so they are stored but not hashed. A snapshot is only ever written by a run that
-- passed its completion gate, so every snapshot has both bundles.
create table if not exists public.studio_plugin_snapshots (
  project_id       uuid not null references public.studio_plugin_projects(id) on delete cascade,
  hash             text not null check (hash ~ '^[0-9a-f]{64}$'),
  institution_id   uuid not null references public.institutions(id) on delete cascade,
  compiler         text not null check (char_length(compiler) between 1 and 80),
  -- STUDIO_BUILDER_MANIFEST_MAX_BYTES (32 KiB) after stamping and escaping.
  manifest         jsonb not null check (jsonb_typeof(manifest) = 'object' and octet_length(manifest::text) <= 49152),
  -- Only the two view paths; two 32 KiB views after JSON escaping.
  files            jsonb not null check (
                     jsonb_typeof(files) = 'object'
                     and octet_length(files::text) <= 163840
                     and files ?& array['views/student.tsx', 'views/professor.tsx']
                   ),
  -- STUDIO_BUNDLE_MAX_BYTES.
  student_bundle   text not null check (octet_length(student_bundle) between 1 and 262144),
  professor_bundle text not null check (octet_length(professor_bundle) between 1 and 262144),
  check_summary    jsonb not null check (jsonb_typeof(check_summary) = 'object' and octet_length(check_summary::text) <= 16384),
  -- The first run that produced this content. Plain uuid: a run row is history, not a parent.
  created_by_run   uuid not null,
  created_at       timestamptz not null default now(),
  primary key (project_id, hash)
);

alter table public.studio_plugin_snapshots enable row level security;
revoke all on public.studio_plugin_snapshots from public, anon, authenticated;
grant all on public.studio_plugin_snapshots to service_role;

-- Content never changes. DELETE stays possible for the purge path designed with
-- permanent project deletion; no application code deletes a snapshot.
drop trigger if exists trg_studio_snapshots_immutable on public.studio_plugin_snapshots;
create trigger trg_studio_snapshots_immutable
  before update on public.studio_plugin_snapshots
  for each row execute function public.studio_refuse_update();

create or replace function public.studio_snapshots_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if not exists (
    select 1 from public.studio_plugin_projects p where p.id = new.project_id and p.institution_id = new.institution_id
  ) then
    raise exception 'Tenant mismatch: a snapshot must be in its project''s institution' using errcode = 'check_violation';
  end if;
  -- Exactly the two view files: a CHECK can't count keys.
  if (select count(*) from jsonb_object_keys(new.files)) <> 2 then
    raise exception 'A snapshot holds exactly the two view files' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_snapshots_guard on public.studio_plugin_snapshots;
create trigger trg_studio_snapshots_guard
  before insert on public.studio_plugin_snapshots
  for each row execute function public.studio_snapshots_guard();

-- ── The project's draft pointer ──────────────────────────────────────
-- The old `draft` jsonb was reserved for this slice and nothing ever read or wrote it.
-- The draft is now a pointer to one immutable snapshot (null = empty draft), moved only
-- by compare-and-swap on draft_rev. The composite key makes a pointer to another
-- project's snapshot impossible.
alter table public.studio_plugin_projects drop column if exists draft;
alter table public.studio_plugin_projects add column if not exists draft_head_hash text;
alter table public.studio_plugin_projects add column if not exists draft_rev bigint not null default 0 check (draft_rev >= 0);
alter table public.studio_plugin_projects drop constraint if exists studio_projects_draft_head_fk;
alter table public.studio_plugin_projects
  add constraint studio_projects_draft_head_fk
  foreign key (id, draft_head_hash) references public.studio_plugin_snapshots(project_id, hash);
-- One-step undo: the head before the last successful build. Set by studio_builder_end
-- when it moves the pointer, cleared by studio_builder_undo. Null = nothing to undo.
alter table public.studio_plugin_projects add column if not exists draft_undo_hash text;
alter table public.studio_plugin_projects drop constraint if exists studio_projects_draft_undo_fk;
alter table public.studio_plugin_projects
  add constraint studio_projects_draft_undo_fk
  foreign key (id, draft_undo_hash) references public.studio_plugin_snapshots(project_id, hash);

-- ── Which snapshot a version was saved from ──────────────────────────
-- Plain text, not a key: a future snapshot purge must never touch an immutable version.
-- Unique per project, so saving the same snapshot twice is refused.
alter table public.studio_plugin_versions
  add column if not exists source_snapshot_hash text check (source_snapshot_hash ~ '^[0-9a-f]{64}$');
create unique index if not exists uq_studio_versions_source_snapshot
  on public.studio_plugin_versions (project_id, source_snapshot_hash)
  where source_snapshot_hash is not null;

-- ── Runs ──────────────────────────────────────────────────────────────
create table if not exists public.studio_plugin_builder_runs (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.studio_plugin_projects(id) on delete cascade,
  institution_id      uuid not null references public.institutions(id) on delete cascade,
  owner_id            uuid not null references public.profiles(id) on delete restrict,
  -- The course the professor built from: course context and the access re-check on every
  -- turn. Not ownership: projects are owner-scoped and installable in many sections.
  section_id          uuid references public.course_sections(id) on delete set null,
  client_request_id   uuid not null,
  -- STUDIO_BUILDER_REQUEST_MAX_CHARS. Nullable so it can be redacted later.
  request             text check (request is null or char_length(request) <= 4000),
  status              text not null default 'queued' check (status in (
                        'queued', 'running', 'waiting_for_approval', 'waiting_for_professor',
                        'preview_ready', 'completed', 'blocked', 'cancelled', 'budget_exhausted', 'failed')),
  phase               text check (phase is null or phase in ('understanding', 'planning', 'editing', 'checking', 'repairing')),
  error_code          text check (error_code is null or error_code in (
                        'limit_turns', 'limit_tool_calls', 'limit_writes', 'limit_bytes', 'limit_active_time', 'limit_slices', 'limit_cost',
                        'repair_rounds', 'same_finding', 'check_runs',
                        'agent_blocked', 'draft_changed', 'studio_paused', 'not_entitled', 'ai_disabled', 'access_lost', 'project_archived',
                        'superseded', 'expired',
                        'repeated_tool_errors', 'model_unavailable', 'check_timeout', 'interrupted', 'internal')),
  plan                jsonb check (plan is null or (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 8192)),
  -- The private working copy: {work_rev, manifest, files, working_set, last_check}.
  -- STUDIO_BUILDER_WORK_MAX_BYTES. Cleared when the run ends.
  work                jsonb check (work is null or (jsonb_typeof(work) = 'object' and octet_length(work::text) <= 262144)),
  pending_approval    jsonb check (pending_approval is null or (jsonb_typeof(pending_approval) = 'object' and octet_length(pending_approval::text) <= 65536)),
  -- [{id, question, answer, askedAt}], at most STUDIO_BUILDER_MAX_QUESTIONS.
  questions           jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array' and octet_length(questions::text) <= 32768),
  -- When an approval card or question expires (STUDIO_BUILDER_WAITING_TTL_MS).
  waiting_until       timestamptz,
  result              jsonb check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 8192)),
  base_hash           text check (base_hash is null or base_hash ~ '^[0-9a-f]{64}$'),
  base_rev            bigint not null check (base_rev >= 0),
  result_hash         text check (result_hash is null or result_hash ~ '^[0-9a-f]{64}$'),
  model_turns         integer not null default 0 check (model_turns >= 0),
  tool_calls          integer not null default 0 check (tool_calls >= 0),
  writes              integer not null default 0 check (writes >= 0),
  bytes_written       integer not null default 0 check (bytes_written >= 0),
  repair_rounds       integer not null default 0 check (repair_rounds >= 0),
  check_runs          integer not null default 0 check (check_runs >= 0),
  consecutive_errors  integer not null default 0 check (consecutive_errors >= 0),
  input_tokens        bigint not null default 0 check (input_tokens >= 0),
  cached_tokens       bigint not null default 0 check (cached_tokens >= 0),
  output_tokens       bigint not null default 0 check (output_tokens >= 0),
  cost_usd            numeric(12, 6) not null default 0 check (cost_usd >= 0),
  active_ms           bigint not null default 0 check (active_ms >= 0),
  job_id              uuid,
  -- The fence: fresh per claimed slice, cleared at every hand-off and pause. Every
  -- write from a slice must present it, so a slice that lost its claim writes nothing.
  claim_token         uuid,
  slice_no            integer not null default 1 check (slice_no >= 1),
  heartbeat_at        timestamptz,
  resume_count        integer not null default 0 check (resume_count >= 0),
  cancel_requested_at timestamptz,
  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  ended_at            timestamptz,
  unique (owner_id, client_request_id)
);

-- One active run per project (approved decision 1.1).
create unique index if not exists uq_studio_builder_runs_one_active
  on public.studio_plugin_builder_runs (project_id)
  where status in ('queued', 'running', 'waiting_for_approval', 'waiting_for_professor');
-- The institution caps (live runs, daily spend) and the professor's daily count.
create index if not exists idx_studio_builder_runs_institution
  on public.studio_plugin_builder_runs (institution_id, created_at);
create index if not exists idx_studio_builder_runs_owner
  on public.studio_plugin_builder_runs (owner_id, created_at);
-- A project's conversation, newest first.
create index if not exists idx_studio_builder_runs_project
  on public.studio_plugin_builder_runs (project_id, created_at desc);
create index if not exists idx_studio_builder_runs_section
  on public.studio_plugin_builder_runs (section_id);

alter table public.studio_plugin_builder_runs enable row level security;
revoke all on public.studio_plugin_builder_runs from public, anon, authenticated;
grant all on public.studio_plugin_builder_runs to service_role;

create or replace function public.studio_builder_runs_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if not exists (
    select 1 from public.studio_plugin_projects p
     where p.id = new.project_id and p.institution_id = new.institution_id and p.owner_id = new.owner_id
  ) then
    raise exception 'A run belongs to its project''s owner and institution' using errcode = 'check_violation';
  end if;
  if new.section_id is not null and not exists (
    select 1 from public.course_sections cs where cs.id = new.section_id and cs.institution_id = new.institution_id
  ) then
    raise exception 'Tenant mismatch: a run''s section must be in its institution' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_builder_runs_guard on public.studio_plugin_builder_runs;
create trigger trg_studio_builder_runs_guard
  before insert on public.studio_plugin_builder_runs
  for each row execute function public.studio_builder_runs_guard();

-- The run state machine, enforced by the database whatever the server code does.
-- A run never moves to another project, owner or institution. A terminal run never
-- changes again, except that spend recorded after the fact (a fenced-out slice's model
-- call) still adds to its token and cost counters.
create or replace function public.studio_builder_runs_transition()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  terminal constant text[] := array['preview_ready', 'completed', 'blocked', 'cancelled', 'budget_exhausted', 'failed'];
  allowed boolean;
begin
  if new.project_id <> old.project_id or new.owner_id <> old.owner_id or new.institution_id <> old.institution_id
     or new.client_request_id <> old.client_request_id or new.base_rev <> old.base_rev
     or new.base_hash is distinct from old.base_hash or new.created_at <> old.created_at then
    raise exception 'A run''s identity can''t change' using errcode = 'check_violation';
  end if;

  if old.status = any (terminal) then
    if new.status <> old.status or new.work is not null or new.claim_token is not null
       or new.result is distinct from old.result or new.result_hash is distinct from old.result_hash
       or new.error_code is distinct from old.error_code or new.model_turns <> old.model_turns
       or new.tool_calls <> old.tool_calls or new.writes <> old.writes
       or new.input_tokens < old.input_tokens or new.output_tokens < old.output_tokens or new.cost_usd < old.cost_usd then
      raise exception 'A finished run can''t change' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.status = old.status then
    return new;
  end if;

  allowed := case old.status
    when 'queued' then new.status in ('running', 'cancelled', 'failed')
    when 'running' then new.status in ('queued', 'waiting_for_approval', 'waiting_for_professor',
                                       'preview_ready', 'completed', 'blocked', 'cancelled', 'budget_exhausted', 'failed')
    when 'waiting_for_approval' then new.status in ('queued', 'cancelled')
    when 'waiting_for_professor' then new.status in ('queued', 'cancelled')
    else false
  end;
  if not allowed then
    raise exception 'A run can''t move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;
  -- Only a completion gate on a running run reaches the success states, and only with
  -- its result written.
  if new.status in ('preview_ready', 'completed') and new.result is null then
    raise exception 'A finished run needs its result' using errcode = 'check_violation';
  end if;
  if new.status = any (terminal) then
    new.ended_at := coalesce(new.ended_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_builder_runs_transition on public.studio_plugin_builder_runs;
create trigger trg_studio_builder_runs_transition
  before update on public.studio_plugin_builder_runs
  for each row execute function public.studio_builder_runs_transition();

-- ── Steps: the trajectory ────────────────────────────────────────────
-- Observable engineering activity only. Summaries hold paths, byte counts, short
-- content hashes, enum values and reason codes: never file content, prompts, plan text
-- or model reasoning. Append-only.
create table if not exists public.studio_plugin_builder_steps (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.studio_plugin_builder_runs(id) on delete cascade,
  institution_id  uuid not null references public.institutions(id) on delete cascade,
  seq             integer not null check (seq >= 1),
  kind            text not null check (kind in ('model_turn', 'tool', 'check', 'approval', 'answer', 'system')),
  tool            text check (tool is null or tool ~ '^[a-z_]{1,40}$'),
  -- Harness-generated: `${turnSeq}.${index}`, `approval:${proposalId}`, `answer:${id}`, `sys:...`.
  tool_call_id    text not null check (char_length(tool_call_id) between 1 and 80),
  status          text not null check (status in ('done', 'refused', 'error', 'interrupted')),
  label           text not null check (label ~ '^[a-z_]+\.[a-z_]+$'),
  args_summary    jsonb not null default '{}'::jsonb check (jsonb_typeof(args_summary) = 'object' and octet_length(args_summary::text) <= 2048),
  result_summary  jsonb not null default '{}'::jsonb check (jsonb_typeof(result_summary) = 'object' and octet_length(result_summary::text) <= 4096),
  input_tokens    integer check (input_tokens is null or input_tokens >= 0),
  output_tokens   integer check (output_tokens is null or output_tokens >= 0),
  cost_usd        numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  ms              integer not null default 0 check (ms >= 0),
  created_at      timestamptz not null default now(),
  unique (run_id, seq),
  unique (run_id, tool_call_id)
);

alter table public.studio_plugin_builder_steps enable row level security;
revoke all on public.studio_plugin_builder_steps from public, anon, authenticated;
grant all on public.studio_plugin_builder_steps to service_role;

drop trigger if exists trg_studio_builder_steps_immutable on public.studio_plugin_builder_steps;
create trigger trg_studio_builder_steps_immutable
  before update on public.studio_plugin_builder_steps
  for each row execute function public.studio_refuse_update();

create or replace function public.studio_builder_steps_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if not exists (
    select 1 from public.studio_plugin_builder_runs r where r.id = new.run_id and r.institution_id = new.institution_id
  ) then
    raise exception 'Tenant mismatch: a step must be in its run''s institution' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_builder_steps_guard on public.studio_plugin_builder_steps;
create trigger trg_studio_builder_steps_guard
  before insert on public.studio_plugin_builder_steps
  for each row execute function public.studio_builder_steps_guard();

-- ── Spend: one row per model call's cost, written by studio_builder_add_cost ──
-- Every call that cost money gets a row, whatever its run's state: a reply that lands
-- after Stop, after a lost claim or after the run ended still counts toward the daily
-- cap, though its turn is never recorded as a step. Append-only.
create table if not exists public.studio_plugin_builder_spend (
  id             uuid primary key default gen_random_uuid(),
  -- No foreign key: the row outlives its run, so deleting a project never lowers the
  -- day's spend. Only studio_builder_add_cost writes it, from an existing run.
  run_id         uuid not null,
  institution_id uuid not null references public.institutions(id) on delete cascade,
  cost_usd       numeric(12, 6) not null check (cost_usd > 0),
  created_at     timestamptz not null default now()
);

alter table public.studio_plugin_builder_spend enable row level security;
revoke all on public.studio_plugin_builder_spend from public, anon, authenticated;
grant all on public.studio_plugin_builder_spend to service_role;

create index if not exists idx_studio_builder_spend_window
  on public.studio_plugin_builder_spend (institution_id, created_at);
create index if not exists idx_studio_builder_spend_run
  on public.studio_plugin_builder_spend (run_id);

drop trigger if exists trg_studio_builder_spend_immutable on public.studio_plugin_builder_spend;
create trigger trg_studio_builder_spend_immutable
  before update on public.studio_plugin_builder_spend
  for each row execute function public.studio_refuse_update();

-- An institution's builder spend over the last 24 hours, by when it was spent, whenever
-- its run started. The gate before every model call and the start of a build both read
-- it. Runs in flight can overshoot the cap by at most their own budgets.
create or replace function public.studio_builder_spend(p_institution uuid)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(sum(cost_usd), 0) from public.studio_plugin_builder_spend
   where institution_id = p_institution and created_at > now() - interval '24 hours'
$$;

-- ── Internal helpers (not callable by anyone but these functions) ─────

-- Appends one step at the next seq. The caller holds the run row lock, so seq never
-- races. Returns null when that tool_call_id already has a step (a replay).
create or replace function public.studio_builder_insert_step(p_run uuid, p_institution uuid, p_step jsonb)
returns integer
language plpgsql
set search_path to 'public'
as $$
declare
  v_seq integer;
begin
  select coalesce(max(seq), 0) + 1 into v_seq from public.studio_plugin_builder_steps where run_id = p_run;
  insert into public.studio_plugin_builder_steps
    (run_id, institution_id, seq, kind, tool, tool_call_id, status, label, args_summary, result_summary,
     input_tokens, output_tokens, cost_usd, ms)
  values (
    p_run, p_institution, v_seq,
    p_step ->> 'kind', p_step ->> 'tool', p_step ->> 'tool_call_id', p_step ->> 'status', p_step ->> 'label',
    coalesce(p_step -> 'args_summary', '{}'::jsonb), coalesce(p_step -> 'result_summary', '{}'::jsonb),
    (p_step ->> 'input_tokens')::integer, (p_step ->> 'output_tokens')::integer, (p_step ->> 'cost_usd')::numeric,
    coalesce((p_step ->> 'ms')::integer, 0)
  )
  on conflict (run_id, tool_call_id) do nothing;
  if not found then
    return null;
  end if;
  return v_seq;
end;
$$;

-- Queues the run's next slice as a background job. Ids only, no section, so a TA who
-- can read section jobs reads nothing of a build. With no section, the existing
-- background_jobs policy lets the institution's admins read the row: a run id, who
-- started it, when, and a fixed word for how the slice ended (its error column is empty,
-- the reaper's fixed note, or a server configuration error). Never the request, source,
-- plan or cost. This matches what admins already see of institution-level jobs. subject_key keeps each slice its own
-- dedup key: the slice that queues the next one is itself still running.
create or replace function public.studio_builder_queue_slice(p_run uuid)
returns uuid
language plpgsql
set search_path to 'public'
as $$
declare
  r record;
  v_job uuid;
begin
  select id, institution_id, owner_id, slice_no into r from public.studio_plugin_builder_runs where id = p_run;
  insert into public.background_jobs (type, params, status, institution_id, section_id, subject_key, created_by)
  values ('studio_builder_slice', jsonb_build_object('runId', r.id, 'sliceNo', r.slice_no), 'pending',
          r.institution_id, null, r.id::text || ':' || r.slice_no, r.owner_id)
  returning id into v_job;
  update public.studio_plugin_builder_runs set job_id = v_job where id = p_run;
  return v_job;
end;
$$;

-- A minimal result for runs that end in SQL (Stop, expiry, superseding, the resume
-- limit). The harness writes the full result for every other ending.
create or replace function public.studio_builder_sql_result(p_status text, p_reason text)
returns jsonb
language sql
immutable
set search_path to 'public'
as $$
  select jsonb_build_object('format', 'studio-builder-result-v1', 'status', p_status, 'reason', p_reason, 'sqlEnded', true)
$$;

-- Ends a non-running or abandoned run without committing anything.
create or replace function public.studio_builder_close(p_run uuid, p_status text, p_error text, p_event text)
returns void
language plpgsql
set search_path to 'public'
as $$
declare
  v_inst uuid;
begin
  update public.studio_plugin_builder_runs
     set status = p_status, error_code = p_error, work = null, claim_token = null, pending_approval = null,
         waiting_until = null, result = public.studio_builder_sql_result(p_status, coalesce(p_error, 'stopped')),
         ended_at = now()
   where id = p_run
  returning institution_id into v_inst;
  perform public.studio_builder_insert_step(p_run, v_inst, jsonb_build_object(
    'kind', 'system', 'tool_call_id', 'sys:' || p_event, 'status', 'done', 'label', 'run.' || p_status,
    'args_summary', jsonb_build_object('event', p_event), 'result_summary', jsonb_build_object('reason', coalesce(p_error, 'stopped'))));
end;
$$;

-- ── Start a build ─────────────────────────────────────────────────────
-- Everything a start decides happens here, in one transaction under an institution
-- lock, so two concurrent starts can't both pass a cap. A refusal creates nothing.
-- Outcomes: started, existing (same client_request_id), busy (a run is working),
-- waiting (a run waits for the professor and p_replace_run doesn't name it),
-- not_found, limit_daily_runs, limit_live_runs, limit_daily_cost.
create or replace function public.studio_builder_start(
  p_owner             uuid,
  p_institution       uuid,
  p_section           uuid,
  p_project           uuid,
  p_new_slug          text,
  p_new_name          text,
  p_request           text,
  p_client_request_id uuid,
  p_replace_run       uuid,
  p_max_daily_runs    integer,
  p_max_live_runs     integer,
  p_max_daily_cost    numeric
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_project uuid := p_project;
  proj record;
  active record;
  existing record;
  v_run uuid;
  v_job uuid;
  v_head text;
  v_rev bigint := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('studio_builder:' || p_institution::text, 0));

  select id, project_id into existing from public.studio_plugin_builder_runs
   where owner_id = p_owner and client_request_id = p_client_request_id;
  if found then
    return jsonb_build_object('outcome', 'existing', 'run_id', existing.id, 'project_id', existing.project_id);
  end if;

  if v_project is not null then
    select id, institution_id, owner_id, status, draft_head_hash, draft_rev into proj
      from public.studio_plugin_projects where id = v_project for update;
    if not found or proj.institution_id <> p_institution or proj.owner_id <> p_owner or proj.status <> 'active' then
      return jsonb_build_object('outcome', 'not_found');
    end if;
    v_head := proj.draft_head_hash;
    v_rev := proj.draft_rev;

    select id, status, waiting_until into active from public.studio_plugin_builder_runs
     where project_id = v_project and status in ('queued', 'running', 'waiting_for_approval', 'waiting_for_professor')
     for update;
    if found then
      if active.status in ('queued', 'running') then
        return jsonb_build_object('outcome', 'busy', 'run_id', active.id);
      elsif active.waiting_until is not null and active.waiting_until < now() then
        perform public.studio_builder_close(active.id, 'cancelled', 'expired', 'expired');
      elsif p_replace_run is distinct from active.id then
        -- Decision 1.2: never replace a waiting run silently.
        return jsonb_build_object('outcome', 'waiting', 'run_id', active.id, 'status', active.status);
      else
        perform public.studio_builder_close(active.id, 'cancelled', 'superseded', 'superseded');
      end if;
    end if;
  end if;

  if (select count(*) from public.studio_plugin_builder_runs
       where owner_id = p_owner and created_at > now() - interval '24 hours') >= p_max_daily_runs then
    return jsonb_build_object('outcome', 'limit_daily_runs');
  end if;
  if (select count(*) from public.studio_plugin_builder_runs
       where institution_id = p_institution and status in ('queued', 'running')) >= p_max_live_runs then
    return jsonb_build_object('outcome', 'limit_live_runs');
  end if;
  if public.studio_builder_spend(p_institution) >= p_max_daily_cost then
    return jsonb_build_object('outcome', 'limit_daily_cost');
  end if;

  if v_project is null then
    insert into public.studio_plugin_projects (institution_id, owner_id, slug, name)
    values (p_institution, p_owner, p_new_slug, p_new_name)
    returning id into v_project;
  end if;

  insert into public.studio_plugin_builder_runs
    (project_id, institution_id, owner_id, section_id, client_request_id, request, status, base_hash, base_rev, slice_no)
  values (v_project, p_institution, p_owner, p_section, p_client_request_id, p_request, 'queued',
          v_head, v_rev, 1)
  returning id into v_run;
  v_job := public.studio_builder_queue_slice(v_run);
  return jsonb_build_object('outcome', 'started', 'run_id', v_run, 'project_id', v_project, 'job_id', v_job);
end;
$$;

-- ── Claim a slice ─────────────────────────────────────────────────────
-- Only the job whose sliceNo is the run's current slice may claim it. A fresh token is
-- written every time, so the previous holder's writes stop matching. A running run is
-- re-claimed only once its heartbeat is stale, and only up to p_max_resumes times.
create or replace function public.studio_builder_claim(
  p_run         uuid,
  p_job         uuid,
  p_slice       integer,
  p_stale_ms    integer,
  p_max_resumes integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_token uuid := gen_random_uuid();
begin
  select * into r from public.studio_plugin_builder_runs where id = p_run for update;
  if not found or r.slice_no <> p_slice then
    return jsonb_build_object('token', null, 'reason', 'not_this_slice');
  end if;
  if r.status = 'queued' then
    update public.studio_plugin_builder_runs
       set status = 'running', claim_token = v_token, heartbeat_at = now(), job_id = p_job,
           started_at = coalesce(started_at, now()), phase = coalesce(phase, 'understanding')
     where id = p_run;
    perform public.studio_builder_insert_step(p_run, r.institution_id, jsonb_build_object(
      'kind', 'system', 'tool_call_id', 'sys:claim:' || p_slice || ':' || r.resume_count, 'status', 'done',
      'label', case when p_slice = 1 then 'run.started' else 'run.slice' end,
      'args_summary', jsonb_build_object('event', 'claimed'), 'result_summary', jsonb_build_object('slice_no', p_slice)));
    return jsonb_build_object('token', v_token);
  end if;
  if r.status = 'running' and (r.heartbeat_at is null or r.heartbeat_at < now() - p_stale_ms * interval '1 millisecond') then
    if r.resume_count >= p_max_resumes then
      perform public.studio_builder_close(p_run, 'failed', 'interrupted', 'interrupted');
      return jsonb_build_object('token', null, 'reason', 'interrupted');
    end if;
    update public.studio_plugin_builder_runs
       set claim_token = v_token, heartbeat_at = now(), job_id = p_job, resume_count = resume_count + 1
     where id = p_run;
    perform public.studio_builder_insert_step(p_run, r.institution_id, jsonb_build_object(
      'kind', 'system', 'tool_call_id', 'sys:claim:' || p_slice || ':' || (r.resume_count + 1), 'status', 'done',
      'label', 'run.resumed', 'args_summary', jsonb_build_object('event', 'resumed'),
      'result_summary', jsonb_build_object('slice_no', p_slice, 'resume_count', r.resume_count + 1)));
    return jsonb_build_object('token', v_token);
  end if;
  return jsonb_build_object('token', null, 'reason', 'held');
end;
$$;

-- ── Fence helpers for a slice ────────────────────────────────────────

create or replace function public.studio_builder_heartbeat(p_run uuid, p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cancel timestamptz;
begin
  update public.studio_plugin_builder_runs set heartbeat_at = now()
   where id = p_run and status = 'running' and claim_token = p_token
  returning cancel_requested_at into v_cancel;
  if not found then
    return jsonb_build_object('fence_lost', true, 'cancel_requested', false);
  end if;
  return jsonb_build_object('fence_lost', false, 'cancel_requested', v_cancel is not null);
end;
$$;

-- Spend is recorded whatever the run's state: a fenced-out slice's model call still
-- cost money, and both caps must see it (the run's counter and the daily spend rows).
create or replace function public.studio_builder_add_cost(
  p_run    uuid,
  p_input  integer,
  p_cached integer,
  p_output integer,
  p_cost   numeric
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_institution uuid;
begin
  update public.studio_plugin_builder_runs
     set input_tokens = input_tokens + greatest(p_input, 0),
         cached_tokens = cached_tokens + greatest(p_cached, 0),
         output_tokens = output_tokens + greatest(p_output, 0),
         cost_usd = cost_usd + greatest(p_cost, 0)
   where id = p_run
  returning institution_id into v_institution;
  if v_institution is not null and p_cost > 0 then
    insert into public.studio_plugin_builder_spend (run_id, institution_id, cost_usd) values (p_run, v_institution, p_cost);
  end if;
end;
$$;

-- The common fence: a running run, this slice's token, no Stop. Locks the run row.
create or replace function public.studio_builder_fenced(p_run uuid, p_token uuid)
returns public.studio_plugin_builder_runs
language plpgsql
set search_path to 'public'
as $$
declare
  r public.studio_plugin_builder_runs;
begin
  select * into r from public.studio_plugin_builder_runs where id = p_run for update;
  if not found or r.status <> 'running' or r.claim_token is distinct from p_token then
    raise exception 'fence' using errcode = 'P0001', hint = 'fence';
  end if;
  if r.cancel_requested_at is not null then
    raise exception 'cancelled' using errcode = 'P0001', hint = 'cancelled';
  end if;
  return r;
end;
$$;

create or replace function public.studio_builder_record_turn(
  p_run       uuid,
  p_token     uuid,
  p_step      jsonb,
  p_active_ms integer,
  p_refused   boolean
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_seq integer;
begin
  begin
    r := public.studio_builder_fenced(p_run, p_token);
  exception when sqlstate 'P0001' then
    return jsonb_build_object('ok', false, 'reason', sqlerrm);
  end;
  v_seq := public.studio_builder_insert_step(p_run, r.institution_id, p_step);
  update public.studio_plugin_builder_runs
     set model_turns = model_turns + 1,
         consecutive_errors = case when p_refused then consecutive_errors + 1 else consecutive_errors end,
         active_ms = active_ms + greatest(p_active_ms, 0),
         heartbeat_at = now()
   where id = p_run;
  return jsonb_build_object('ok', true, 'seq', v_seq);
end;
$$;

-- Applies one tool or check step and its effects in one transaction: the step row, the
-- working copy (guarded by its revision), the plan, the phase and the counters. The caps
-- are re-checked here, under the run lock, so a stale read in the harness can't pass one.
-- A replayed tool_call_id returns the stored result and applies nothing.
create or replace function public.studio_builder_apply(
  p_run               uuid,
  p_token             uuid,
  p_step              jsonb,
  p_expected_work_rev integer,
  p_work              jsonb,
  p_plan              jsonb,
  p_phase             text,
  p_delta             jsonb,
  p_caps              jsonb,
  p_active_ms         integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_seq integer;
  stored jsonb;
  d_calls integer := coalesce((p_delta ->> 'tool_calls')::integer, 0);
  d_writes integer := coalesce((p_delta ->> 'writes')::integer, 0);
  d_bytes integer := coalesce((p_delta ->> 'bytes_written')::integer, 0);
  d_checks integer := coalesce((p_delta ->> 'check_runs')::integer, 0);
  d_repairs integer := coalesce((p_delta ->> 'repair_rounds')::integer, 0);
  -- error: true adds one to the consecutive-error count, false resets it, absent leaves it
  -- (an interrupted step is neither a success nor an error).
  v_error boolean := (p_delta ->> 'error')::boolean;
begin
  begin
    r := public.studio_builder_fenced(p_run, p_token);
  exception when sqlstate 'P0001' then
    return jsonb_build_object('ok', false, 'reason', sqlerrm);
  end;

  select result_summary into stored from public.studio_plugin_builder_steps
   where run_id = p_run and tool_call_id = p_step ->> 'tool_call_id';
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'result_summary', stored);
  end if;

  if p_work is not null and coalesce((r.work ->> 'work_rev')::integer, -1) <> p_expected_work_rev then
    return jsonb_build_object('ok', false, 'reason', 'stale_work');
  end if;
  if r.tool_calls + d_calls > (p_caps ->> 'tool_calls')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_tool_calls');
  end if;
  if r.writes + d_writes > (p_caps ->> 'writes')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_writes');
  end if;
  if r.bytes_written + d_bytes > (p_caps ->> 'bytes_written')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_bytes');
  end if;
  if r.check_runs + d_checks > (p_caps ->> 'check_runs')::integer then
    return jsonb_build_object('ok', false, 'reason', 'check_runs');
  end if;
  if r.repair_rounds + d_repairs > (p_caps ->> 'repair_rounds')::integer then
    return jsonb_build_object('ok', false, 'reason', 'repair_rounds');
  end if;

  v_seq := public.studio_builder_insert_step(p_run, r.institution_id, p_step);
  update public.studio_plugin_builder_runs
     set work = coalesce(p_work, work),
         plan = coalesce(p_plan, plan),
         phase = coalesce(p_phase, phase),
         tool_calls = tool_calls + d_calls,
         writes = writes + d_writes,
         bytes_written = bytes_written + d_bytes,
         check_runs = check_runs + d_checks,
         repair_rounds = repair_rounds + d_repairs,
         consecutive_errors = case when v_error is null then consecutive_errors
                                   when v_error then consecutive_errors + 1 else 0 end,
         active_ms = active_ms + greatest(p_active_ms, 0),
         heartbeat_at = now()
   where id = p_run;
  return jsonb_build_object('ok', true, 'duplicate', false, 'seq', v_seq);
end;
$$;

-- Pauses the run for the professor: an approval card (p_pending) or a question
-- (p_question). Records the step, the calls the turn named after it as interrupted,
-- and gives up the claim. No job exists while a run waits.
create or replace function public.studio_builder_pause(
  p_run         uuid,
  p_token       uuid,
  p_step        jsonb,
  p_interrupted jsonb,
  p_pending     jsonb,
  p_question    jsonb,
  p_delta       jsonb,
  p_caps        jsonb,
  p_waiting_ms  integer,
  p_active_ms   integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  s jsonb;
  d_writes integer := coalesce((p_delta ->> 'writes')::integer, 0);
  d_bytes integer := coalesce((p_delta ->> 'bytes_written')::integer, 0);
begin
  begin
    r := public.studio_builder_fenced(p_run, p_token);
  exception when sqlstate 'P0001' then
    return jsonb_build_object('ok', false, 'reason', sqlerrm);
  end;
  if (p_pending is null) = (p_question is null) then
    raise exception 'A pause is an approval card or a question' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.studio_plugin_builder_steps where run_id = p_run and tool_call_id = p_step ->> 'tool_call_id') then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if r.tool_calls + 1 > (p_caps ->> 'tool_calls')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_tool_calls');
  end if;
  if r.writes + d_writes > (p_caps ->> 'writes')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_writes');
  end if;
  if r.bytes_written + d_bytes > (p_caps ->> 'bytes_written')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_bytes');
  end if;
  if p_question is not null and jsonb_array_length(r.questions) >= (p_caps ->> 'questions')::integer then
    return jsonb_build_object('ok', false, 'reason', 'question_limit');
  end if;

  perform public.studio_builder_insert_step(p_run, r.institution_id, p_step);
  for s in select * from jsonb_array_elements(coalesce(p_interrupted, '[]'::jsonb)) loop
    perform public.studio_builder_insert_step(p_run, r.institution_id, s);
  end loop;
  update public.studio_plugin_builder_runs
     set status = case when p_pending is not null then 'waiting_for_approval' else 'waiting_for_professor' end,
         pending_approval = p_pending,
         questions = case when p_question is not null then questions || jsonb_build_array(p_question) else questions end,
         waiting_until = now() + p_waiting_ms * interval '1 millisecond',
         tool_calls = tool_calls + 1,
         writes = writes + d_writes,
         bytes_written = bytes_written + d_bytes,
         consecutive_errors = 0,
         active_ms = active_ms + greatest(p_active_ms, 0),
         claim_token = null, job_id = null, heartbeat_at = null
   where id = p_run;
  return jsonb_build_object('ok', true, 'duplicate', false);
end;
$$;

-- The professor approves or declines one exact card. Both the card's proposal id and
-- its delta hash must match the stored card, the card must be unexpired and undecided,
-- and the working copy must still be the revision the card was raised on. Approve also
-- needs room under the institution's live-run cap. The decision is a step keyed by the
-- proposal id, so it can't be replayed onto a later card.
-- Outcomes: decided, gone, expired, busy.
create or replace function public.studio_builder_decide(
  p_run           uuid,
  p_owner         uuid,
  p_proposal_id   uuid,
  p_delta_hash    text,
  p_approve       boolean,
  p_max_live_runs integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_work jsonb;
  v_seq integer;
  v_job uuid;
begin
  select * into r from public.studio_plugin_builder_runs where id = p_run;
  if not found or r.owner_id <> p_owner then
    return jsonb_build_object('outcome', 'gone');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('studio_builder:' || r.institution_id::text, 0));
  select * into r from public.studio_plugin_builder_runs where id = p_run for update;
  if r.status <> 'waiting_for_approval' or r.pending_approval is null
     or r.pending_approval ->> 'proposal_id' is distinct from p_proposal_id::text
     or r.pending_approval ->> 'delta_hash' is distinct from p_delta_hash then
    return jsonb_build_object('outcome', 'gone');
  end if;
  if r.waiting_until is not null and r.waiting_until < now() then
    perform public.studio_builder_close(p_run, 'cancelled', 'expired', 'expired');
    return jsonb_build_object('outcome', 'expired');
  end if;
  if (r.pending_approval ->> 'work_rev')::integer is distinct from (r.work ->> 'work_rev')::integer then
    return jsonb_build_object('outcome', 'gone');
  end if;
  if (select count(*) from public.studio_plugin_builder_runs
       where institution_id = r.institution_id and status in ('queued', 'running')) >= p_max_live_runs then
    return jsonb_build_object('outcome', 'busy');
  end if;

  v_seq := public.studio_builder_insert_step(p_run, r.institution_id, jsonb_build_object(
    'kind', 'approval', 'tool_call_id', 'approval:' || p_proposal_id, 'status', 'done',
    'label', case when p_approve then 'approval.approved' else 'approval.declined' end,
    'args_summary', jsonb_build_object('proposal_id', p_proposal_id, 'delta_hash', p_delta_hash,
                                       'for_call', r.pending_approval ->> 'tool_call_id'),
    'result_summary', jsonb_build_object('decision', case when p_approve then 'approved' else 'declined' end)));
  if v_seq is null then
    return jsonb_build_object('outcome', 'gone');
  end if;

  v_work := r.work;
  if p_approve then
    v_work := jsonb_set(jsonb_set(v_work, '{manifest}', r.pending_approval -> 'proposed_manifest'),
                        '{work_rev}', to_jsonb(coalesce((v_work ->> 'work_rev')::integer, 0) + 1));
    v_work := jsonb_set(v_work, '{delta,approved}', coalesce(v_work #> '{delta,approved}', '[]'::jsonb) || coalesce(r.pending_approval -> 'items', '[]'::jsonb));
    v_work := jsonb_set(v_work, '{delta,direct}', coalesce(v_work #> '{delta,direct}', '[]'::jsonb) || coalesce(r.pending_approval -> 'direct', '[]'::jsonb));
  else
    v_work := jsonb_set(v_work, '{delta,declined}', coalesce(v_work #> '{delta,declined}', '[]'::jsonb) || coalesce(r.pending_approval -> 'items', '[]'::jsonb));
  end if;
  update public.studio_plugin_builder_runs
     set work = v_work, pending_approval = null, waiting_until = null, status = 'queued', slice_no = slice_no + 1
   where id = p_run;
  v_job := public.studio_builder_queue_slice(p_run);
  return jsonb_build_object('outcome', 'decided', 'job_id', v_job);
end;
$$;

-- The professor answers the run's open question. The same run resumes with the answer
-- in its durable state, given room under the institution's live-run cap.
-- Outcomes: answered, gone, expired, busy.
create or replace function public.studio_builder_answer(
  p_run           uuid,
  p_owner         uuid,
  p_question_id   uuid,
  p_answer        text,
  p_max_live_runs integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  last jsonb;
  n integer;
  v_job uuid;
begin
  if p_answer is null or char_length(p_answer) not between 1 and 4000 then
    raise exception 'An answer is 1 to 4000 characters' using errcode = 'check_violation';
  end if;
  select * into r from public.studio_plugin_builder_runs where id = p_run;
  if not found or r.owner_id <> p_owner then
    return jsonb_build_object('outcome', 'gone');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('studio_builder:' || r.institution_id::text, 0));
  select * into r from public.studio_plugin_builder_runs where id = p_run for update;
  if r.status <> 'waiting_for_professor' then
    return jsonb_build_object('outcome', 'gone');
  end if;
  n := jsonb_array_length(r.questions);
  last := r.questions -> (n - 1);
  if n = 0 or last ->> 'id' is distinct from p_question_id::text or (last ->> 'answer') is not null then
    return jsonb_build_object('outcome', 'gone');
  end if;
  if r.waiting_until is not null and r.waiting_until < now() then
    perform public.studio_builder_close(p_run, 'cancelled', 'expired', 'expired');
    return jsonb_build_object('outcome', 'expired');
  end if;
  if (select count(*) from public.studio_plugin_builder_runs
       where institution_id = r.institution_id and status in ('queued', 'running')) >= p_max_live_runs then
    return jsonb_build_object('outcome', 'busy');
  end if;
  if public.studio_builder_insert_step(p_run, r.institution_id, jsonb_build_object(
       'kind', 'answer', 'tool_call_id', 'answer:' || p_question_id, 'status', 'done', 'label', 'question.answered',
       'args_summary', jsonb_build_object('question_id', p_question_id),
       'result_summary', jsonb_build_object('chars', char_length(p_answer)))) is null then
    return jsonb_build_object('outcome', 'gone');
  end if;
  update public.studio_plugin_builder_runs
     set questions = jsonb_set(questions, array[(n - 1)::text, 'answer'], to_jsonb(p_answer)),
         waiting_until = null, status = 'queued', slice_no = slice_no + 1
   where id = p_run;
  v_job := public.studio_builder_queue_slice(p_run);
  return jsonb_build_object('outcome', 'answered', 'job_id', v_job);
end;
$$;

-- A slice that reached its time budget hands the run to the next slice.
create or replace function public.studio_builder_handoff(
  p_run        uuid,
  p_token      uuid,
  p_max_slices integer,
  p_active_ms  integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_job uuid;
begin
  begin
    r := public.studio_builder_fenced(p_run, p_token);
  exception when sqlstate 'P0001' then
    return jsonb_build_object('outcome', sqlerrm);
  end;
  update public.studio_plugin_builder_runs set active_ms = active_ms + greatest(p_active_ms, 0) where id = p_run;
  if r.slice_no >= p_max_slices then
    perform public.studio_builder_close(p_run, 'budget_exhausted', 'limit_slices', 'ended');
    return jsonb_build_object('outcome', 'ended');
  end if;
  perform public.studio_builder_insert_step(p_run, r.institution_id, jsonb_build_object(
    'kind', 'system', 'tool_call_id', 'sys:handoff:' || r.slice_no, 'status', 'done', 'label', 'run.slice',
    'args_summary', jsonb_build_object('event', 'handoff'), 'result_summary', jsonb_build_object('slice_no', r.slice_no)));
  update public.studio_plugin_builder_runs
     set status = 'queued', slice_no = slice_no + 1, claim_token = null, heartbeat_at = null
   where id = p_run;
  v_job := public.studio_builder_queue_slice(p_run);
  return jsonb_build_object('outcome', 'queued', 'job_id', v_job);
end;
$$;

-- Every terminal write from a slice. With p_snapshot, it commits: the project row is
-- locked (the same lock a publish takes), the draft must still be at the run's base
-- revision, the snapshot is inserted (identical content dedupes), then the pointer moves
-- and the revision increments. A moved draft is never overwritten: the run ends blocked
-- (draft_changed) and commits nothing. A Stop that arrived first wins: the run ends
-- cancelled and commits nothing.
-- Outcomes: ended, conflict, cancelled, fence.
create or replace function public.studio_builder_end(
  p_run        uuid,
  p_token      uuid,
  p_status     text,
  p_error_code text,
  p_result     jsonb,
  p_snapshot   jsonb,
  p_active_ms  integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_rev bigint;
  v_hash text;
begin
  -- A commit locks the project row before the run row: the order studio_builder_start and
  -- studio_builder_undo take them in, so a start racing a commit waits instead of deadlocking.
  if p_snapshot is not null then
    perform 1 from public.studio_plugin_projects
     where id = (select project_id from public.studio_plugin_builder_runs where id = p_run)
       for update;
  end if;
  select * into r from public.studio_plugin_builder_runs where id = p_run for update;
  if not found or r.status <> 'running' or r.claim_token is distinct from p_token then
    return jsonb_build_object('outcome', 'fence');
  end if;
  update public.studio_plugin_builder_runs set active_ms = active_ms + greatest(p_active_ms, 0) where id = p_run;
  if r.cancel_requested_at is not null and p_status <> 'cancelled' then
    perform public.studio_builder_close(p_run, 'cancelled', null, 'cancelled');
    return jsonb_build_object('outcome', 'cancelled');
  end if;

  if p_snapshot is not null then
    v_hash := p_snapshot ->> 'hash';
    select draft_rev into v_rev from public.studio_plugin_projects where id = r.project_id for update;
    if v_rev <> r.base_rev then
      update public.studio_plugin_builder_runs
         set status = 'blocked', error_code = 'draft_changed', work = null, claim_token = null,
             result = public.studio_builder_sql_result('blocked', 'draft_changed')
       where id = p_run;
      perform public.studio_builder_insert_step(p_run, r.institution_id, jsonb_build_object(
        'kind', 'system', 'tool_call_id', 'sys:ended', 'status', 'done', 'label', 'run.blocked',
        'args_summary', jsonb_build_object('event', 'ended'), 'result_summary', jsonb_build_object('reason', 'draft_changed')));
      return jsonb_build_object('outcome', 'conflict');
    end if;
    insert into public.studio_plugin_snapshots
      (project_id, hash, institution_id, compiler, manifest, files, student_bundle, professor_bundle, check_summary, created_by_run)
    values (r.project_id, v_hash, r.institution_id, p_snapshot ->> 'compiler', p_snapshot -> 'manifest', p_snapshot -> 'files',
            p_snapshot ->> 'student_bundle', p_snapshot ->> 'professor_bundle', p_snapshot -> 'check_summary', p_run)
    on conflict (project_id, hash) do nothing;
    -- The old head becomes the undo target. Identical content leaves the target as it was.
    update public.studio_plugin_projects
       set draft_head_hash = v_hash, draft_rev = draft_rev + 1,
           draft_undo_hash = case when draft_head_hash is distinct from v_hash then draft_head_hash else draft_undo_hash end
     where id = r.project_id and draft_rev = r.base_rev;
  end if;

  update public.studio_plugin_builder_runs
     set status = p_status, error_code = p_error_code, result = p_result, result_hash = v_hash,
         work = null, claim_token = null, pending_approval = null, waiting_until = null
   where id = p_run;
  perform public.studio_builder_insert_step(p_run, r.institution_id, jsonb_build_object(
    'kind', 'system', 'tool_call_id', 'sys:ended', 'status', 'done', 'label', 'run.' || p_status,
    'args_summary', jsonb_build_object('event', case when v_hash is null then 'ended' else 'committed' end),
    'result_summary', jsonb_build_object('reason', coalesce(p_error_code, p_status))));
  return jsonb_build_object('outcome', 'ended');
end;
$$;

-- Stop (decision 1.13). A run that isn't working right now ends at once. A working run
-- whose slice is gone (stale heartbeat, or its job finished) ends at once too. A live
-- slice gets a durable flag that every gate and write reads, and ends itself.
-- Nothing is committed; the run row and its trajectory stay.
create or replace function public.studio_builder_stop(p_run uuid, p_owner uuid, p_stale_ms integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_job_status text;
begin
  select * into r from public.studio_plugin_builder_runs where id = p_run for update;
  if not found or r.owner_id <> p_owner then
    return jsonb_build_object('outcome', 'gone');
  end if;
  if r.status in ('queued', 'waiting_for_approval', 'waiting_for_professor') then
    perform public.studio_builder_close(p_run, 'cancelled', null, 'cancelled');
    return jsonb_build_object('outcome', 'cancelled');
  end if;
  if r.status = 'running' then
    select status into v_job_status from public.background_jobs where id = r.job_id;
    if r.heartbeat_at is null or r.heartbeat_at < now() - p_stale_ms * interval '1 millisecond'
       or v_job_status is null or v_job_status in ('done', 'failed') then
      perform public.studio_builder_close(p_run, 'cancelled', null, 'cancelled');
      return jsonb_build_object('outcome', 'cancelled');
    end if;
    update public.studio_plugin_builder_runs set cancel_requested_at = coalesce(cancel_requested_at, now()) where id = p_run;
    return jsonb_build_object('outcome', 'requested');
  end if;
  return jsonb_build_object('outcome', 'finished', 'status', r.status);
end;
$$;

-- Lazy upkeep on the owner's own run, from the progress read: expires an unanswered
-- card or question, and requeues an orphaned or stalled run (its job is gone or
-- finished, or its slice stopped heartbeating), up to the resume limit.
-- Outcomes: none, expired, requeued, failed.
create or replace function public.studio_builder_tend(
  p_run         uuid,
  p_owner       uuid,
  p_stale_ms    integer,
  p_max_resumes integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_job_status text;
  v_job uuid;
  stalled boolean;
begin
  select * into r from public.studio_plugin_builder_runs where id = p_run for update;
  if not found or r.owner_id <> p_owner then
    return jsonb_build_object('outcome', 'none');
  end if;
  if r.status in ('waiting_for_approval', 'waiting_for_professor') and r.waiting_until < now() then
    perform public.studio_builder_close(p_run, 'cancelled', 'expired', 'expired');
    return jsonb_build_object('outcome', 'expired');
  end if;
  if r.status not in ('queued', 'running') then
    return jsonb_build_object('outcome', 'none');
  end if;
  select status into v_job_status from public.background_jobs where id = r.job_id;
  stalled := v_job_status is null or v_job_status in ('done', 'failed')
             or (r.status = 'running' and (r.heartbeat_at is null
                 or r.heartbeat_at < now() - p_stale_ms * interval '1 millisecond'));
  if not stalled then
    return jsonb_build_object('outcome', 'none');
  end if;
  if r.cancel_requested_at is not null then
    perform public.studio_builder_close(p_run, 'cancelled', null, 'cancelled');
    return jsonb_build_object('outcome', 'cancelled');
  end if;
  if r.resume_count >= p_max_resumes then
    perform public.studio_builder_close(p_run, 'failed', 'interrupted', 'interrupted');
    return jsonb_build_object('outcome', 'failed');
  end if;
  update public.studio_plugin_builder_runs
     set status = 'queued', slice_no = slice_no + 1, resume_count = resume_count + 1,
         claim_token = null, heartbeat_at = null
   where id = p_run;
  perform public.studio_builder_insert_step(p_run, r.institution_id, jsonb_build_object(
    'kind', 'system', 'tool_call_id', 'sys:recover:' || (r.resume_count + 1), 'status', 'done', 'label', 'run.resumed',
    'args_summary', jsonb_build_object('event', 'recovered'), 'result_summary', jsonb_build_object('resume_count', r.resume_count + 1)));
  v_job := public.studio_builder_queue_slice(p_run);
  return jsonb_build_object('outcome', 'requeued', 'job_id', v_job);
end;
$$;

-- ── Undo the last build ──────────────────────────────────────────────
-- Moves the draft pointer back to the head before the last successful build, by
-- compare-and-swap on the head and revision the professor was looking at. Deletes
-- nothing and touches no version: the newer snapshot stays in history. One step only:
-- the undo target is cleared, so the next undo waits for the next successful build.
-- Takes the project row lock, as studio_builder_start does, so an undo and a start
-- serialize: whichever is second sees the other. Never undoes behind an active run.
-- Outcomes: undone, not_owner, archived, busy, draft_changed, unavailable.
create or replace function public.studio_builder_undo(
  p_project       uuid,
  p_actor         uuid,
  p_expected_head text,
  p_expected_rev  bigint
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  proj record;
begin
  select id, owner_id, status, draft_head_hash, draft_undo_hash, draft_rev into proj
    from public.studio_plugin_projects where id = p_project for update;
  if not found or proj.owner_id <> p_actor then
    return jsonb_build_object('outcome', 'not_owner');
  end if;
  if proj.status <> 'active' then
    return jsonb_build_object('outcome', 'archived');
  end if;
  if exists (
    select 1 from public.studio_plugin_builder_runs
     where project_id = p_project and status in ('queued', 'running', 'waiting_for_approval', 'waiting_for_professor')
  ) then
    return jsonb_build_object('outcome', 'busy');
  end if;
  if proj.draft_head_hash is distinct from p_expected_head or proj.draft_rev <> p_expected_rev then
    return jsonb_build_object('outcome', 'draft_changed');
  end if;
  if proj.draft_undo_hash is null then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  update public.studio_plugin_projects
     set draft_head_hash = proj.draft_undo_hash, draft_undo_hash = null, draft_rev = draft_rev + 1
   where id = p_project;
  return jsonb_build_object('outcome', 'undone', 'head', proj.draft_undo_hash, 'rev', proj.draft_rev + 1);
end;
$$;


-- ── Execute grants ────────────────────────────────────────────────────
-- Every function: no client role may call it. The server's entry points are then granted
-- to service_role alone. (Revokes first, grants after.)
revoke all on function public.studio_snapshots_guard() from public, anon, authenticated;
revoke all on function public.studio_builder_runs_guard() from public, anon, authenticated;
revoke all on function public.studio_builder_runs_transition() from public, anon, authenticated;
revoke all on function public.studio_builder_steps_guard() from public, anon, authenticated;
revoke all on function public.studio_builder_insert_step(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.studio_builder_queue_slice(uuid) from public, anon, authenticated;
revoke all on function public.studio_builder_sql_result(text, text) from public, anon, authenticated;
revoke all on function public.studio_builder_close(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.studio_builder_fenced(uuid, uuid) from public, anon, authenticated;
revoke all on function public.studio_builder_start(uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, integer, integer, numeric) from public, anon, authenticated;
revoke all on function public.studio_builder_claim(uuid, uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.studio_builder_heartbeat(uuid, uuid) from public, anon, authenticated;
revoke all on function public.studio_builder_add_cost(uuid, integer, integer, integer, numeric) from public, anon, authenticated;
revoke all on function public.studio_builder_record_turn(uuid, uuid, jsonb, integer, boolean) from public, anon, authenticated;
revoke all on function public.studio_builder_apply(uuid, uuid, jsonb, integer, jsonb, jsonb, text, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function public.studio_builder_pause(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer, integer) from public, anon, authenticated;
revoke all on function public.studio_builder_decide(uuid, uuid, uuid, text, boolean, integer) from public, anon, authenticated;
revoke all on function public.studio_builder_answer(uuid, uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.studio_builder_handoff(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.studio_builder_end(uuid, uuid, text, text, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function public.studio_builder_stop(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.studio_builder_tend(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.studio_builder_spend(uuid) from public, anon, authenticated;
revoke all on function public.studio_builder_undo(uuid, uuid, text, bigint) from public, anon, authenticated;

grant execute on function public.studio_builder_start(uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, integer, integer, numeric) to service_role;
grant execute on function public.studio_builder_claim(uuid, uuid, integer, integer, integer) to service_role;
grant execute on function public.studio_builder_heartbeat(uuid, uuid) to service_role;
grant execute on function public.studio_builder_add_cost(uuid, integer, integer, integer, numeric) to service_role;
grant execute on function public.studio_builder_record_turn(uuid, uuid, jsonb, integer, boolean) to service_role;
grant execute on function public.studio_builder_apply(uuid, uuid, jsonb, integer, jsonb, jsonb, text, jsonb, jsonb, integer) to service_role;
grant execute on function public.studio_builder_pause(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer, integer) to service_role;
grant execute on function public.studio_builder_decide(uuid, uuid, uuid, text, boolean, integer) to service_role;
grant execute on function public.studio_builder_answer(uuid, uuid, uuid, text, integer) to service_role;
grant execute on function public.studio_builder_handoff(uuid, uuid, integer, integer) to service_role;
grant execute on function public.studio_builder_end(uuid, uuid, text, text, jsonb, jsonb, integer) to service_role;
grant execute on function public.studio_builder_stop(uuid, uuid, integer) to service_role;
grant execute on function public.studio_builder_tend(uuid, uuid, integer, integer) to service_role;
grant execute on function public.studio_builder_spend(uuid) to service_role;
grant execute on function public.studio_builder_undo(uuid, uuid, text, bigint) to service_role;
