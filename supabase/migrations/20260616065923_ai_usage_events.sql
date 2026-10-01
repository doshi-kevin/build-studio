-- ============================================================
-- AI usage & cost ledger (platform-wide)
-- ============================================================
-- One append-only row per LLM call across EVERY AI feature (not just the
-- professor assistant) — quiz generation, the AI tutor, live quizzes, class
-- insights, etc. The `feature` column discriminates; `metadata` jsonb absorbs
-- any per-feature extras without a schema change. This is the source of truth
-- for the super-admin "AI Costs" dashboard (every token + every dollar).
--
-- Cost is computed AT WRITE TIME from a dated rate table in code
-- (src/lib/ai/cost.ts) and stored, so historical rows stay accurate even when
-- provider pricing changes later.
--
-- Writes happen ONLY server-side via the service-role admin client (which
-- bypasses RLS). Reads happen ONLY through super-admin server code
-- (verifySuperAdmin gate, admin client). The table is therefore SERVER-ONLY:
-- RLS is enabled and the single policy grants SELECT to super_admins only.
--
-- RLS scope note (deliberate): this is a PLATFORM-LEVEL analytics table read
-- across all tenants by the super_admin role by design, so the policy scopes by
-- ROLE (super_admin) rather than by institution_id. institution_id is still
-- recorded on every row so the dashboard can break spend down per tenant. No
-- anon / non-super_admin authenticated access is granted.
-- ============================================================

create table if not exists public.ai_usage_events (
  id                  uuid primary key default gen_random_uuid(),
  -- which AI feature produced this call (extensible — no enum, just a label):
  -- 'professor_assistant' | 'quiz_generation' | 'ai_tutor' | 'live_quiz' | 'class_insights' | ...
  feature             text        not null,
  institution_id      uuid        not null references public.institutions(id) on delete cascade,
  section_id          uuid        references public.course_sections(id) on delete set null,
  user_id             uuid        references public.profiles(id) on delete set null,
  model               text        not null,
  input_tokens        integer     not null default 0,
  cached_input_tokens integer     not null default 0,
  output_tokens       integer     not null default 0,
  total_tokens        integer     generated always as (input_tokens + cached_input_tokens + output_tokens) stored,
  cost_usd            numeric(12,6) not null default 0,
  metadata            jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists ai_usage_events_feature_created_idx on public.ai_usage_events (feature, created_at desc);
create index if not exists ai_usage_events_institution_created_idx on public.ai_usage_events (institution_id, created_at desc);
create index if not exists ai_usage_events_created_idx on public.ai_usage_events (created_at desc);
create index if not exists ai_usage_events_user_idx on public.ai_usage_events (user_id);

comment on table public.ai_usage_events is
  'Append-only per-call AI usage + cost ledger across all AI features. feature discriminates; metadata holds per-feature extras. Server-only: written via service role, read via super_admin only. cost_usd computed at write time from src/lib/ai/cost.ts.';

-- RLS: server-only table. Service role (admin client) bypasses RLS for writes
-- and super-admin reads; the one policy below additionally allows a super_admin
-- session to read directly. No insert/update/delete policy → clients cannot
-- write, and only super_admins can read.
alter table public.ai_usage_events enable row level security;

create policy "ai_usage_events: super_admin read"
  on public.ai_usage_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'super_admin'
    )
  );
