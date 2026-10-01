-- ============================================================
-- athena_conversations: scope a Studio thread to a PROJECT
-- ============================================================
-- Studio conversations are scoped to the thing being authored so the resume
-- dropdown shows the right history: assignment_id for the assignment kinds,
-- quiz_id for the Quiz Studio. Projects are a third item type and had nowhere
-- to hang, which would have collapsed every project thread in a section into a
-- single bucket (what 'about' does deliberately, because there is exactly one
-- About page per section — there are many projects).
--
-- Two CHECK constraints have to move together, and missing the second one is
-- the easy mistake:
--
--   * athena_conversations_studio_one_item currently says "not both assignment
--     and quiz". With a third column that has to become "at most one of three".
--   * athena_conversations_studio_columns_scoped enumerates every Studio-only
--     column and asserts they are ALL null on professor/student rows. A new
--     column not added there is a column a non-studio row may silently carry.
--
-- ORDERING MATTERS: apply this BEFORE deploying the code that writes project_id.
-- Conversation persistence fails CLOSED (route.ts returns 500 when the insert
-- errors), so code-first takes the whole surface down rather than degrading.
-- ============================================================

-- ── 1. The column ────────────────────────────────────────────────────
alter table public.athena_conversations
  add column if not exists project_id uuid references public.projects(id) on delete cascade;

comment on column public.athena_conversations.project_id is
  'Studio-only: the project this authoring thread belongs to. Null on every professor/student-surface row, and on Studio rows whose kind has no project (assignment/quiz/about/general).';

-- Partial index: only Studio project rows are ever filtered on this.
create index if not exists idx_athena_conversations_project
  on public.athena_conversations (project_id, user_id, updated_at desc)
  where project_id is not null;

-- ── 2. At most ONE item per Studio conversation ──────────────────────
-- Drop first, unconditionally: no CREATE CONSTRAINT IF NOT EXISTS, and
-- re-adding an existing constraint aborts the transaction.
alter table public.athena_conversations
  drop constraint if exists athena_conversations_studio_one_item;

alter table public.athena_conversations
  add constraint athena_conversations_studio_one_item
    check (
      (case when assignment_id is not null then 1 else 0 end)
      + (case when quiz_id is not null then 1 else 0 end)
      + (case when project_id is not null then 1 else 0 end)
      <= 1
    );

comment on constraint athena_conversations_studio_one_item on public.athena_conversations is
  'A Studio thread authors at most one item. Widened from the original assignment/quiz pair when projects became a third item type.';

-- ── 3. Studio columns stay null on non-Studio rows ───────────────────
-- Re-stated in full with project_id added. Without this, a professor- or
-- student-surface row could carry a project_id and corrupt the listing filters
-- silently — the exact failure the original constraint was written to prevent.
alter table public.athena_conversations
  drop constraint if exists athena_conversations_studio_columns_scoped;

alter table public.athena_conversations
  add constraint athena_conversations_studio_columns_scoped
    check (
      (surface = 'studio' and studio_surface is not null)
      or
      (surface <> 'studio' and studio_surface is null and studio_kind is null
        and assignment_id is null and quiz_id is null and project_id is null)
    );
