-- Studio Step 10: the production Stage 2 runner, its quotas, and the minimum-ruleset
-- control (docs/reference/studio-plugin-validator.md).
--
-- No new table. studio_plugin_validations gains the columns that bind a runtime run to
-- how it was dispatched: the runner mode, the SHA-256 of the exact payload the runner was
-- given, the Cloud Run execution that ran it and the image digest it ran. All are written
-- once by studio_validation_dispatch and never change after.
--
-- studio_runtime_admit inserts a runtime run only inside its lane's caps, under a lock, so
-- two concurrent requests can't both take the last slot:
--   professor lane: per institution, 2 at once and 30 a day (only runs that reached a
--                   verdict count toward the day, so a runner outage doesn't use it up)
--   system lane:    revalidation, 1 at a time per institution, outside the daily cap
--   global:         10 at once
-- studio_purpose_admit applies the purpose classifier's daily cap per institution.
-- studio_set_min_accepted_ruleset is the super admin's control; it never lowers the minimum.

-- ── Dispatch binding ──
alter table public.studio_plugin_validations
  add column if not exists runner_mode    text check (runner_mode in ('local', 'cloud')),
  add column if not exists payload_sha256 text check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  add column if not exists execution_name text check (char_length(execution_name) <= 300),
  add column if not exists runner_image   text check (char_length(runner_image) <= 300);

-- The guard of 20261001202323, plus: the callback hash and the dispatch binding are fixed
-- once written.
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
    if new.runner_mode is not null or new.payload_sha256 is not null or new.execution_name is not null or new.runner_image is not null then
      raise exception 'A validation is dispatched after it is created' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status not in ('pending', 'running') then
    raise exception 'A finished validation can''t change' using errcode = 'check_violation';
  end if;
  if new.version_id <> old.version_id or new.institution_id <> old.institution_id or new.stage <> old.stage
     or new.artifact_sha256 <> old.artifact_sha256 or new.ruleset_version <> old.ruleset_version
     or new.validator_version <> old.validator_version or new.runtime_version <> old.runtime_version
     or new.created_at <> old.created_at
     or (old.callback_sha256 is not null and new.callback_sha256 is distinct from old.callback_sha256) then
    raise exception 'A validation''s identity can''t change' using errcode = 'check_violation';
  end if;
  if (old.runner_mode is not null and new.runner_mode is distinct from old.runner_mode)
     or (old.payload_sha256 is not null and new.payload_sha256 is distinct from old.payload_sha256)
     or (old.execution_name is not null and new.execution_name is distinct from old.execution_name)
     or (old.runner_image is not null and new.runner_image is distinct from old.runner_image) then
    raise exception 'A validation''s dispatch can''t change' using errcode = 'check_violation';
  end if;
  if old.status = 'running' and new.status = 'pending' then
    raise exception 'A validation can''t go back to pending' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Records how a pending runtime run was dispatched and moves it to running. Once only:
-- false if the run isn't a pending runtime run, or was already dispatched. A cloud run's
-- nonce is created by the dispatcher (never stored in a job row anyone can read), so its
-- hash arrives here; a local run's was written when the run was created.
create or replace function public.studio_validation_dispatch(
  p_validation      uuid,
  p_mode            text,
  p_payload_sha256  text,
  p_execution       text,
  p_image           text,
  p_callback_sha256 text
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
begin
  update public.studio_plugin_validations
     set runner_mode = p_mode, payload_sha256 = p_payload_sha256, execution_name = p_execution,
         runner_image = p_image, callback_sha256 = coalesce(callback_sha256, p_callback_sha256),
         status = 'running', started_at = coalesce(started_at, now())
   where id = p_validation and stage = 'runtime' and status = 'pending' and runner_mode is null
     and (callback_sha256 is not null or p_callback_sha256 is not null);
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- ── Indexes for the new reads ──
-- Admission counts open runtime runs, and a day of them, per institution; the collector
-- lists open cloud runs; the review queue lists checks waiting for a reviewer, oldest
-- first; the revalidation upkeep reads the newest jobs of one type.
create index if not exists idx_studio_validations_runtime_open
  on public.studio_plugin_validations (institution_id) where stage = 'runtime' and status in ('pending', 'running');
create index if not exists idx_studio_validations_runtime_day
  on public.studio_plugin_validations (institution_id, created_at) where stage = 'runtime';
create index if not exists idx_studio_validation_checks_review
  on public.studio_plugin_validation_checks (created_at) where status = 'needs_review';
create index if not exists idx_background_jobs_type_created
  on public.background_jobs (type, created_at desc);

-- ── Stage 2 admission ──
create or replace function public.studio_runtime_admit(
  p_version           uuid,
  p_institution       uuid,
  p_artifact_sha256   text,
  p_validator_version text,
  p_ruleset           integer,
  p_runtime_version   text,
  p_trigger           text,
  p_requested_by      uuid,
  p_callback_sha256   text,
  p_lane              text,
  p_caps              jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  if p_lane not in ('professor', 'system') then
    raise exception 'Unknown lane' using errcode = 'check_violation';
  end if;
  if (p_lane = 'system') <> (p_trigger = 'ruleset_change') then
    raise exception 'Revalidation runs, and only they, use the system lane' using errcode = 'check_violation';
  end if;
  -- One admission at a time, everywhere: the global cap and each institution's caps are
  -- counted and taken under the same lock.
  perform pg_advisory_xact_lock(hashtext('studio_runtime_admit'));

  if (select count(*) from public.studio_plugin_validations
       where stage = 'runtime' and status in ('pending', 'running')) >= (p_caps ->> 'global_concurrent')::integer then
    return jsonb_build_object('outcome', 'global_busy');
  end if;
  if p_lane = 'professor' then
    if (select count(*) from public.studio_plugin_validations
         where stage = 'runtime' and institution_id = p_institution and trigger <> 'ruleset_change'
           and status in ('pending', 'running')) >= (p_caps ->> 'institution_concurrent')::integer then
      return jsonb_build_object('outcome', 'busy');
    end if;
    -- A day counts runs that reached a verdict, and dispatched runs that ended in error for
    -- any reason but the platform's own (an outage or a runner being updated), so a plugin
    -- built to crash can't spend browser time past the cap.
    if (select count(*) from public.studio_plugin_validations
         where stage = 'runtime' and institution_id = p_institution and trigger <> 'ruleset_change'
           and created_at > now() - interval '24 hours'
           and (status in ('passed', 'failed', 'needs_review')
                or (status = 'error' and runner_mode is not null
                    and coalesce(error ->> 'code', '') not in ('runner_unavailable', 'runner_image_mismatch', 'callback_expired'))))
       >= (p_caps ->> 'institution_daily')::integer then
      return jsonb_build_object('outcome', 'daily');
    end if;
  else
    if (select count(*) from public.studio_plugin_validations
         where stage = 'runtime' and institution_id = p_institution and trigger = 'ruleset_change'
           and status in ('pending', 'running')) >= (p_caps ->> 'system_concurrent')::integer then
      return jsonb_build_object('outcome', 'busy');
    end if;
  end if;

  begin
    insert into public.studio_plugin_validations
      (version_id, institution_id, stage, status, artifact_sha256, validator_version, ruleset_version,
       runtime_version, trigger, requested_by, callback_sha256)
    values (p_version, p_institution, 'runtime', 'pending', p_artifact_sha256, p_validator_version, p_ruleset,
            p_runtime_version, p_trigger, p_requested_by, p_callback_sha256)
    returning id into v_id;
  exception when unique_violation then
    -- A run for this exact version, ruleset and artifact is already active.
    return jsonb_build_object('outcome', 'exists');
  end;
  return jsonb_build_object('outcome', 'admitted', 'id', v_id);
end;
$$;

-- The purpose classifier's daily cap: calls recorded in the usage ledger in the last 24
-- hours, plus static runs still in flight (each may be about to call). Under a lock per
-- institution, so concurrent Saves don't all slip under the cap.
create or replace function public.studio_purpose_admit(p_institution uuid, p_cap integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform pg_advisory_xact_lock(hashtext('studio_purpose_admit:' || p_institution::text));
  return (
    (select count(*) from public.ai_usage_events
      where institution_id = p_institution and feature = 'studio_purpose_check' and created_at > now() - interval '24 hours')
    +
    (select count(*) from public.studio_plugin_validations
      where institution_id = p_institution and stage = 'static' and status = 'running' and created_at > now() - interval '15 minutes')
  ) <= p_cap;
end;
$$;

-- ── The minimum accepted ruleset ──
-- A super admin raises it, never lowers it, and never past the ruleset the deployed code
-- knows. Called through the signed-in user's own client so is_super_admin() sees them,
-- and who changed it is written on the row in the same statement.
alter table public.studio_validator_settings
  add column if not exists updated_by uuid references public.profiles(id) on delete set null;

create or replace function public.studio_set_min_accepted_ruleset(p_ruleset integer, p_max integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old integer;
begin
  if not public.is_super_admin() then
    raise exception 'Only a super admin can change the accepted ruleset' using errcode = 'insufficient_privilege';
  end if;
  select min_accepted_ruleset into v_old from public.studio_validator_settings where id = true for update;
  if v_old is null then
    raise exception 'Validator settings are missing' using errcode = 'no_data_found';
  end if;
  if p_ruleset < v_old then
    return jsonb_build_object('ok', false, 'reason', 'lower', 'previous', v_old);
  end if;
  -- One step at a time. p_max (the release's ruleset) comes from the app, so the step limit
  -- is what bounds a super admin calling this directly: one ruleset per deliberate call.
  if p_ruleset > p_max or p_ruleset > v_old + 1 or p_ruleset < 1 then
    return jsonb_build_object('ok', false, 'reason', 'out_of_range', 'previous', v_old);
  end if;
  update public.studio_validator_settings set min_accepted_ruleset = p_ruleset, updated_at = now(), updated_by = auth.uid() where id = true;
  return jsonb_build_object('ok', true, 'previous', v_old, 'ruleset', p_ruleset, 'changed_by', auth.uid());
end;
$$;

-- The review queue: checks waiting for a reviewer with no review yet, oldest first. The
-- unreviewed filter is here, not in the app, so reviewed checks (whose runs stay
-- needs_review forever) can't crowd out new ones.
create or replace function public.studio_review_queue(p_limit integer)
returns table (validation_id uuid, check_id text)
language sql
stable
set search_path to 'public'
as $$
  select c.validation_id, c.check_id
    from public.studio_plugin_validation_checks c
    join public.studio_plugin_validations v on v.id = c.validation_id
   where c.status = 'needs_review' and v.status = 'needs_review'
     and not exists (
       select 1 from public.studio_plugin_validation_reviews r
        where r.validation_id = c.validation_id and r.check_id = c.check_id)
   order by c.created_at
   limit greatest(1, least(coalesce(p_limit, 100), 500))
$$;

revoke all on function public.studio_validations_guard() from public, anon, authenticated;
revoke all on function public.studio_review_queue(integer) from public, anon, authenticated;
grant execute on function public.studio_review_queue(integer) to service_role;
revoke all on function public.studio_validation_dispatch(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.studio_runtime_admit(uuid, uuid, text, text, integer, text, text, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.studio_purpose_admit(uuid, integer) from public, anon, authenticated;
revoke all on function public.studio_set_min_accepted_ruleset(integer, integer) from public, anon;

grant execute on function public.studio_validation_dispatch(uuid, text, text, text, text, text) to service_role;
grant execute on function public.studio_runtime_admit(uuid, uuid, text, text, integer, text, text, uuid, text, text, jsonb) to service_role;
grant execute on function public.studio_purpose_admit(uuid, integer) to service_role;
grant execute on function public.studio_set_min_accepted_ruleset(integer, integer) to authenticated;
