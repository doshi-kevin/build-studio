-- ============================================================
-- Studio builder: project memory slots
-- ============================================================
-- Reference: docs/reference/studio-agent-harness.md, "Project memory". Builds on
-- 20261002210000_studio_project_memory.sql, which it changes forward only.
--
-- Step 8B kept one active decision per topic. Seven broad topics meant a project held at
-- most seven decisions, and two unrelated decisions on one topic replaced each other: "no
-- AI" and "reviews stay anonymous" are both content_policy. A decision now also has a
-- slot, from a closed list per topic (src/lib/studio/builder/memory.ts, MEMORY_SLOTS),
-- and a project keeps one active decision per (topic, slot). Every topic has a `general`
-- slot.
--
-- Existing rows: every row gets slot `general`. That is deterministic, needs no reading of
-- the words, and keeps uniqueness, because the old index allowed one active row per topic.
-- Ids, statuses, history and timestamps are unchanged.
--
-- Replacement: a proposal may replace the active decision in its own topic and slot, or the
-- topic's `general` decision (where every decision made before slots lives), never one in
-- another specific slot. Checked here in the insert guard as well as in studio_memory_propose.
-- The professor's own edit in the panel may still move a decision to another slot; that is
-- their explicit choice.
-- ============================================================

-- ── The column, backfilled ────────────────────────────────────────────
alter table public.studio_plugin_memories add column if not exists slot_key text;

-- The transition trigger allows this: the status doesn't change and slot_key isn't yet one
-- of the columns it protects. updated_at changes only with a status, so it is kept.
update public.studio_plugin_memories set slot_key = 'general' where slot_key is null;

alter table public.studio_plugin_memories alter column slot_key set not null;

alter table public.studio_plugin_memories drop constraint if exists studio_plugin_memories_slot_check;
alter table public.studio_plugin_memories add constraint studio_plugin_memories_slot_check check ((topic, slot_key) in (
  ('student_ui', 'general'), ('student_ui', 'complexity'), ('student_ui', 'layout'), ('student_ui', 'interaction'), ('student_ui', 'feedback'),
  ('professor_ui', 'general'), ('professor_ui', 'layout'), ('professor_ui', 'analytics'), ('professor_ui', 'workflow'),
  ('content_policy', 'general'), ('content_policy', 'ai_usage'), ('content_policy', 'anonymity'), ('content_policy', 'answer_visibility'),
  ('content_policy', 'grading'), ('content_policy', 'tone'),
  ('accessibility', 'general'), ('accessibility', 'motion'), ('accessibility', 'contrast'), ('accessibility', 'keyboard'),
  ('accessibility', 'readability'), ('accessibility', 'target_size'),
  ('data_collection', 'general'), ('data_collection', 'tracking'), ('data_collection', 'retention'), ('data_collection', 'identity'),
  ('data_collection', 'free_text'),
  ('terminology', 'general'), ('terminology', 'naming'), ('terminology', 'reading_level'),
  ('other', 'general')
));

-- ── One active decision per (project, topic, slot) ────────────────────
drop index if exists public.uq_studio_memories_active_topic;
create unique index if not exists uq_studio_memories_active_slot
  on public.studio_plugin_memories (project_id, topic, slot_key) where status = 'active';

-- ── Guards ────────────────────────────────────────────────────────────

-- As before, plus: the decision a proposal replaces is in the proposal's own topic, in its own
-- slot or in the topic's general slot.
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
    select 1 from public.studio_plugin_memories m
     where m.id = new.replaces_id and m.project_id = new.project_id and m.topic = new.topic and m.slot_key in (new.slot_key, 'general')
  ) then
    raise exception 'A memory can only replace a memory in its own project, topic and slot, or the topic''s general one' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- As before, with slot_key among the columns that never change.
create or replace function public.studio_memories_transition()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.institution_id <> old.institution_id or new.project_id <> old.project_id or new.owner_id <> old.owner_id
     or new.topic <> old.topic or new.slot_key <> old.slot_key or new.kind <> old.kind or new.statement <> old.statement
     or new.origin <> old.origin or new.evidence is distinct from old.evidence or new.created_at <> old.created_at
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

-- ── Propose, now with a slot ──────────────────────────────────────────
-- Same rules as 20261002210000, with the slot taking the topic's place in the replacement,
-- duplicate and full checks. A proposal about AI use can't replace one about anonymity; it
-- can replace the topic's general decision ("Do not use AI." saved before slots existed).
drop function if exists public.studio_memory_propose(uuid, uuid, jsonb, text, text, text, text, uuid, jsonb, integer);

