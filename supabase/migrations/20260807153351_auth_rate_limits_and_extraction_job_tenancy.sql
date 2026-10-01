-- Two follow-ups from the 2026-08-06 whole-system security audit (PR #555).
--
-- 1. A DB-backed limiter for the two PRE-AUTH login actions. The audit shipped the
--    codebase's in-memory rateLimit(), which is documented as per-instance — so on
--    Cloud Run an attacker simply spreads attempts across instances. This replaces it
--    with the same atomic-counter shape the Athena limits already use.
-- 2. extraction_jobs.institution_id, so the admin viewer can be scoped in SQL rather
--    than the application-side filter the audit had to settle for.


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. auth_rate_limits — cross-instance counter for pre-auth login actions
--
-- Modelled on athena_rate_limits + athena_increment_rate_limit: a rolling window
-- reset lazily on first use after it lapses (no cron), and one atomic
-- INSERT … ON CONFLICT … UPDATE … WHERE (lapsed OR under cap) so two concurrent
-- attempts serialize on the row and can NEVER both push past the cap.
--
-- Differs from the Athena table in two ways that matter:
--   * The key is an opaque text bucket, not (institution, user, model). These calls
--     happen BEFORE authentication, so there is no user id to key on. Callers pass
--     'cwid:<cwid>' and 'ip:<addr>' as two independent buckets — the CWID bucket
--     bounds brute-forcing ONE account, the IP bucket bounds walking the CWID space.
--     One without the other leaves a hole.
--   * EXECUTE is service_role ONLY. The Athena RPC has to be callable by
--     `authenticated` because RLS policies invoke it; this one is called from a server
--     action through createAdminClient(), so no client role needs it. An anon-callable
--     counter would let an attacker inflate a victim's bucket and lock them out.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.auth_rate_limits (
  -- Opaque bucket, e.g. 'cwid:12345678' or 'ip:203.0.113.7'. Deliberately not a
  -- foreign key: these are pre-auth and may reference nothing that exists.
  key            text        primary key,
  -- Start of the current rolling window; reset to now() on first use after lapse.
  window_start   timestamptz not null default now(),
  -- Attempts counted in the current window. Cleared on a successful login.
  attempt_count  integer     not null default 0,
  updated_at     timestamptz not null default now()
);

comment on table public.auth_rate_limits is
  'Rolling-window attempt counter for PRE-AUTH login actions (CWID resolve, password reset). Keyed by an opaque bucket because there is no authenticated user yet. Caps/window live in code and are passed to increment_auth_rate_limit. Server-only: no client role holds EXECUTE on the RPCs and the table has no policies.';

-- RLS on with NO policies: a deliberate deny-all. Nothing client-side may read this —
-- the row itself would tell an attacker whether a CWID is being rate-limited, which is
-- the enumeration signal the limiter exists to suppress. All access is via the
-- service-role RPCs below.
alter table public.auth_rate_limits enable row level security;

-- Prune lapsed rows cheaply; the table would otherwise grow one row per probed CWID.
create index if not exists idx_auth_rate_limits_window_start
  on public.auth_rate_limits (window_start);

/**
 * Claim one attempt against `p_key`. Returns accepted=false once the cap is reached.
 *
 * The whole decision is ONE statement so it cannot race:
 *   • no row              → insert at 1, accepted
 *   • window lapsed       → CASE resets window_start=now(), count=1, accepted
 *   • in window, under cap→ count += 1, accepted
 *   • in window, at cap   → WHERE false → no row updated → nothing RETURNING → rejected
 */
