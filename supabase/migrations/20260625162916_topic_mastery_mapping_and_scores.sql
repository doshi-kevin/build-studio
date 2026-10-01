-- Topic Mastery — mapping + per-student scores (builds on 20260624194443_topic_mastery_topics.sql).
-- Covers the activity↔topic mapping and the mastery scoring data the prototype's
-- dashboard / drill-down / roadmap-coloring read from. See docs/designs/roadmap-mastery/topic-mastery.md.

-- ── topics: remember whether the professor pinned a topic's placement ────────
-- When AI re-suggests on a later upload it must not move a topic the professor
-- has placed (the "🔒 pinned" knob in the review modal).
alter table public.topics
  add column if not exists placement_pinned boolean not null default false;

-- ── activity_topics: which subtopics an activity assesses ────────────────────
-- An activity (quiz | assignment | exam) maps to the topics it covers. Mappings
-- only — activities never create topics. Grading a mapped activity moves mastery.
create table if not exists public.activity_topics (
  id              uuid primary key default gen_random_uuid(),
  section_id      uuid not null references public.course_sections(id) on delete cascade,
  institution_id  uuid not null references public.institutions(id) on delete restrict,
  activity_id     uuid not null,
  activity_type   text not null check (activity_type in ('quiz', 'assignment', 'exam')),
  topic_id        uuid not null references public.topics(id) on delete cascade,
  created_at      timestamptz not null default now(),
  unique (activity_type, activity_id, topic_id)
);

create index if not exists idx_activity_topics_section on public.activity_topics(section_id);
create index if not exists idx_activity_topics_activity on public.activity_topics(activity_type, activity_id);
create index if not exists idx_activity_topics_topic on public.activity_topics(topic_id);

alter table public.activity_topics enable row level security;

create policy "Professors and TAs manage activity-topic mappings"
  on public.activity_topics for all
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

-- ── topic_mastery: one student's current score on one topic ──────────────────
-- score is 0–100, or NULL = "no data" (never shown as 0% for an untested topic).
-- Scored at the subtopic (leaf) level by the engine; main-topic scores are
-- derived (rolled up) on read. `state` holds algorithm-specific fields (e.g. EMA
-- count) so the scoring formula can evolve without a schema change.
create table if not exists public.topic_mastery (
  id              uuid primary key default gen_random_uuid(),
  section_id      uuid not null references public.course_sections(id) on delete cascade,
  institution_id  uuid not null references public.institutions(id) on delete restrict,
  student_id      uuid not null references public.profiles(id) on delete cascade,
  topic_id        uuid not null references public.topics(id) on delete cascade,
  score           numeric,
  state           jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  unique (student_id, topic_id),
  constraint topic_mastery_score_range check (score is null or (score >= 0 and score <= 100))
);

create index if not exists idx_topic_mastery_section on public.topic_mastery(section_id);
create index if not exists idx_topic_mastery_topic on public.topic_mastery(topic_id);
create index if not exists idx_topic_mastery_student on public.topic_mastery(student_id);

alter table public.topic_mastery enable row level security;

-- Professors / active TAs read (and manage, for resets) their section's scores.
create policy "Professors and TAs manage section mastery"
  on public.topic_mastery for all
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

-- Students read ONLY their own mastery rows.
create policy "Students read their own mastery"
  on public.topic_mastery for select
  using (student_id = (select auth.uid()));
