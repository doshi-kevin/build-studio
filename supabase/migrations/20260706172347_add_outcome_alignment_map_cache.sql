-- Per-artifact cache for the outcome_alignment pipeline's Map stage.
-- Keyed by a content hash of the exact LLM input (signal + indicator list +
-- prompt version), so re-running the analysis over unchanged course material
-- reuses the stored matches instead of re-sampling the LLM. This is what makes
-- repeated ABET analyses deterministic: identical inputs -> identical report.
-- Scoped per institution (copied materials across sections share entries);
-- never shared across institutions.

create table public.outcome_alignment_map_cache (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  input_hash text not null,
  matches jsonb not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  constraint outcome_alignment_map_cache_unique unique (institution_id, input_hash)
);

-- Pruning sweep (delete rows unused for 60+ days) filters on last_used_at.
create index outcome_alignment_map_cache_last_used_idx
  on public.outcome_alignment_map_cache (institution_id, last_used_at);

-- Worker-only table: RLS enabled with NO policies, so anon/authenticated can
-- never read or write it. Only the background worker's service-role client
-- (which bypasses RLS) touches this table. Belt-and-braces: also revoke the
-- default table grants Supabase gives client roles.
alter table public.outcome_alignment_map_cache enable row level security;
revoke all on public.outcome_alignment_map_cache from public, anon, authenticated;
