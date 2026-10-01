-- Coarse per-user activity stamp — powers "last active 2h ago" on the
-- professor roadmap's student dossier (and any later roster surface).
--
-- Stamped ONLY by the service-role client, piggybacked on logEvent() (the
-- funnel every meaningful student action already flows through) and
-- throttled there to ~10-minute granularity so it is not a write per action.
alter table public.profiles add column last_active_at timestamptz;

-- last_active_at is professor-facing, so it must be server-authoritative:
-- extend the column-immutability guard to reject client-side writes to it.
--
-- IMPORTANT provenance note: the body below is rebuilt from the NEWEST prior
-- definition — 20260626184930_security_audit_remediation.sql (which added the
-- is_platform_owner and status pins on top of 20260611204904) — plus the one
-- new last_active_at check. A CREATE OR REPLACE from an older body would
-- silently revert later pins; anyone extending this function again must copy
-- THIS version.
create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  -- Trusted server-side / internal callers may set/change protected columns.
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;

  -- INSERT: a non-service-role caller may only ever create a plain student row.
  if tg_op = 'INSERT' then
    if new.role is distinct from 'student' then
      raise exception 'Creating a profile with an elevated role is not permitted'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- UPDATE: the following columns are immutable to non-service-role callers.
  if new.role is distinct from old.role then
    raise exception 'Changing profile role is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  if new.institution_id is distinct from old.institution_id then
    raise exception 'Changing profile institution is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  if new.is_platform_owner is distinct from old.is_platform_owner then
    raise exception 'Changing platform-owner status is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(new.status, '') is distinct from coalesce(old.status, '') then
    raise exception 'Changing profile status is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  -- last_active_at is stamped only by the server (logEvent's throttled touch);
  -- a self-set timestamp would spoof the professor-facing activity signal.
  if new.last_active_at is distinct from old.last_active_at then
    raise exception 'Changing profile activity timestamp is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- Backfill from the signals we already have — the newest of last_login_at
-- and the user's latest logged event — so a course mid-term doesn't open
-- with a roster full of "no activity" claims that are demonstrably false.
-- Profiles with neither signal stay NULL (the card then simply omits the line).
update public.profiles p
set last_active_at = s.latest
from (
  select p2.id,
         greatest(
           coalesce(p2.last_login_at, '-infinity'::timestamptz),
           coalesce(e.max_ts, '-infinity'::timestamptz)
         ) as latest
  from public.profiles p2
  left join (
    -- Reads events.timestamp, NOT events.created_at. Both exist in the local
    -- base schema, but prod predates created_at, so the original version of
    -- this line failed on prod with `42703: column "created_at" does not
    -- exist` — after review had passed, because CI never applies migrations.
    -- `timestamp` exists in every environment and carries the same
    -- `default now()` semantics, so this needs no ordering guarantee from the
    -- later reconciliation migration. Matches what was applied to prod.
    select e2.user_id, max(e2.timestamp) as max_ts
    from public.events e2
    where e2.user_id is not null
    group by e2.user_id
  ) e on e.user_id = p2.id
) s
where s.id = p.id
  and s.latest > '-infinity'::timestamptz
  and p.last_active_at is null;
