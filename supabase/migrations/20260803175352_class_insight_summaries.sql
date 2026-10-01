-- Class insight summaries — the whole-class counterpart of
-- `student_insight_summaries`: the AI narrative at the top of the roadmap's
-- Class analytics drawer, written from a facts snapshot the drawer itself
-- shows underneath it (class mastery, quiz average, standing split, weakest
-- curated skills, the students furthest behind).
--
-- One row per section. Same contract as the per-student table: `signal_hash`
-- is a content hash of `facts`, so the prose is rewritten only when the class
-- numbers actually move, and the stored row (facts + prose, versioned) can
-- later feed Athena and the data-intelligence layer.

create table public.class_insight_summaries (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  section_id uuid not null references public.course_sections(id) on delete cascade,
  summary text not null,
  facts jsonb not null,
  signal_hash text not null,
  model text not null,
  generated_at timestamptz not null default now(),
  constraint class_insight_summaries_unique unique (section_id)
);

-- The unique key doubles as the lookup index (and covers the section_id FK).
-- institution_id gets its own for the cascade + any cross-section roll-up.
create index class_insight_summaries_institution_idx
  on public.class_insight_summaries (institution_id);

-- Server-only table, exactly as student_insight_summaries: RLS enabled with NO
-- policies, so anon/authenticated can never read or write it via PostgREST.
-- Only server actions using the service-role client (which bypasses RLS, after
-- verifying the professor owns the section) touch it. Belt-and-braces: also
-- revoke the default grants Supabase gives the client roles.
alter table public.class_insight_summaries enable row level security;
revoke all on public.class_insight_summaries from public, anon, authenticated;
