-- Studio Step 11: builder product quality (docs/designs/studio/studio-builder-quality.md).
--
-- No new table. What changes:
--   - Records gain the staffPerStudent access mode: staff write a record about one
--     student, that student reads only their own. The guard accepts it with an enrolled
--     owner, as it does perStudent, and a staff author on insert.
--   - The student quota counts a record against the student only when the student wrote
--     it (owner_id = author_id). Staff-written records count toward the installation only,
--     so a professor marking attendance can't fill a student's allowance.
--   - Each installation gets a server-only handle_salt. Student handles are
--     HMAC-SHA256(salt, student id), computed in src/lib/studio/handles.ts; the salt never
--     leaves the server and never changes, so handles are stable for the installation's
--     lifetime and unlinkable across installations.
--   - Bridge and runtime version 'v2' (kit v2). v1 stays accepted.
--   - Builder runs gain the reviewing and improving phases.
--   - Snapshots gain nullable sample_data, the builder's synthetic preview records,
--     written by studio_builder_end.
--
-- Every table here is already server-only (RLS on, no policies, client grants revoked);
-- nothing below changes that. Step labels need no change: '^[a-z_]+\.[a-z_]+$' already
-- admits the new ones (sample.written, review.ready, improve.round, run.finishing).

-- ── Records: staffPerStudent ──
-- The guard of 20260930175948, plus: a staffPerStudent record must belong to a student
-- enrolled in the section, like perStudent, and on insert its author must be the section's
-- professor or an active TA (the roles policy.ts lets write). Checked on insert only: the
-- author is a stamp that can't change, and a TA whose term ended must not freeze the
-- records they wrote for the professor who edits them later.
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
  if v_access in ('perStudent', 'staffPerStudent') then
    if new.owner_id is null or not exists (
      select 1 from public.enrollments e
       where e.section_id = new.section_id and e.student_id = new.owner_id and e.status in ('enrolled', 'completed')
    ) then
      raise exception 'A % record must belong to a student enrolled in its section', v_access
        using errcode = 'check_violation';
    end if;
    if v_access = 'staffPerStudent' and tg_op = 'INSERT' and not (
      exists (select 1 from public.course_sections cs where cs.id = new.section_id and cs.professor_id = new.author_id)
      or exists (
        select 1 from public.section_staff s
         where s.section_id = new.section_id and s.staff_id = new.author_id
           and s.role = 'ta' and s.status = 'active' and s.ends_at > now()
      )
    ) then
      raise exception 'A staffPerStudent record is written by the section''s professor or a TA'
        using errcode = 'check_violation';
    end if;
  elsif new.owner_id is not null then
    raise exception 'Only perStudent and staffPerStudent records have an owner' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ── Quota: a student's allowance counts only what the student wrote ──
-- The trigger of 20261001192059 with one change: `owner_id = author_id` decides whether a
-- record counts toward its owner, the same predicate on the insert, update and delete
-- branches. The guard keeps both stamps fixed, so a record never switches sides.
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
    if old.owner_id = old.author_id then
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

  if new.owner_id = new.author_id then
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

-- Recount every student row under the new predicate. Until now an owned record was always
-- the student's own (policy.ts let no one else write one), so this changes nothing on real
-- data; it corrects any row a direct insert counted the old way. Locked so no write lands
-- between this count and the trigger counting the next one.
lock table public.studio_plugin_records in share row exclusive mode;
update public.studio_plugin_student_usage u
   set record_count = c.n, record_bytes = c.b, updated_at = now()
  from (
    select su.installation_id, su.student_id, count(r.id) as n, coalesce(sum(octet_length(r.data::text)), 0) as b
      from public.studio_plugin_student_usage su
      left join public.studio_plugin_records r
        on r.installation_id = su.installation_id and r.owner_id = su.student_id and r.author_id = r.owner_id
     group by su.installation_id, su.student_id
  ) c
 where c.installation_id = u.installation_id and c.student_id = u.student_id
   and (u.record_count, u.record_bytes) is distinct from (c.n, c.b);