create or replace function public.increment_auth_rate_limit(
  p_key             text,
  p_cap             integer,
  p_window_minutes  integer
)
returns table (accepted boolean, resets_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_window_start timestamptz;
begin
  insert into auth_rate_limits as a (key, window_start, attempt_count, updated_at)
  values (p_key, now(), 1, now())
  on conflict (key) do update
    set
      window_start = case
        when a.window_start < now() - make_interval(mins => p_window_minutes) then now()
        else a.window_start
      end,
      attempt_count = case
        when a.window_start < now() - make_interval(mins => p_window_minutes) then 1
        else a.attempt_count + 1
      end,
      updated_at = now()
    where
      a.window_start < now() - make_interval(mins => p_window_minutes)
      or a.attempt_count < p_cap
  returning a.window_start into v_window_start;

  if v_window_start is null then
    -- Rejected: fetch the existing window so the caller can say when it frees up.
    select a.window_start into v_window_start from auth_rate_limits a where a.key = p_key;
    return query select false, v_window_start + make_interval(mins => p_window_minutes);
    -- `return` is load-bearing: `return query` APPENDS to the result set, it does not
    -- exit the function. Without this the rejected path fell through and appended a
    -- second, contradictory `true` row — so the function returned [false, true]. The
    -- app read row[0] and behaved correctly by luck, but any caller taking the last
    -- row or using .single() would have let a throttled attempt straight through.
    -- Caught by exercising the RPC on prod; no amount of static review would have.
    return;
  end if;

  return query select true, v_window_start + make_interval(mins => p_window_minutes);
end;
$function$;

/**
 * Clear a bucket after a SUCCESSFUL login.
 *
 * This is what keeps the limiter off legitimate users: only failures accumulate, so
 * someone who signs in correctly never walks toward the cap no matter how often they
 * do it. Without this, counting every attempt would eventually lock out an ordinary
 * heavy user.
 */
create or replace function public.clear_auth_rate_limit(p_key text)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  delete from auth_rate_limits where key = p_key;
$function$;

revoke execute on function public.increment_auth_rate_limit(text, integer, integer) from public, anon, authenticated;
grant  execute on function public.increment_auth_rate_limit(text, integer, integer) to service_role;
revoke execute on function public.clear_auth_rate_limit(text) from public, anon, authenticated;
grant  execute on function public.clear_auth_rate_limit(text) to service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. extraction_jobs.institution_id
--
-- The table had no tenant column, so /admin/extraction-jobs could not be scoped in
-- SQL. The audit closed the leak by resolving each row's tenant in application code
-- and dropping non-matching rows — correct, but it over-fetches (500 rows to show 50)
-- and a tenant whose jobs are older than the 500 newest platform-wide sees nothing.
--
-- Backfilled from BOTH links a job can carry, because the two kinds differ:
--   * extraction jobs      → module_item_id → modules → course_sections.institution_id
--   * recompute-mastery    → payload->>'sectionId' → course_sections.institution_id
-- Rows that resolve to neither stay NULL. That is deliberate and fail-closed: a job
-- whose module item was deleted belongs to no tenant, so no tenant should see it, and
-- the admin query filters on equality (NULL never matches).
--
-- Measured on prod before writing this: of 122 rows, 109 resolve (42 via module_item,
-- the rest via payload.sectionId) across 4 institutions, and 13 stay NULL. Worth
-- recording because the audit originally assumed most rows were unattributable — that
-- was only true of the module_item path, which is why it settled for an app-side
-- filter. The payload path covers the recompute-mastery jobs, which are the bulk.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.extraction_jobs
  add column if not exists institution_id uuid references public.institutions(id) on delete cascade;

-- Backfill via module_item → module → section.
update public.extraction_jobs ej
   set institution_id = cs.institution_id
  from public.module_items mi
  join public.modules m         on m.id  = mi.module_id
  join public.course_sections cs on cs.id = m.section_id
 where ej.module_item_id = mi.id
   and ej.institution_id is null
   and cs.institution_id is not null;

-- Backfill via payload.sectionId (the recompute-mastery kind carries no module item).
update public.extraction_jobs ej
   set institution_id = cs.institution_id
  from public.course_sections cs
 where cs.id = nullif(ej.payload->>'sectionId', '')::uuid
   and ej.institution_id is null
   and cs.institution_id is not null;

-- The admin viewer filters on this, and the worker claims by (status, kind); an index
-- on the new filter column keeps that page off a seq scan as the queue grows.
create index if not exists idx_extraction_jobs_institution_created
  on public.extraction_jobs (institution_id, created_at desc);
