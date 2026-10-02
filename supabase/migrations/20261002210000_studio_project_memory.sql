-- ============================================================
-- Studio builder: project memory
-- ============================================================
-- Reference: docs/reference/studio-agent-harness.md, "Project memory". Builds on
-- 20261002160000_studio_builder.sql.
--
-- A project remembers the professor's lasting decisions about one tool ("keep the
-- student view extremely simple") across builds. Memory is scoped to the project and
-- nothing wider: no course, section, professor-wide or student memory.
--
-- SERVER-ONLY ON PURPOSE. Row-level security is on with no policy, every client
-- privilege is revoked, and the only way in is the service_role calls through
-- src/lib/studio/db.ts. The model never touches this table: it can only propose, through
-- studio_memory_propose, and a proposal is not memory until the professor approves that
-- exact row through studio_memory_decide.
--
-- Authority, lowest to highest write path:
--   proposed  a model-worded statement plus the professor's own quoted words; inert
--   active    approved by the professor, or typed by the professor in the panel
-- Nothing inferred by the model can become active. A statement's words never change after
-- it is written: an edit is a new row that supersedes the old one.
-- ============================================================

create table if not exists public.studio_plugin_memories (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  project_id     uuid not null references public.studio_plugin_projects(id) on delete cascade,
  owner_id       uuid not null references public.profiles(id) on delete restrict,
  topic          text not null check (topic in (
                   'student_ui', 'professor_ui', 'content_policy', 'accessibility', 'data_collection', 'terminology', 'other')),
  kind           text not null check (kind in ('constraint', 'preference')),
  -- STUDIO_MEMORY_STATEMENT_MAX_CHARS. One line.
  statement      text not null check (char_length(statement) between 1 and 200 and statement !~ '[\n\r\t]'),
  -- 'approved_proposal' rows start as proposals and are inert until approved; the name says
  -- where the words came from. 'professor_edit' rows are typed by the professor.
  origin         text not null check (origin in ('professor_edit', 'approved_proposal')),
  -- The professor's own words, quoted from the run that raised the proposal.
  evidence       text check (evidence is null or char_length(evidence) between 4 and 200),
  source_run_id  uuid references public.studio_plugin_builder_runs(id) on delete set null,
  -- The active memory a proposal asks to replace; superseded when the proposal is approved.
  replaces_id    uuid references public.studio_plugin_memories(id) on delete set null,
  status         text not null check (status in ('proposed', 'active', 'superseded', 'removed', 'rejected')),
  -- Deferred: studio_memory_save supersedes the old row before the new one exists.
  superseded_by  uuid references public.studio_plugin_memories(id) on delete set null deferrable initially deferred,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((origin = 'approved_proposal' and evidence is not null) or (origin = 'professor_edit' and evidence is null))
);

-- One active memory per topic, per project.
create unique index if not exists uq_studio_memories_active_topic
  on public.studio_plugin_memories (project_id, topic) where status = 'active';
-- The context read and the panel: a project's rows by status.
create index if not exists idx_studio_memories_project
  on public.studio_plugin_memories (project_id, status);
-- Foreign keys are not indexed by Postgres.
create index if not exists idx_studio_memories_institution on public.studio_plugin_memories (institution_id);
create index if not exists idx_studio_memories_owner on public.studio_plugin_memories (owner_id);
-- The done card's proposals, the per-run proposal count, and the sweep of stale proposals.
create index if not exists idx_studio_memories_run on public.studio_plugin_memories (source_run_id) where source_run_id is not null;
create index if not exists idx_studio_memories_proposed on public.studio_plugin_memories (created_at) where status = 'proposed';
create index if not exists idx_studio_memories_replaces on public.studio_plugin_memories (replaces_id) where replaces_id is not null;
create index if not exists idx_studio_memories_superseded_by on public.studio_plugin_memories (superseded_by) where superseded_by is not null;

alter table public.studio_plugin_memories enable row level security;
revoke all on public.studio_plugin_memories from public, anon, authenticated;
grant all on public.studio_plugin_memories to service_role;

comment on table public.studio_plugin_memories is
  'Studio builder project memory. Server-only on purpose: RLS on, no policy, client privileges revoked; reached only through the studio_memory_* functions.';

-- ── Guards ────────────────────────────────────────────────────────────

