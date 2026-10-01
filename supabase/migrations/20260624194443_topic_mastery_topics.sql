-- Topic Mastery — Slice 1: the canonical per-section topic list (two-level hierarchy).
-- Covers Part 1 of docs/archive/briefs/topic-mastery/brief.md. See docs/designs/roadmap-mastery/topic-mastery.md.
--
-- A `topics` row is either a MAIN topic (parent_id IS NULL) or a SUBTOPIC
-- (parent_id -> a main topic). The two-level limit (a subtopic's parent must
-- itself be a main topic) is enforced in the server actions, not the schema,
-- to avoid a trigger for an invariant the write path already guarantees.
-- Scoped per section (= per semester, since a course_section is one offering).

create table if not exists public.topics (
  id              uuid primary key default gen_random_uuid(),
  section_id      uuid not null references public.course_sections(id) on delete cascade,
  institution_id  uuid not null references public.institutions(id) on delete restrict,
  parent_id       uuid references public.topics(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 120),
  info            text,
  source          text not null default 'professor' check (source in ('ai', 'professor')),
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_topics_section on public.topics(section_id);
create index if not exists idx_topics_section_parent on public.topics(section_id, parent_id);
create index if not exists idx_topics_parent on public.topics(parent_id);

alter table public.topics enable row level security;

-- Professors (own their section) and active TAs manage the section's topics.
-- auth.uid() is wrapped in a scalar subselect so the planner evaluates it once
-- per query, not per row (auth_rls_initplan advisor). The WITH CHECK additionally
-- pins institution_id to the row's section, so even a direct PostgREST write
-- can't set a mismatched tenant id (the server actions also stamp it).
create policy "Professors and TAs manage section topics"
  on public.topics for all
  using (
    section_id in (
      select id from public.course_sections where professor_id = (select auth.uid())
    )
    or section_id in (
      select section_id from public.section_staff
      where staff_id = (select auth.uid()) and status = 'active' and ends_at > now() and role = 'ta'
    )
  )
  with check (
    institution_id = (
      select cs.institution_id from public.course_sections cs where cs.id = section_id
    )
    and (
      section_id in (
        select id from public.course_sections where professor_id = (select auth.uid())
      )
      or section_id in (
        select section_id from public.section_staff
        where staff_id = (select auth.uid()) and status = 'active' and ends_at > now() and role = 'ta'
      )
    )
  );
