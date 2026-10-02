-- ============================================================
-- Studio builder: stalled-run upkeep from the job worker's sweep
-- ============================================================
-- Reference: docs/reference/studio-agent-harness.md, "Where a build runs". Builds on
-- 20261002160000_studio_builder.sql.
--
-- Until now only the owner's progress read (studio_builder_tend) recovered a stalled
-- run. With no page open, a run whose slice died stayed 'running' and held one of the
-- school's live slots, and an unanswered card or question expired only on a read or a
-- new start. This moves tend's body into an internal helper, keeps the owner-checked
-- tend for the progress read, and adds a sweep the job worker's kick runs before each
-- drain, so the same drain claims the slices it requeues.
-- ============================================================

-- Reads of the sweep: active runs, oldest first.
create index if not exists idx_studio_builder_runs_active
  on public.studio_plugin_builder_runs (created_at)
  where status in ('queued', 'running', 'waiting_for_approval', 'waiting_for_professor');

-- ── Internal: tend one run ───────────────────────────────────────────
-- The body of studio_builder_tend after its owner check, unchanged. Expires an
-- unanswered card or question, and for a queued or running run whose job is gone or
-- finished, or a running run whose slice stopped heartbeating: cancels it if Stop is
-- pending, fails it as interrupted at the resume limit, else requeues it as a new slice.
-- Requeue clears claim_token, so the old slice's writes are refused. A queued run whose
-- job is pending (not yet claimed) or running is not stalled.
-- Outcomes: none, expired, requeued, failed, cancelled.
-- Not security definer, like studio_builder_close. Unlike it, also revoked from
-- service_role: only the security definer functions below reach it.
create or replace function public.studio_builder_tend_run(
  p_run         uuid,
  p_stale_ms    integer,
  p_max_resumes integer
)
returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  r record;
  v_job_status text;
  v_job uuid;
  stalled boolean;
begin
  select * into r from public.studio_plugin_builder_runs where id = p_run for update;
  if not found then
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

-- ── The owner's progress read ────────────────────────────────────────
-- Same signature and outcomes as before: the owner check, then the shared body.
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
  v_owner uuid;
begin
  select owner_id into v_owner from public.studio_plugin_builder_runs where id = p_run for update;
  if not found or v_owner <> p_owner then
    return jsonb_build_object('outcome', 'none');
  end if;
  return public.studio_builder_tend_run(p_run, p_stale_ms, p_max_resumes);
end;
$$;

-- ── The sweep ────────────────────────────────────────────────────────
-- Tends up to p_limit runs, oldest first, across every school: waiting runs past
-- waiting_until, queued or running runs whose job is gone or finished, and running runs
-- whose heartbeat is missing or stale. SKIP LOCKED: a row a live slice (or a professor's
-- action) holds is left for the next sweep instead of waited on.
-- Returns {none, expired, requeued, failed, cancelled, job_ids}: counts and the new
-- slice jobs, nothing about the runs themselves.
create or replace function public.studio_builder_sweep(
  p_stale_ms    integer,
  p_max_resumes integer,
  p_limit       integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_out jsonb;
  v_counts jsonb := jsonb_build_object('none', 0, 'expired', 0, 'requeued', 0, 'failed', 0, 'cancelled', 0, 'error', 0);
  v_jobs jsonb := '[]'::jsonb;
  v_outcome text;
begin
  for v_id in
    select r.id from public.studio_plugin_builder_runs r
     where (r.status in ('waiting_for_approval', 'waiting_for_professor') and r.waiting_until < now())
        or (r.status in ('queued', 'running') and not exists (
              select 1 from public.background_jobs j where j.id = r.job_id and j.status not in ('done', 'failed')))
        or (r.status = 'running' and (r.heartbeat_at is null
              or r.heartbeat_at < now() - p_stale_ms * interval '1 millisecond'))
     order by r.created_at
     limit greatest(p_limit, 0)
     for update of r skip locked
  loop
    -- One run that can't be tended must not roll back, and so stall, every other school's.
    begin
      v_out := public.studio_builder_tend_run(v_id, p_stale_ms, p_max_resumes);
    exception when others then
      v_out := jsonb_build_object('outcome', 'error');
    end;
    v_outcome := v_out ->> 'outcome';
    v_counts := jsonb_set(v_counts, array[v_outcome], to_jsonb(coalesce((v_counts ->> v_outcome)::integer, 0) + 1));
    if v_out ? 'job_id' then
      v_jobs := v_jobs || jsonb_build_array(v_out -> 'job_id');
    end if;
  end loop;
  return v_counts || jsonb_build_object('job_ids', v_jobs);
end;
$$;

-- ── A reason of its own for the school's daily cap ─────────────────────
-- limit_cost was used for both the run's own $2.50 and the school's 24-hour spend, so a
-- professor stopped by the school's cap was told to ask again in smaller steps.
alter table public.studio_plugin_builder_runs drop constraint if exists studio_plugin_builder_runs_error_code_check;
alter table public.studio_plugin_builder_runs add constraint studio_plugin_builder_runs_error_code_check check (error_code is null or error_code in (
  'limit_turns', 'limit_tool_calls', 'limit_writes', 'limit_bytes', 'limit_active_time', 'limit_slices', 'limit_cost', 'limit_daily_cost',
  'repair_rounds', 'same_finding', 'check_runs',
  'agent_blocked', 'draft_changed', 'studio_paused', 'not_entitled', 'ai_disabled', 'access_lost', 'project_archived',
  'superseded', 'expired',
  'repeated_tool_errors', 'model_unavailable', 'check_timeout', 'interrupted', 'internal'));

-- ── Grants: revoke first, then grant ─────────────────────────────────
-- tend_run is granted to nobody, service_role included: only the definer functions
-- above, running as their owner, call it.
revoke all on function public.studio_builder_tend_run(uuid, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.studio_builder_tend(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.studio_builder_sweep(integer, integer, integer) from public, anon, authenticated;

grant execute on function public.studio_builder_tend(uuid, uuid, integer, integer) to service_role;
grant execute on function public.studio_builder_sweep(integer, integer, integer) to service_role;
