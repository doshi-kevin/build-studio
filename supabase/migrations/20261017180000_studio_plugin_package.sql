-- ============================================================
-- Studio plugin packages and plugin server code
-- ============================================================
-- Reference: docs/reference/studio-plugin-package.md. Builds on 20261002160000_studio_builder
-- and 20261003120000_studio_builder_quality.
--
--   - A draft snapshot holds a package of source files, not exactly the two views: the two
--     view entries plus up to 22 more under views/, shared/ and server/ (STUDIO_PACKAGE_*
--     in src/lib/studio/limits.ts; the checks below are backstops at or above them).
--   - Snapshots and versions gain nullable server_bundle: the plugin's compiled server
--     code, run by the plugin server runtime. Null for every plugin without server code,
--     so nothing existing changes.
--   - The run row's working copy may hold the larger package.
--   - studio_builder_end stores the snapshot's server_bundle.
--
-- Every table here stays SERVER-ONLY ON PURPOSE (RLS on, no policies, client grants
-- revoked, as their creating migrations set). No new table, so no new policy.
-- ============================================================

-- ── Snapshots: a package of files ──
alter table public.studio_plugin_snapshots drop constraint if exists studio_plugin_snapshots_files_check;
alter table public.studio_plugin_snapshots
  add constraint studio_plugin_snapshots_files_check check (
    jsonb_typeof(files) = 'object'
    and octet_length(files::text) <= 262144
    and files ?& array['views/student.tsx', 'views/professor.tsx']
  );

alter table public.studio_plugin_snapshots
  add column if not exists server_bundle text
    check (server_bundle is null or octet_length(server_bundle) between 1 and 262144);

-- The guard of 20261002160000, with the package rule in place of "exactly two files":
-- at most 24 files, each a text value at a package path (builder/paths.ts packagePathProblem).
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
  if (select count(*) from jsonb_object_keys(new.files)) > 24 then
    raise exception 'A snapshot holds at most 24 files' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from jsonb_each(new.files) f
     where jsonb_typeof(f.value) <> 'string'
        or char_length(f.key) > 80
        or f.key !~ '^(views|shared|server)/([a-z][a-z0-9-]{0,30}/)?[A-Za-z][A-Za-z0-9-]{0,40}\.(ts|tsx)$'
        or (f.key ~ '\.tsx$' and f.key !~ '^views/')
  ) then
    raise exception 'A snapshot file has a path or value a package can''t hold' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.studio_snapshots_guard() from public, anon, authenticated;

-- ── Versions: the compiled server code beside the two view bundles ──
-- Versions are immutable (their update-refusing trigger); a new nullable column changes no row.
alter table public.studio_plugin_versions
  add column if not exists server_bundle text
    check (server_bundle is null or octet_length(server_bundle) between 1 and 262144);

-- ── Runs: room for the package in the working copy ──
alter table public.studio_plugin_builder_runs drop constraint if exists studio_plugin_builder_runs_work_check;
alter table public.studio_plugin_builder_runs
  add constraint studio_plugin_builder_runs_work_check
    check (work is null or (jsonb_typeof(work) = 'object' and octet_length(work::text) <= 655360));

-- studio_builder_end of 20261003120000, unchanged except that a commit also stores the
-- snapshot's server_bundle when the harness sent one.
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
    -- A JSON null sample_data or server_bundle is the same as none; anything else that
    -- isn't the right type is refused by the column's check.
    insert into public.studio_plugin_snapshots
      (project_id, hash, institution_id, compiler, manifest, files, student_bundle, professor_bundle, check_summary,
       sample_data, server_bundle, created_by_run)
    values (r.project_id, v_hash, r.institution_id, p_snapshot ->> 'compiler', p_snapshot -> 'manifest', p_snapshot -> 'files',
            p_snapshot ->> 'student_bundle', p_snapshot ->> 'professor_bundle', p_snapshot -> 'check_summary',
            nullif(p_snapshot -> 'sample_data', 'null'::jsonb), p_snapshot ->> 'server_bundle', p_run)
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

revoke all on function public.studio_builder_end(uuid, uuid, text, text, jsonb, jsonb, integer) from public, anon, authenticated;
grant execute on function public.studio_builder_end(uuid, uuid, text, text, jsonb, jsonb, integer) to service_role;