-- A memory belongs to its project's owner and institution, and its source run and the
-- memory it replaces belong to the same project. Whatever the caller passes.
create or replace function public.studio_memories_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if not exists (
    select 1 from public.studio_plugin_projects p
     where p.id = new.project_id and p.institution_id = new.institution_id and p.owner_id = new.owner_id
  ) then
    raise exception 'A memory belongs to its project''s owner and institution' using errcode = 'check_violation';
  end if;
  if new.source_run_id is not null and not exists (
    select 1 from public.studio_plugin_builder_runs r where r.id = new.source_run_id and r.project_id = new.project_id
  ) then
    raise exception 'A memory''s source run must be in its project' using errcode = 'check_violation';
  end if;
  if new.replaces_id is not null and not exists (
    select 1 from public.studio_plugin_memories m where m.id = new.replaces_id and m.project_id = new.project_id
  ) then
    raise exception 'A memory can only replace a memory of its own project' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_memories_guard on public.studio_plugin_memories;
create trigger trg_studio_memories_guard
  before insert on public.studio_plugin_memories
  for each row execute function public.studio_memories_guard();

-- The state machine, enforced by the database whatever the server code does. A memory's
-- words, scope and origin never change. proposed becomes active or rejected; active
-- becomes superseded or removed; nothing else moves. Without a status change only a
-- foreign key may change, and only to null (what ON DELETE SET NULL does).
create or replace function public.studio_memories_transition()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.institution_id <> old.institution_id or new.project_id <> old.project_id or new.owner_id <> old.owner_id
     or new.topic <> old.topic or new.kind <> old.kind or new.statement <> old.statement or new.origin <> old.origin
     or new.evidence is distinct from old.evidence or new.created_at <> old.created_at
     or (new.source_run_id is distinct from old.source_run_id and new.source_run_id is not null)
     or (new.replaces_id is distinct from old.replaces_id and new.replaces_id is not null) then
    raise exception 'A memory''s words and scope can''t change' using errcode = 'check_violation';
  end if;
  if new.status = old.status then
    if new.superseded_by is distinct from old.superseded_by and new.superseded_by is not null then
      raise exception 'A memory is superseded only by a status change' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if not (
    (old.status = 'proposed' and new.status in ('active', 'rejected'))
    or (old.status = 'active' and new.status in ('superseded', 'removed'))
  ) then
    raise exception 'A memory can''t move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;
  if (new.status = 'superseded') <> (new.superseded_by is not null) then
    raise exception 'Only a superseded memory names what replaced it' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_studio_memories_transition on public.studio_plugin_memories;
create trigger trg_studio_memories_transition
  before update on public.studio_plugin_memories
  for each row execute function public.studio_memories_transition();

-- At most 20 active memories per project (STUDIO_MEMORY_MAX_ACTIVE). Serialised per
-- project, so two activations can't both take the last slot.
create or replace function public.studio_memories_cap()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active') then
    perform pg_advisory_xact_lock(hashtextextended('studio_memory:' || new.project_id::text, 0));
    if (select count(*) from public.studio_plugin_memories where project_id = new.project_id and status = 'active' and id <> new.id) >= 20 then
      raise exception 'A project remembers at most 20 decisions' using errcode = 'check_violation', hint = 'memory_full';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_memories_cap on public.studio_plugin_memories;
create trigger trg_studio_memories_cap
  before insert or update on public.studio_plugin_memories
  for each row execute function public.studio_memories_cap();

