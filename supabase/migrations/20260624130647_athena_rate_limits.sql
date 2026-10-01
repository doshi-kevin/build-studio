-- ============================================================
-- Athena per-model daily rate limits (Issue #268)
-- ============================================================
-- One row per (institution, user, model) tracking accepted user messages within
-- a rolling window. The per-model cap and the window length live ONLY in code
-- (src/lib/ai/professor-assistant/models.ts) and are passed into the increment
-- RPC as parameters — no number is hardcoded here, so tuning a cap is a one-line
-- code edit. Provider-agnostic: model_id is a generic text key (no Gemini- or
-- Google-specific column), so a future provider's model is just new rows.
--
-- The counter is a SEPARATE enforcement primitive from the cost ledger
-- (ai_usage_events); it does not touch recordAiUsage. One accepted user message
-- = one increment here = one recordAiUsage row.
--
-- Server-only writes: the increment goes through athena_increment_rate_limit
-- (security definer) and reads happen via the service-role admin client after
-- the route's auth checks. The SELECT policy below scopes a direct client read
-- to the owning user only (defense in depth); there is NO client write policy,
-- so PostgREST callers can never inflate a counter.
-- ============================================================

create table if not exists public.athena_rate_limits (
  id             uuid        primary key default gen_random_uuid(),
  institution_id uuid        not null references public.institutions(id) on delete cascade,
  user_id        uuid        not null references public.profiles(id) on delete cascade,
  -- Generic provider/model key (e.g. 'gemini-pro', 'gemini-flash', or a future
  -- provider's id). Matches AthenaModelDef.id in the registry.
  model_id       text        not null,
  -- Start of the current rolling window; reset to now() on first use after lapse.
  window_start   timestamptz not null default now(),
  -- Accepted user messages in the current window.
  request_count  integer     not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Atomic increment keys on this; institution_id is part of the key so the
  -- ON CONFLICT upsert is tenant-scoped (data-access.md).
  constraint athena_rate_limits_unique unique (institution_id, user_id, model_id)
);

-- Status reads filter by (institution_id, user_id); the unique index above
-- already serves that prefix, so no extra index is needed. window_start is only
-- ever read for rows already located by the unique key, not filtered on.

comment on table public.athena_rate_limits is
  'Per-(institution,user,model) rolling-window request counter enforcing Athena daily caps. Caps/window live in code (models.ts), passed to athena_increment_rate_limit. Server-only writes via the security-definer RPC; SELECT scoped to the owning user.';

-- RLS: enabled in the same migration. No write policy for authenticated/anon →
-- clients cannot write (writes go through the security-definer RPC / admin
-- client). One read-only policy scopes a direct client read to the owner's own
-- rows; auth.uid() is wrapped in a scalar subquery per the auth_rls_initplan
-- advisor (data-access.md).
--
-- Scope is owner-only (user_id), DELIBERATELY not also institution_id: a user
-- belongs to exactly one institution, so user_id = auth.uid() is STRICTLY
-- tighter than an institution filter (it returns only the caller's own counter
-- rows, never a peer's). institution_id is still NOT NULL on every row + part of
-- the unique key for tenant-safe writes. This matches the established pattern for
-- the sibling per-user Athena tables (athena_conversations / athena_messages in
-- 20260616232126_athena_chat_persistence), which scope the same way — adding an
-- institution subquery here would be a novel pattern with no precedent and no
-- security gain over owner-only.
alter table public.athena_rate_limits enable row level security;

create policy "athena_rate_limits: owner read"
  on public.athena_rate_limits
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ── Atomic increment-if-under-cap ──────────────────────────────────────
-- ONE guarded statement does the whole reserve: INSERT … ON CONFLICT … DO
-- UPDATE … WHERE (window lapsed OR still under cap). Two concurrent sends serialize
-- on the conflicting row, so they can NEVER both push request_count past p_cap.
--   • New row              → inserted at count 1, accepted.
--   • Window lapsed        → WHERE true; the CASE resets window_start = now() and
--                            count = 1, accepted (limits reset with no cron).
--   • In window, under cap → count += 1, accepted.
--   • In window, at cap    → WHERE false → no update, nothing RETURNING → rejected.
-- The cap (p_cap) and window (p_window_hours) are passed in from code — the SQL
-- hardcodes neither. security definer so it writes regardless of RLS; execute is
-- revoked from anon/authenticated so only the service-role admin client (which
-- passes the route's verified user/institution ids) can call it — a direct caller
-- can't inflate another user's counter.
create or replace function public.athena_increment_rate_limit(
  p_institution_id uuid,
  p_user_id        uuid,
  p_model_id       text,
  p_cap            integer,
  p_window_hours   integer
) returns table (accepted boolean, request_count integer, window_start timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count  integer;
  v_window timestamptz;
begin
  insert into public.athena_rate_limits as r (institution_id, user_id, model_id, window_start, request_count)
  values (p_institution_id, p_user_id, p_model_id, now(), 1)
  on conflict (institution_id, user_id, model_id) do update
  set
    request_count = case
      when r.window_start <= now() - make_interval(hours => p_window_hours) then 1
      else r.request_count + 1
    end,
    window_start = case
      when r.window_start <= now() - make_interval(hours => p_window_hours) then now()
      else r.window_start
    end,
    updated_at = now()
  where
    r.window_start <= now() - make_interval(hours => p_window_hours)  -- window lapsed → reset
    or r.request_count < p_cap                                         -- still under cap
  returning r.request_count, r.window_start into v_count, v_window;

  if v_count is null then
    -- Conflict row exists but the WHERE rejected the update → at cap. Report the
    -- current (unchanged) state so the caller can surface resets_at.
    select r.request_count, r.window_start into v_count, v_window
    from public.athena_rate_limits r
    where r.institution_id = p_institution_id
      and r.user_id = p_user_id
      and r.model_id = p_model_id;
    return query select false, v_count, v_window;
  else
    return query select true, v_count, v_window;
  end if;
end;
$$;

revoke all on function public.athena_increment_rate_limit(uuid, uuid, text, integer, integer) from public;
grant execute on function public.athena_increment_rate_limit(uuid, uuid, text, integer, integer) to service_role;
