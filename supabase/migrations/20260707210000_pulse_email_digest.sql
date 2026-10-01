-- Scholera Pulse Part 3 — daily email digest support.
--
-- 1. institutions.timezone — the digest sends at each institution's local 7 AM, so
--    the every-5-minute cron needs the institution's IANA timezone to know when it's
--    "morning" there. Defaults to America/New_York (validated against pg_timezone_names).
-- 2. email_digest_logs — one row per (recipient, day): the dedup guard so the cron
--    sends each student at most one digest per day. The cron claims a row
--    (INSERT ... ON CONFLICT DO NOTHING RETURNING) via the admin client and sends only
--    if a row was created — idempotent against the 5-minute cadence and retries.

-- ── institutions.timezone ────────────────────────────────────────────────
alter table public.institutions
  add column if not exists timezone text not null default 'America/New_York';

-- Reject a bad IANA name at write time rather than silently mis-timing digests.
alter table public.institutions
  drop constraint if exists institutions_timezone_valid;
alter table public.institutions
  add constraint institutions_timezone_valid
  check (now() at time zone timezone is not null) not valid;
alter table public.institutions validate constraint institutions_timezone_valid;

-- ── email_digest_logs ────────────────────────────────────────────────────
create table if not exists public.email_digest_logs (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  digest_date date not null,
  created_at timestamptz not null default now(),
  unique (recipient_id, digest_date)
);

comment on table public.email_digest_logs is
  'Dedup guard for the daily notification digest: one row per recipient per day. '
  'Written by the cron via the admin client (claim-then-send).';

alter table public.email_digest_logs enable row level security;

-- Recipients may read their own digest history; there are no client write policies,
-- so all writes go through the service role (admin client), which bypasses RLS.
create policy "email_digest_logs_select_own"
  on public.email_digest_logs
  for select
  using (recipient_id = (select auth.uid()));