-- ── Propose: the model's only way in ─────────────────────────────────
-- Records one proposal and its step in one transaction, behind the harness's fence (the
-- slice's claim token, a running run, no Stop). The proposal is inert: status 'proposed'.
-- The professor's words are checked here too, not only in the harness: the evidence must
-- be an exact substring of THIS run's request or of an answer the professor gave in it.
-- Nothing else (course names, skills, code, findings, earlier summaries, the model's own
-- words) is consulted, so none of it can ever be the evidence.
-- Refusals: memory_evidence, memory_limit, memory_replaces, memory_duplicate, memory_full,
-- memory_unavailable, plus the fence's own (fence, cancelled) and limit_tool_calls.
create or replace function public.studio_memory_propose(
  p_run       uuid,
  p_token     uuid,
  p_step      jsonb,
  p_topic     text,
  p_kind      text,
  p_statement text,
  p_evidence  text,
  p_replaces  uuid,
  p_caps      jsonb,
  p_active_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_status text;
  v_id uuid;
  v_active integer;
begin
  begin
    r := public.studio_builder_fenced(p_run, p_token);
  exception when sqlstate 'P0001' then
    return jsonb_build_object('ok', false, 'reason', sqlerrm);
  end;

  if exists (select 1 from public.studio_plugin_builder_steps where run_id = p_run and tool_call_id = p_step ->> 'tool_call_id') then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if r.tool_calls + 1 > (p_caps ->> 'tool_calls')::integer then
    return jsonb_build_object('ok', false, 'reason', 'limit_tool_calls');
  end if;

  if p_evidence is null or p_evidence <> btrim(p_evidence) or char_length(p_evidence) not between 4 and 200 or not (
       strpos(coalesce(r.request, ''), p_evidence) > 0
       or exists (
         select 1 from jsonb_array_elements(r.questions) q
          where jsonb_typeof(q -> 'answer') = 'string' and strpos(q ->> 'answer', p_evidence) > 0)
     ) then
    return jsonb_build_object('ok', false, 'reason', 'memory_evidence');
  end if;

  select status into v_status from public.studio_plugin_projects where id = r.project_id;
  if v_status is distinct from 'active' then
    return jsonb_build_object('ok', false, 'reason', 'memory_unavailable');
  end if;

  if (select count(*) from public.studio_plugin_memories where source_run_id = p_run and origin = 'approved_proposal')
       >= (p_caps ->> 'memory_proposals')::integer then
    return jsonb_build_object('ok', false, 'reason', 'memory_limit');
  end if;

  -- A replacement is the active decision on the same topic, so approving it replaces exactly
  -- what the card shows.
  if p_replaces is not null and not exists (
    select 1 from public.studio_plugin_memories where id = p_replaces and project_id = r.project_id and status = 'active' and topic = p_topic
  ) then
    return jsonb_build_object('ok', false, 'reason', 'memory_replaces');
  end if;

  if exists (
    select 1 from public.studio_plugin_memories
     where project_id = r.project_id and status = 'active' and topic = p_topic and kind = p_kind and statement = p_statement
  ) then
    return jsonb_build_object('ok', false, 'reason', 'memory_duplicate');
  end if;

  select count(*) into v_active from public.studio_plugin_memories where project_id = r.project_id and status = 'active';
  if v_active >= (p_caps ->> 'memory_active')::integer and p_replaces is null and not exists (
    select 1 from public.studio_plugin_memories where project_id = r.project_id and status = 'active' and topic = p_topic
  ) then
    return jsonb_build_object('ok', false, 'reason', 'memory_full');
  end if;

  insert into public.studio_plugin_memories
    (institution_id, project_id, owner_id, topic, kind, statement, origin, evidence, source_run_id, replaces_id, status)
  values
    (r.institution_id, r.project_id, r.owner_id, p_topic, p_kind, p_statement, 'approved_proposal', p_evidence, p_run, p_replaces, 'proposed')
  returning id into v_id;

  perform public.studio_builder_insert_step(p_run, r.institution_id, p_step);
  update public.studio_plugin_builder_runs
     set tool_calls = tool_calls + 1,
         consecutive_errors = 0,
         active_ms = active_ms + greatest(p_active_ms, 0),
         heartbeat_at = now()
   where id = p_run;
  return jsonb_build_object('ok', true, 'duplicate', false, 'memory_id', v_id);
end;
$$;

-- ── Decide: the professor approves or declines one exact proposal ────
-- Bound to the proposal's id, the run that raised it and the owner. Approval activates it
-- and, in the same transaction, supersedes the memory it replaces and any other active
-- memory on its topic, so the old and the new are never both active. A full project
-- (p_max_active) refuses an approval that would leave it over the cap.
-- A proposal older than p_ttl_ms is gone, whether or not the upkeep has rejected it yet.
-- Outcomes: decided, gone, archived, full.
create or replace function public.studio_memory_decide(
  p_memory     uuid,
  p_run        uuid,
  p_owner      uuid,
  p_approve    boolean,
  p_max_active integer,
  p_ttl_ms     integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  m record;
  v_project_status text;
  v_after integer;
begin
  select * into m from public.studio_plugin_memories where id = p_memory;
  if not found or m.owner_id <> p_owner or m.source_run_id is distinct from p_run or m.origin <> 'approved_proposal' then
    return jsonb_build_object('outcome', 'gone');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('studio_memory:' || m.project_id::text, 0));
  select * into m from public.studio_plugin_memories where id = p_memory for update;
  if m.status <> 'proposed' or m.created_at < now() - p_ttl_ms * interval '1 millisecond' then
    return jsonb_build_object('outcome', 'gone');
  end if;
  select status into v_project_status from public.studio_plugin_projects where id = m.project_id;
  if v_project_status is distinct from 'active' then
    return jsonb_build_object('outcome', 'archived');
  end if;

  if not p_approve then
    update public.studio_plugin_memories set status = 'rejected' where id = p_memory;
    return jsonb_build_object('outcome', 'decided', 'decision', 'declined');
  end if;

  select count(*) into v_after from public.studio_plugin_memories
   where project_id = m.project_id and status = 'active' and not (topic = m.topic or id is not distinct from m.replaces_id);
  if v_after + 1 > p_max_active then
    return jsonb_build_object('outcome', 'full');
  end if;

  update public.studio_plugin_memories
     set status = 'superseded', superseded_by = m.id
   where project_id = m.project_id and status = 'active' and (topic = m.topic or id = m.replaces_id);
  update public.studio_plugin_memories set status = 'active' where id = p_memory;
  return jsonb_build_object('outcome', 'decided', 'decision', 'approved');
end;
$$;

-- ── Save: the professor types a decision in the panel ────────────────
-- Adds a decision, or edits one (p_replace names the row being edited). Always a new row:
-- the old one is superseded, so history is never rewritten. No confirmation step; the
-- professor is the author. Outcomes: saved, unchanged, gone, archived, full.
create or replace function public.studio_memory_save(
  p_project    uuid,
  p_owner      uuid,
  p_topic      text,
  p_kind       text,
  p_statement  text,
  p_replace    uuid,
  p_max_active integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  proj record;
  v_id uuid := gen_random_uuid();
  v_same uuid;
  v_after integer;
begin
  select id, institution_id, owner_id, status into proj from public.studio_plugin_projects where id = p_project;
  if not found or proj.owner_id <> p_owner then
    return jsonb_build_object('outcome', 'gone');
  end if;
  if proj.status <> 'active' then
    return jsonb_build_object('outcome', 'archived');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('studio_memory:' || p_project::text, 0));

  if p_replace is not null and not exists (
    select 1 from public.studio_plugin_memories where id = p_replace and project_id = p_project and status = 'active'
  ) then
    return jsonb_build_object('outcome', 'gone');
  end if;

  select id into v_same from public.studio_plugin_memories
   where project_id = p_project and status = 'active' and topic = p_topic and kind = p_kind and statement = p_statement;
  if found then
    return jsonb_build_object('outcome', 'unchanged', 'id', v_same);
  end if;

  select count(*) into v_after from public.studio_plugin_memories
   where project_id = p_project and status = 'active' and not (topic = p_topic or id is not distinct from p_replace);
  if v_after + 1 > p_max_active then
    return jsonb_build_object('outcome', 'full');
  end if;

  update public.studio_plugin_memories
     set status = 'superseded', superseded_by = v_id
   where project_id = p_project and status = 'active' and (topic = p_topic or id = p_replace);
  insert into public.studio_plugin_memories (id, institution_id, project_id, owner_id, topic, kind, statement, origin, status)
  values (v_id, proj.institution_id, p_project, p_owner, p_topic, p_kind, p_statement, 'professor_edit', 'active');
  return jsonb_build_object('outcome', 'saved', 'id', v_id);
end;
$$;

-- ── Remove ───────────────────────────────────────────────────────────
-- A guarded transition: zero rows means it was not the owner's active memory in that
-- project. Outcomes: removed, gone.
create or replace function public.studio_memory_remove(p_memory uuid, p_owner uuid, p_project uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.studio_plugin_memories set status = 'removed'
   where id = p_memory and owner_id = p_owner and project_id = p_project and status = 'active';
  if not found then
    return jsonb_build_object('outcome', 'gone');
  end if;
  return jsonb_build_object('outcome', 'removed');
end;
$$;

-- ── Expire: proposals nobody answered ────────────────────────────────
-- Run from the builder's upkeep. A proposal older than the waiting window is rejected, so
-- it can't be approved weeks later or sit on a done card forever. Bounded; a row another
-- transaction holds is left for the next pass. Returns how many it rejected.
create or replace function public.studio_memory_expire(p_ttl_ms integer, p_limit integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
begin
  with stale as (
    select id from public.studio_plugin_memories
     where status = 'proposed' and created_at < now() - p_ttl_ms * interval '1 millisecond'
     order by created_at
     limit greatest(p_limit, 0)
     for update skip locked
  )
  update public.studio_plugin_memories m set status = 'rejected' from stale where m.id = stale.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ── Execute grants: revoke first, then grant ──────────────────────────
revoke all on function public.studio_memories_guard() from public, anon, authenticated;
revoke all on function public.studio_memories_transition() from public, anon, authenticated;
revoke all on function public.studio_memories_cap() from public, anon, authenticated;
revoke all on function public.studio_memory_propose(uuid, uuid, jsonb, text, text, text, text, uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.studio_memory_decide(uuid, uuid, uuid, boolean, integer, integer) from public, anon, authenticated;
revoke all on function public.studio_memory_save(uuid, uuid, text, text, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.studio_memory_remove(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.studio_memory_expire(integer, integer) from public, anon, authenticated;

grant execute on function public.studio_memory_propose(uuid, uuid, jsonb, text, text, text, text, uuid, jsonb, integer) to service_role;
grant execute on function public.studio_memory_decide(uuid, uuid, uuid, boolean, integer, integer) to service_role;
grant execute on function public.studio_memory_save(uuid, uuid, text, text, text, uuid, integer) to service_role;
grant execute on function public.studio_memory_remove(uuid, uuid, uuid) to service_role;
grant execute on function public.studio_memory_expire(integer, integer) to service_role;
