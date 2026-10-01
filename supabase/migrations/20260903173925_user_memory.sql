-- The memory layer's only table: preferences a user STATED about how they want
-- to be helped (docs/designs/athena/memory-layer.md).
--
-- Everything else memory reports — weak skills, what's due, the last class —
-- is derived live from tables that already own it, so nothing here is a second
-- copy of anything. This table exists because a stated preference has no other
-- home: nothing in the product records "I learn better from worked examples".
--
-- CONTENT CLASS. `text` holds a student's own words heading back into a model
-- prompt. That is student-generated content in an AI-facing store, which
-- .claude/rules/vector-db.md requires be signed off and shipped with its
-- erasure path. Sign-off is the design doc's Compliance section; erasure is
-- one statement (`delete from user_memory where user_id = $1`) because nothing
-- derived is persisted. The write path refuses sensitive categories server-side
-- (assertStorablePreference) — the rule is "store the accommodation, never the
-- reason": a student who says "I'm dyslexic, use plain language" gets
-- `use plain language` stored and the diagnosis dropped.

create table user_memory (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id) on delete cascade,
  institution_id  uuid not null references institutions(id) on delete cascade,
  -- NULL = general: applies to this person in every course. Set = course-scoped.
  -- Two axes, deliberately: scope is WHERE a preference applies, `expires_at`
  -- below is HOW LONG it holds. Losing scope would leak "I'm retaking this
  -- course" into every other course; expiry cannot express that.
  section_id      uuid references course_sections(id) on delete cascade,
  -- A collision slot, NOT a taxonomy of what may be remembered. The user's own
  -- words live in `text`; `kind` only decides which existing row a new
  -- statement replaces. Values and per-slot cardinality: lib/validations/memory.ts.
  kind            text not null,
  value           jsonb not null default '{}'::jsonb,
  -- The prompt line, already run through fence(). Fenced at WRITE time so a row
  -- cannot physically exist in a form the model could read as markup.
  text            text not null,
  source          text not null default 'stated'
                    check (source in ('stated', 'stated:inferred')),
  observed_at     timestamptz not null default now(),
  -- NULL = durable, which is the overwhelming default. Set ONLY when the user's
  -- own words carried a time bound ("this week", "for the midterm") — read from
  -- what they said, never inferred. Expired rows are FILTERED from the state,
  -- never deleted, so the visibility pane can still show them as history.
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Uniqueness differs by slot, so it cannot be one constraint.
--
-- NULLS NOT DISTINCT is load-bearing on both, not style: Postgres treats NULL
-- as distinct from NULL by default, so without it every GENERAL preference
-- (section_id IS NULL) would insert a fresh duplicate instead of colliding,
-- silently and forever. Requires PG 15+; prod runs 17.6.

-- 1. Never the same line twice, in any slot. This one is deliberately NOT
-- partial: `ON CONFLICT (cols)` cannot infer a partial index without repeating
-- its predicate, which supabase-js has no way to express, so a partial index
-- here makes every upsert fail at runtime with "no unique or exclusion
-- constraint matching the ON CONFLICT specification". Every write in
-- lib/memory/preferences.ts targets this index.
create unique index user_memory_dedup
  on user_memory (user_id, section_id, kind, text) nulls not distinct;

-- 2. Single-value slots hold exactly one row per scope: "keep it short" and
-- "give me full detail" cannot both be true, so a new statement REPLACES rather
-- than joins. The write path clears the slot before inserting; this index is
-- what makes a bug in that path impossible rather than merely unlikely.
-- Partial, and never used for conflict inference — see above.
-- Adding a slot to SINGLE_VALUE_SLOTS in lib/validations/memory.ts means
-- extending this list.
create unique index user_memory_single_slot_unique
  on user_memory (user_id, section_id, kind) nulls not distinct
  where kind in ('answer_length', 'explanation_style', 'language_level', 'tone');

-- The read path: this user's live rows for one section plus their general rows.
-- Bounded to one user, so no wider composite earns its write cost (data-access.md).
create index idx_user_memory_read
  on user_memory (user_id, section_id);

alter table user_memory enable row level security;

-- Owner-only read. The visibility pane reads through this; every server read
-- goes through the admin client and filters on user_id AND institution_id
-- anyway, because the admin client bypasses RLS entirely.
create policy "owner reads own memory"
  on user_memory for select to authenticated
  using (user_id = (select auth.uid()));

-- No INSERT/UPDATE/DELETE policy, deliberately. Supabase grants DML to
-- `authenticated` by default, so a FOR ALL policy keyed on `user_id = auth.uid()`
-- would let anyone write arbitrary rows straight through PostgREST — which here
-- means writing arbitrary text into their own system prompt, bypassing the
-- sensitive-category refusal entirely. Every write goes through the service
-- role (security-migrations.md, the FOR ALL write-hole rule).

comment on table user_memory is
  'Stated user preferences for the memory layer. Student-generated content in an '
  'AI-facing store: writes are service-role only and pass assertStorablePreference; '
  'erasure is delete-by-user_id. See docs/designs/athena/memory-layer.md.';
comment on column user_memory.section_id is
  'NULL = general (applies in every course). Set = scoped to that section.';
comment on column user_memory.kind is
  'Upsert collision slot, not a content taxonomy. See lib/validations/memory.ts.';
comment on column user_memory.expires_at is
  'NULL = durable. Set only when the user''s own words carried a time bound. '
  'Expired rows are filtered from the state but kept for the visibility pane.';
