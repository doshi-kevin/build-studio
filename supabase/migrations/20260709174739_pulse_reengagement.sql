-- Scholera Pulse Part 4 (re-engagement) — win back dormant students.
--
-- 1. reengagement_logs — dedup guard: one row per (recipient, tier). The cron claims a
--    row (upsert ON CONFLICT DO NOTHING) BEFORE sending the nudge, so the 5-minute
--    cadence and retries never double-send a tier to the same student. Mirrors
--    email_digest_logs (Part 3).
-- 2. index on profiles.last_login_at — the sweep filters dormant students by this column
--    (populated on sign-in); profiles is a growing table so the range filter needs a
--    btree index (per .claude/rules/data-access.md).

-- ── reengagement_logs ────────────────────────────────────────────────────
create table if not exists public.reengagement_logs (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  tier smallint not null check (tier in (3, 7, 14, 30)),  -- dormancy tier the nudge was sent for
  sent_at timestamptz not null default now(),
  unique (recipient_id, tier)
);

comment on table public.reengagement_logs is
  'Dedup guard for re-engagement nudges: one row per (recipient, dormancy tier). '
  'Written by the cron via the admin client (claim-then-send); a student gets each '
  'tier at most once.';

alter table public.reengagement_logs enable row level security;

-- Recipients may read their own re-engagement history; there are NO client write
-- policies, so all writes go through the service role (admin client), which bypasses
-- RLS. SELECT-only (never FOR ALL) so a browser PostgREST call can't forge/alter rows.
create policy "reengagement_logs_select_own"
  on public.reengagement_logs
  for select
  using (recipient_id = (select auth.uid()));

-- ── profiles.last_login_at index ─────────────────────────────────────────
-- The dormancy sweep filters students by last_login_at (< N days ago). btree index so
-- that range filter stays fast as profiles grows.
create index if not exists idx_profiles_last_login_at
  on public.profiles (last_login_at);
