-- athena_artifacts — interactive study artifacts Athena leaves on a student's
-- roadmap (flashcards, practice questions, study checklists — extensible by
-- `kind`). Created by the chat route's `leave_study_artifact` tool during a
-- conversation; rendered as margin-note nodes in the roadmap's right lane,
-- anchored to a module. Strictly personal: one row belongs to ONE student and
-- is never visible to classmates or the professor.
--
-- `payload` is the generated content (shape governed by the app-side kind
-- registry in src/lib/athena/artifact-kinds.ts); `state` is the student's own
-- interaction progress (checked steps, answered questions). Postgres stays the
-- source of truth; nothing here is derived.
--
-- RLS: enabled with NO policies — DELIBERATE, matching the quiz-domain
-- convention (quiz_item_stats, quiz_attempts …): every read/write goes through
-- an admin client behind app-layer enrollment + ownership checks, never the
-- browser's client. Deny-all-to-clients is the posture, not a missing policy.

CREATE TABLE IF NOT EXISTS athena_artifacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  section_id      uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  module_id       uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  -- The thread it was made in, for "open the chat" affordances later. SET NULL:
  -- deleting a conversation must not eat the artifacts it left behind.
  conversation_id uuid REFERENCES ai_conversations(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 40),
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  payload         jsonb NOT NULL,
  state           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The roadmap page's one read: this student's artifacts in this section.
CREATE INDEX IF NOT EXISTS athena_artifacts_section_student_idx
  ON athena_artifacts (section_id, student_id);
-- FK columns Postgres does not auto-index; module cascade + per-module grouping.
CREATE INDEX IF NOT EXISTS athena_artifacts_module_idx ON athena_artifacts (module_id);
CREATE INDEX IF NOT EXISTS athena_artifacts_conversation_idx ON athena_artifacts (conversation_id);
CREATE INDEX IF NOT EXISTS athena_artifacts_institution_idx ON athena_artifacts (institution_id);

ALTER TABLE athena_artifacts ENABLE ROW LEVEL SECURITY;
-- No policies: admin-client-only, per the convention documented above.
