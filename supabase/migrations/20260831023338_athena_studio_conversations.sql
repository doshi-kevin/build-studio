-- Studio Athena (the About page / Assignments / Quizzes / Grading assistant,
-- src/components/professor/assignments/athena/) gets persisted, resumable
-- conversations — the third Athena implementation to reuse athena_conversations
-- / athena_messages, joining the professor Assistant Console ('professor') and
-- the student dock ('student'). Same reasoning as 20260806022237: RLS on both
-- tables is already owner-only (user_id = auth.uid()), so a parallel table buys
-- no isolation and only copies the RPC + policies for nothing.
--
-- Studio's scoping is finer than the other two surfaces: a professor's chat
-- about ONE assignment must never bleed into their chat about a different
-- assignment, or into grading vs. authoring the same one. Today that boundary
-- is the client's in-memory `panelKey` (mode:surface:kind:assignmentId) — this
-- migration gives it a durable equivalent.

-- ── 1. The third surface ─────────────────────────────────────────────
-- IF EXISTS so re-running this migration is a no-op rather than a halt (Postgres has
-- no CREATE CONSTRAINT IF NOT EXISTS, so the drop-then-add shape is the idempotent one).
alter table athena_conversations
  drop constraint if exists athena_conversations_surface_check;

alter table athena_conversations
  add constraint athena_conversations_surface_check
    check (surface in ('professor', 'student', 'studio'));

-- ── 2. Studio's own scoping columns ──────────────────────────────────
-- All nullable and meaningful ONLY when surface = 'studio' (enforced below).
alter table athena_conversations
  add column studio_surface text
    check (studio_surface in ('authoring', 'grade', 'general')),
  add column studio_kind text,
  add column assignment_id uuid references public.assignments(id) on delete cascade,
  add column quiz_id uuid references public.quizzes(id) on delete cascade,
  add column mode text not null default 'standard'
    check (mode in ('standard', 'frontier'));

comment on column athena_conversations.studio_surface is
  'Studio-only: authoring vs. grading vs. the no-host general chat (a list page '
  'with no item open). Null on every professor/student-surface row.';
comment on column athena_conversations.studio_kind is
  'Studio-only: the template kind (about/quiz/files/notebook/verbal/document/…), '
  'mirroring the client''s `kind` prop. Null on every professor/student row.';
comment on column athena_conversations.assignment_id is
  'Studio-only: which assignment this thread is scoped to. Null for the About '
  'page, quiz threads (see quiz_id instead), and the no-host general chat.';
comment on column athena_conversations.quiz_id is
  'Studio-only: which quiz this thread is scoped to. Null for every other kind.';
comment on column athena_conversations.mode is
  'Studio-only: Standard vs. Frontier — an orthogonal axis to studio_surface, '
  'since a Frontier thread uses a different tool set and prompt cadence. '
  'Meaningless (left at its default) on professor/student rows.';

-- A thread is scoped to at most one item — never both an assignment and a quiz.
alter table athena_conversations
  add constraint athena_conversations_studio_one_item
    check (not (assignment_id is not null and quiz_id is not null));

-- Studio's own columns stay populated ONLY on studio rows — a bug that leaked
-- studio_surface onto a professor/student conversation would corrupt the
-- listing filters silently; this makes it impossible instead.
alter table athena_conversations
  add constraint athena_conversations_studio_columns_scoped
    check (
      (surface = 'studio' and studio_surface is not null)
      or
      (surface <> 'studio' and studio_surface is null and studio_kind is null
        and assignment_id is null and quiz_id is null)
    );

-- FK columns get no automatic index in Postgres (data-access.md) — these serve
-- the ON DELETE CASCADE lookup when an assignment/quiz is removed. Deliberately
-- NOT a wider (section_id, user_id, studio_surface, studio_kind, …) composite:
-- every Studio list query is already bound by idx_athena_conversations_list's
-- (section_id, user_id) prefix, which returns at most a professor's own few
-- dozen threads in one section — filtering that small set by kind/item in
-- memory costs nothing, and a wide index here would only add write overhead
-- (see the same reasoning already recorded on the `surface` column below).
create index idx_athena_conversations_assignment_id
  on athena_conversations (assignment_id) where assignment_id is not null;
create index idx_athena_conversations_quiz_id
  on athena_conversations (quiz_id) where quiz_id is not null;

-- ── 3. Repair a grant the repo never had ─────────────────────────────
-- 20260806022237 DROPped and recreated athena_append_message to add p_metadata,
-- then revoked EXECUTE from public/anon/authenticated. Recreating a function
-- resets its ACL, and PostgreSQL's default grant is to PUBLIC — so revoking
-- PUBLIC left ONLY the owner. `service_role`, which is how every Athena route
-- actually calls this RPC, was never granted back.
--
-- Production survives on a grant applied out-of-band (its ACL reads
-- `{postgres=X/postgres,service_role=X/postgres}`), so this has been invisible
-- there. Any environment built from migrations ALONE — a local `db reset`, a new
-- staging project, CI — gets `permission denied for function
-- athena_append_message` on the first message to ANY Athena surface. That is how
-- this was found: the Studio resume feature is the first thing to exercise the
-- RPC on a from-scratch database.
--
-- Idempotent: re-granting an existing privilege is a no-op, so this is safe to
-- apply to prod, where it changes nothing.
grant execute on function public.athena_append_message(uuid, uuid, uuid, uuid, text, jsonb, jsonb)
  to service_role;
