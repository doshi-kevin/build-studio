-- Professor end-of-day submissions summary — dedup guard.
--
-- The every-5-minute notifications cron runs a sweep that, once per institution-local
-- day, rolls up the day's assignment / quiz / project submissions per section and emits
-- ONE in-app summary to the section's professor. This table is the claim-then-emit dedup
-- guard: one row per (professor, section, day). The sweep claims rows via
-- INSERT ... ON CONFLICT DO NOTHING RETURNING (admin client) and emits only for the rows
-- it actually created — idempotent against the 5-minute cadence and retries.
--
-- Mirrors email_digest_logs (20260707210000_pulse_email_digest.sql) exactly in shape and
-- RLS: professors read their own history; there are no client write policies, so every
-- write goes through the service role (admin client), which bypasses RLS.

create table if not exists public.submission_summary_logs (
  id uuid primary key default gen_random_uuid(),
  professor_id uuid not null references public.profiles(id) on delete cascade,
  section_id uuid not null references public.course_sections(id) on delete cascade,
  institution_id uuid not null references public.institutions(id) on delete cascade,
  summary_date date not null,
  created_at timestamptz not null default now(),
  unique (professor_id, section_id, summary_date)
);

comment on table public.submission_summary_logs is
  'Dedup guard for the professor end-of-day submissions summary: one row per professor '
  'per section per day. Written by the cron via the admin client (claim-then-emit).';

alter table public.submission_summary_logs enable row level security;

create policy "submission_summary_logs_select_own"
  on public.submission_summary_logs
  for select
  using (professor_id = (select auth.uid()));
