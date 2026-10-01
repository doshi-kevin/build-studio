-- ============================================================
-- Cost Analysis ledgers: external (non-LLM) usage + provider bill snapshots
-- ============================================================
-- Companion to ai_usage_events (LLM tokens). external_usage_events meters
-- every PAID non-LLM unit — ElevenLabs audio seconds / TTS characters,
-- Resend emails — one row per billable act, cost computed AT WRITE TIME from
-- the dated rate table in src/lib/costs/external-rates.ts and stored, so
-- history survives rate changes.
--
-- provider_bill_snapshots persists platform-level provider bills (GCP BigQuery
-- export, ElevenLabs invoice API, Supabase plan price, Resend computed) per
-- month, because several provider APIs only expose the CURRENT billing cycle —
-- without snapshots, history is lost at each cycle reset.
--
-- Both tables are SERVER-ONLY, same model as ai_usage_events: writes only via
-- the service-role admin client, reads via super-admin server code. RLS scopes
-- by ROLE (super_admin) not institution_id — this is deliberate: platform-level
-- analytics read across all tenants by the platform vendor. institution_id is
-- still recorded per row (nullable ONLY for platform-level acts such as
-- Supabase-SMTP auth emails that no tenant owns).
-- ============================================================

create table if not exists public.external_usage_events (
  id             uuid primary key default gen_random_uuid(),
  -- paid vendor: 'elevenlabs' | 'resend' | ... (extensible label, no enum —
  -- provider swaps must be a rate-table change, not a schema change)
  provider       text        not null,
  -- what the spend was for: 'live_transcription' | 'primer_tts' | 'verbal_tts'
  -- | 'verbal_stt' | 'email' | ...
  feature        text        not null,
  -- billing unit: 'audio_seconds' | 'characters' | 'emails' | ...
  unit           text        not null,
  quantity       numeric(14,3) not null default 0,
  cost_usd       numeric(12,6) not null default 0,
  institution_id uuid        references public.institutions(id) on delete cascade,
  section_id     uuid        references public.course_sections(id) on delete set null,
  user_id        uuid        references public.profiles(id) on delete set null,
  -- idempotency handle: webhook rows dedup on the provider event id, live
  -- Scribe heartbeats upsert one row per transcription session. Null for
  -- plain append-only rows (Postgres UNIQUE treats NULLs as distinct, and a
  -- full constraint — not a partial index — is required for PostgREST upsert
  -- ON CONFLICT inference).
  dedup_key      text unique,
  metadata       jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists external_usage_events_institution_created_idx
  on public.external_usage_events (institution_id, created_at desc);
create index if not exists external_usage_events_provider_created_idx
  on public.external_usage_events (provider, created_at desc);
create index if not exists external_usage_events_created_idx
  on public.external_usage_events (created_at desc);
create index if not exists external_usage_events_section_idx
  on public.external_usage_events (section_id);
create index if not exists external_usage_events_user_idx
  on public.external_usage_events (user_id);

comment on table public.external_usage_events is
  'Per-act non-LLM paid usage ledger (ElevenLabs, Resend, …). Server-only: written via service role, read via super_admin. cost_usd computed at write time from src/lib/costs/external-rates.ts. dedup_key enforces webhook/heartbeat idempotency.';

alter table public.external_usage_events enable row level security;

-- Read-only for super_admin sessions; no insert/update/delete policy → clients
-- cannot write (service role bypasses RLS for the server-side writer).
create policy "external_usage_events: super_admin read"
  on public.external_usage_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.role = 'super_admin'
    )
  );

-- ------------------------------------------------------------
-- provider_bill_snapshots — one row per (provider, month)
-- ------------------------------------------------------------
create table if not exists public.provider_bill_snapshots (
  id          uuid primary key default gen_random_uuid(),
  provider    text        not null,          -- 'gcp' | 'elevenlabs' | 'supabase' | 'resend'
  month       text        not null,          -- 'YYYY-MM' (invoice month)
  amount_usd  numeric(12,2) not null default 0,
  -- provenance of the figure, drives honest UI labeling:
  -- 'billed' (provider-reported invoice/billing data) | 'plan' (fixed plan
  -- price, no usage API exists) | 'computed' (our count × published pricing)
  source      text        not null,
  as_of       timestamptz not null default now(),
  metadata    jsonb       not null default '{}'::jsonb,
  constraint provider_bill_snapshots_provider_month_key unique (provider, month)
);

comment on table public.provider_bill_snapshots is
  'Monthly platform-level provider bill snapshots (GCP/ElevenLabs = billed, Supabase = plan, Resend = computed). Upserted by the cost-analysis page; persisted because provider APIs only expose the current billing cycle. Server-only.';

alter table public.provider_bill_snapshots enable row level security;

create policy "provider_bill_snapshots: super_admin read"
  on public.provider_bill_snapshots
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.role = 'super_admin'
    )
  );

-- ------------------------------------------------------------
-- Aggregation RPCs — read both ledgers server-side in one pass instead of
-- shipping raw rows to Node (the old ai-costs page loaded 5000 rows and
-- aggregated in-process; that stops scaling once every feature logs).
-- SECURITY INVOKER (default): callable only by service_role — EXECUTE is
-- revoked from anon/authenticated below (Supabase auto-grants otherwise).
-- ------------------------------------------------------------

-- Per-institution per-feature rollup across BOTH ledgers.
-- category: 'ai' for LLM rows, else the external provider label.
create or replace function public.cost_summary_by_institution(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  institution_id uuid,
  category       text,
  feature        text,
  cost_usd       numeric,
  calls          bigint,
  tokens         bigint,
  quantity       numeric
)
language sql
stable
as $$
  select a.institution_id, 'ai'::text as category, a.feature,
         sum(a.cost_usd) as cost_usd, count(*) as calls,
         sum(a.total_tokens)::bigint as tokens, null::numeric as quantity
  from public.ai_usage_events a
  where a.created_at >= p_from and a.created_at < p_to
  group by a.institution_id, a.feature
  union all
  select e.institution_id, e.provider as category, e.feature,
         sum(e.cost_usd) as cost_usd, count(*) as calls,
         null::bigint as tokens, sum(e.quantity) as quantity
  from public.external_usage_events e
  where e.created_at >= p_from and e.created_at < p_to
  group by e.institution_id, e.provider, e.feature
$$;

-- Daily cost series (all institutions, or one) for trend charts.
create or replace function public.cost_daily_series(
  p_from timestamptz,
  p_to   timestamptz,
  p_institution_id uuid default null
)
returns table (
  day      date,
  category text,
  cost_usd numeric
)
language sql
stable
as $$
  select (a.created_at at time zone 'utc')::date as day, 'ai'::text as category,
         sum(a.cost_usd) as cost_usd
  from public.ai_usage_events a
  where a.created_at >= p_from and a.created_at < p_to
    and (p_institution_id is null or a.institution_id = p_institution_id)
  group by 1
  union all
  select (e.created_at at time zone 'utc')::date as day, e.provider as category,
         sum(e.cost_usd) as cost_usd
  from public.external_usage_events e
  where e.created_at >= p_from and e.created_at < p_to
    and (p_institution_id is null or e.institution_id = p_institution_id)
  group by 1, e.provider
$$;

-- Server-only RPCs: Supabase auto-grants EXECUTE to client roles — revoke it
-- (see reference: role_routine_grants must not list anon/authenticated).
revoke execute on function public.cost_summary_by_institution(timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.cost_daily_series(timestamptz, timestamptz, uuid) from public, anon, authenticated;
