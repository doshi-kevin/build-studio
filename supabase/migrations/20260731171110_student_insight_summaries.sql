-- Student insight summaries — the AI dossier narrative on the professor
-- roadmap, stored (not ephemeral) so the same row can later feed Athena
-- (the professor assistant) and the data-intelligence layer.
--
-- One row per (section, student): the generated prose PLUS the structured
-- `facts` snapshot it was written from (mastery, quiz avg, journey counts,
-- late submissions, fumbled questions, weakest skills — versioned JSON).
-- `signal_hash` is a content hash of `facts`; the server regenerates the
-- prose only when the hash changes, so repeat opens are free and identical
-- inputs give identical summaries.

create table public.student_insight_summaries (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  section_id uuid not null references public.course_sections(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  summary text not null,
  facts jsonb not null,
  signal_hash text not null,
  model text not null,
  generated_at timestamptz not null default now(),
  constraint student_insight_summaries_unique unique (section_id, student_id)
);

-- The unique key doubles as the lookup index (and covers the section_id FK).
-- The other two FKs get their own: profiles cascade + the intelligence
-- layer's "this student across sections" reads.
create index student_insight_summaries_student_idx
  on public.student_insight_summaries (student_id);
create index student_insight_summaries_institution_idx
  on public.student_insight_summaries (institution_id);

-- Server-only table (same deliberate shape as outcome_alignment_map_cache):
-- RLS enabled with NO policies, so anon/authenticated can never read or write
-- it via PostgREST. Only server actions using the service-role client (which
-- bypasses RLS, after verifying the professor owns the section) touch it.
-- Belt-and-braces: also revoke the default grants Supabase gives client roles.
alter table public.student_insight_summaries enable row level security;
revoke all on public.student_insight_summaries from public, anon, authenticated;
