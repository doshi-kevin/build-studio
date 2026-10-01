-- ============================================================
-- Athena rate limits: one pool PER SURFACE (scope)
-- ============================================================
-- Follow-up to 20260624130647_athena_rate_limits, which keyed the counter on
-- (institution_id, user_id, model_id). That made ONE pool shared by every Athena
-- surface a professor touches — the sidebar console, assignment authoring, quiz
-- authoring and grading all drew down the same 150 Flash / 30 Pro. Draining one
-- surface locked the other three.
--
-- This widens the key with a `scope` column so each surface gets its OWN
-- independent pool at the SAME caps. Nothing about enforcement changes: the
-- reserve is still the one guarded INSERT … ON CONFLICT … DO UPDATE below, still
-- atomic, still rolling-window, still cap-and-window-from-code. The only
-- difference is that the conflict target now has four columns instead of three.
--
-- Caps and window stay in code (src/lib/ai/professor-assistant/models.ts) and are
-- still passed in as RPC parameters — no number is hardcoded here.
-- ============================================================

-- ── 1. The scope column ────────────────────────────────────────────────
-- The default exists ONLY to backfill existing rows onto the console pool, then
-- it is dropped so every future write must state its scope explicitly (a lingering
-- default would let a caller that forgot the parameter land silently in console).
--
-- Backfilled rows hold a MIX of historical traffic from all four surfaces, all
-- attributed to console. That is deliberate and harmless: counters are rolling and
-- self-clear within ATHENA_RATE_LIMIT_WINDOW_HOURS of the row's last use.
alter table public.athena_rate_limits
  add column if not exists scope text not null default 'console';

alter table public.athena_rate_limits
  alter column scope drop default;

-- Closed set of surface keys. This table's ONLY job is enforcement, so an
-- unrecognised scope string would silently mint a brand-new unlimited pool for
-- that surface — exactly the failure a CHECK catches at zero runtime cost.
-- Must stay in sync with ATHENA_LIMIT_SCOPES in models.ts. Adding a surface is
-- therefore a deliberate migration, which is correct: each new pool raises the
-- per-user daily cost ceiling.
alter table public.athena_rate_limits
  drop constraint if exists athena_rate_limits_scope_check;

alter table public.athena_rate_limits
  add constraint athena_rate_limits_scope_check
  check (scope in ('console', 'assignment', 'quiz', 'grade'));

-- ── 2. Widen the unique key ────────────────────────────────────────────
-- Safe on existing data: every pre-existing row was unique on
-- (institution_id, user_id, model_id) and now carries scope='console', so it is
-- still unique on the wider key.
--
-- `scope` is placed BEFORE `model_id` on purpose: the status read filters on
-- (institution_id, user_id, scope) and reads every model row for that pool, so
-- this column order makes the unique index serve that query as a prefix. No
-- additional index is needed.
alter table public.athena_rate_limits
  drop constraint if exists athena_rate_limits_unique;

alter table public.athena_rate_limits
  add constraint athena_rate_limits_unique
  unique (institution_id, user_id, scope, model_id);

comment on table public.athena_rate_limits is
  'Per-(institution,user,scope,model) rolling-window request counter enforcing Athena daily caps. One pool PER SURFACE (scope): console / assignment / quiz / grade, each at the same caps. Caps and window live in code (models.ts) and are passed to athena_increment_rate_limit. Server-only writes via the security-definer RPC; SELECT scoped to the owning user.';

-- ── 3. Replace the increment RPC ───────────────────────────────────────
-- A new parameter means a new SIGNATURE, so `create or replace` would leave the
-- old 5-arg function behind as a callable OVERLOAD — one that still keys on the
-- pre-scope conflict target and would corrupt the new pools. It must be dropped.
--
-- Dropping it before the app rolls over is safe by design: supabase-js surfaces a
-- missing function as an `error`, not a throw, and reserveAthenaSlot FAILS OPEN on
-- any RPC error. So the window between applying this migration and deploying the
-- matching code is "limits briefly unenforced", never "Athena is broken".
drop function if exists public.athena_increment_rate_limit(uuid, uuid, text, integer, integer);

-- Body is unchanged from 20260624130647 except for the scope column: same single
-- guarded statement, so two concurrent sends still serialize on the conflicting
-- row and can NEVER both push a pool past its cap.
--   • New row              → inserted at count 1, accepted.
--   • Window lapsed        → WHERE true; the CASE resets window_start = now() and
--                            count = 1, accepted (limits reset with no cron).
--   • In window, under cap → count += 1, accepted.
--   • In window, at cap    → WHERE false → no update, nothing RETURNING → rejected.
create or replace function public.athena_increment_rate_limit(
  p_institution_id uuid,
  p_user_id        uuid,
  p_scope          text,
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
  insert into public.athena_rate_limits as r (institution_id, user_id, scope, model_id, window_start, request_count)
  values (p_institution_id, p_user_id, p_scope, p_model_id, now(), 1)
  on conflict (institution_id, user_id, scope, model_id) do update
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
      and r.scope = p_scope
      and r.model_id = p_model_id;
    return query select false, v_count, v_window;
  else
    return query select true, v_count, v_window;
  end if;
end;
$$;

-- ── 4. Grants on the NEW signature ─────────────────────────────────────
-- Supabase ships ALTER DEFAULT PRIVILEGES that auto-grant EXECUTE on every new
-- public function to `anon` and `authenticated` — explicit role grants that
-- `revoke … from public` does NOT remove. The function created above is brand new,
-- so it picked those grants up and needs the same revoke 20260624135948 applied to
-- the old signature. Without this, any logged-in user could call the RPC directly
-- over PostgREST with an arbitrary p_user_id (DoS another professor's counter) or
-- an inflated p_cap (grant themselves unlimited budget).
revoke all on function public.athena_increment_rate_limit(uuid, uuid, text, text, integer, integer) from public;
revoke execute on function public.athena_increment_rate_limit(uuid, uuid, text, text, integer, integer) from anon, authenticated;
grant execute on function public.athena_increment_rate_limit(uuid, uuid, text, text, integer, integer) to service_role;

-- RLS is unchanged and still correct: the table keeps its single owner-read
-- SELECT policy (user_id = auth.uid()) from 20260624130647, and there is still NO
-- client write path — every write goes through the security-definer RPC above.