create or replace function public.studio_memory_propose(
  p_run       uuid,
  p_token     uuid,
  p_step      jsonb,
  p_topic     text,
  p_slot      text,
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

  -- A replacement is the active decision in the same topic, in this slot or the general one.
  -- The card lists everything approval would supersede.
  if p_replaces is not null and not exists (
    select 1 from public.studio_plugin_memories
     where id = p_replaces and project_id = r.project_id and status = 'active' and topic = p_topic and slot_key in (p_slot, 'general')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'memory_replaces');
  end if;

  if exists (
    select 1 from public.studio_plugin_memories
     where project_id = r.project_id and status = 'active' and topic = p_topic and slot_key = p_slot and kind = p_kind and statement = p_statement
  ) then
    return jsonb_build_object('ok', false, 'reason', 'memory_duplicate');
  end if;

  select count(*) into v_active from public.studio_plugin_memories where project_id = r.project_id and status = 'active';
  if v_active >= (p_caps ->> 'memory_active')::integer and p_replaces is null and not exists (
    select 1 from public.studio_plugin_memories where project_id = r.project_id and status = 'active' and topic = p_topic and slot_key = p_slot
  ) then
    return jsonb_build_object('ok', false, 'reason', 'memory_full');
  end if;

  insert into public.studio_plugin_memories
    (institution_id, project_id, owner_id, topic, slot_key, kind, statement, origin, evidence, source_run_id, replaces_id, status)
  values
    (r.institution_id, r.project_id, r.owner_id, p_topic, p_slot, p_kind, p_statement, 'approved_proposal', p_evidence, p_run, p_replaces, 'proposed')
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

-- ── Decide: supersedes the decision in the same slot ──────────────────
-- Same signature and outcomes as before. Approval supersedes the active decision in the
-- proposal's own topic and slot, and the one it named (in that slot or the topic's general
-- one), and nothing else on the topic.
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
   where project_id = m.project_id and status = 'active'
     and not ((topic = m.topic and slot_key = m.slot_key) or id is not distinct from m.replaces_id);
  if v_after + 1 > p_max_active then
    return jsonb_build_object('outcome', 'full');
  end if;

  update public.studio_plugin_memories
     set status = 'superseded', superseded_by = m.id
   where project_id = m.project_id and status = 'active'
     and ((topic = m.topic and slot_key = m.slot_key) or id = m.replaces_id);
  update public.studio_plugin_memories set status = 'active' where id = p_memory;
  return jsonb_build_object('outcome', 'decided', 'decision', 'approved');
end;
$$;

-- ── Save, now with a slot ─────────────────────────────────────────────
-- Adds a decision to a (topic, slot), or edits one (p_replace names the row being edited).
-- Supersedes the edited row and whatever is active in the target slot, so a professor can
-- move a decision to another slot; the panel says what that replaces before they save.
drop function if exists public.studio_memory_save(uuid, uuid, text, text, text, uuid, integer);

create or replace function public.studio_memory_save(
  p_project    uuid,
  p_owner      uuid,
  p_topic      text,
  p_slot       text,
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
   where project_id = p_project and status = 'active' and topic = p_topic and slot_key = p_slot and kind = p_kind and statement = p_statement;
  if found then
    -- The same words are already in that slot. Editing another decision onto them retires the
    -- edited one; nothing else changes.
    if p_replace is not null and p_replace <> v_same then
      update public.studio_plugin_memories set status = 'superseded', superseded_by = v_same
       where id = p_replace and project_id = p_project and status = 'active';
      return jsonb_build_object('outcome', 'saved', 'id', v_same);
    end if;
    return jsonb_build_object('outcome', 'unchanged', 'id', v_same);
  end if;

  select count(*) into v_after from public.studio_plugin_memories
   where project_id = p_project and status = 'active'
     and not ((topic = p_topic and slot_key = p_slot) or id is not distinct from p_replace);
  if v_after + 1 > p_max_active then
    return jsonb_build_object('outcome', 'full');
  end if;

  update public.studio_plugin_memories
     set status = 'superseded', superseded_by = v_id
   where project_id = p_project and status = 'active'
     and ((topic = p_topic and slot_key = p_slot) or id = p_replace);
  insert into public.studio_plugin_memories (id, institution_id, project_id, owner_id, topic, slot_key, kind, statement, origin, status)
  values (v_id, proj.institution_id, p_project, p_owner, p_topic, p_slot, p_kind, p_statement, 'professor_edit', 'active');
  return jsonb_build_object('outcome', 'saved', 'id', v_id);
end;
$$;

-- ── Execute grants: revoke first, then grant ──────────────────────────
revoke all on function public.studio_memories_guard() from public, anon, authenticated;
revoke all on function public.studio_memories_transition() from public, anon, authenticated;
revoke all on function public.studio_memory_propose(uuid, uuid, jsonb, text, text, text, text, text, uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.studio_memory_decide(uuid, uuid, uuid, boolean, integer, integer) from public, anon, authenticated;
revoke all on function public.studio_memory_save(uuid, uuid, text, text, text, text, uuid, integer) from public, anon, authenticated;

grant execute on function public.studio_memory_propose(uuid, uuid, jsonb, text, text, text, text, text, uuid, jsonb, integer) to service_role;
grant execute on function public.studio_memory_decide(uuid, uuid, uuid, boolean, integer, integer) to service_role;
grant execute on function public.studio_memory_save(uuid, uuid, text, text, text, text, uuid, integer) to service_role;