-- ── Student handles ──
-- 64 hex characters (256 bits), one value per installation: a volatile default is
-- evaluated per existing row. Never selected for anything a client receives.
alter table public.studio_plugin_installations
  add column if not exists handle_salt text not null
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    check (handle_salt ~ '^[0-9a-f]{64}$');

-- A new salt would turn every handle a plugin stored into an unknown student.
create or replace function public.studio_installations_salt_fixed()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.handle_salt <> old.handle_salt then
    raise exception 'An installation''s handle salt can''t change' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_installations_salt_fixed on public.studio_plugin_installations;
create trigger trg_studio_installations_salt_fixed
  before update of handle_salt on public.studio_plugin_installations
  for each row execute function public.studio_installations_salt_fixed();

-- ── Bridge and runtime v2 ──
alter table public.studio_plugin_versions drop constraint if exists studio_plugin_versions_bridge_version_check;
alter table public.studio_plugin_versions
  add constraint studio_plugin_versions_bridge_version_check check (bridge_version in ('v1', 'v2'));
alter table public.studio_plugin_validations drop constraint if exists studio_plugin_validations_runtime_version_check;
alter table public.studio_plugin_validations
  add constraint studio_plugin_validations_runtime_version_check check (runtime_version in ('v1', 'v2'));

-- ── Builder phases ──
alter table public.studio_plugin_builder_runs drop constraint if exists studio_plugin_builder_runs_phase_check;
alter table public.studio_plugin_builder_runs
  add constraint studio_plugin_builder_runs_phase_check check (phase is null or phase in (
    'understanding', 'planning', 'editing', 'checking', 'repairing', 'reviewing', 'improving'));

-- ── Snapshot sample data ──
-- STUDIO_BUILDER_SAMPLE_MAX_BYTES (24 KiB) of JSON, with room for escaping. Null for
-- snapshots built without it, so their hashes stay as they were.
alter table public.studio_plugin_snapshots
  add column if not exists sample_data jsonb
    check (sample_data is null or (jsonb_typeof(sample_data) = 'object' and octet_length(sample_data::text) <= 32768));

-- studio_builder_end of 20261003003000, unchanged except that a commit also stores the
-- snapshot's sample_data when the harness sent one.
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
  v_material jsonb;
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
    -- A JSON null sample_data is the same as none; anything else that isn't an object is
    -- refused by the column's check.
    insert into public.studio_plugin_snapshots
      (project_id, hash, institution_id, compiler, manifest, files, student_bundle, professor_bundle, check_summary,
       sample_data, created_by_run)
    values (r.project_id, v_hash, r.institution_id, p_snapshot ->> 'compiler', p_snapshot -> 'manifest', p_snapshot -> 'files',
            p_snapshot ->> 'student_bundle', p_snapshot ->> 'professor_bundle', p_snapshot -> 'check_summary',
            nullif(p_snapshot -> 'sample_data', 'null'::jsonb), p_run)
    on conflict (project_id, hash) do nothing;
    -- Provenance: this run's scheduled sources join the project's, then whatever has opened
    -- since is pruned and the newest 96 unopened sources are kept.
    select public.studio_material_prune(
             r.institution_id,
             public.studio_material_union(p.material_sources, r.work -> 'material' -> 'sources', r.section_id),
             96)
      into v_material
      from public.studio_plugin_projects p where p.id = r.project_id;
    -- The old head becomes the undo target. Identical content leaves the target as it was.
    update public.studio_plugin_projects
       set draft_head_hash = v_hash, draft_rev = draft_rev + 1,
           draft_undo_hash = case when draft_head_hash is distinct from v_hash then draft_head_hash else draft_undo_hash end,
           material_sources = v_material -> 'entries',
           material_incomplete = material_incomplete or (v_material ->> 'incomplete')::boolean
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

revoke execute on function public.studio_records_guard() from public, anon, authenticated;
revoke execute on function public.studio_records_track_usage() from public, anon, authenticated;
revoke execute on function public.studio_installations_salt_fixed() from public, anon, authenticated;
revoke all on function public.studio_builder_end(uuid, uuid, text, text, jsonb, jsonb, integer) from public, anon, authenticated;
grant execute on function public.studio_builder_end(uuid, uuid, text, text, jsonb, jsonb, integer) to service_role;
