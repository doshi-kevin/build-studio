-- ============================================================
-- AI quiz — mark a draft as "generation in progress"
-- ============================================================
-- "Create quiz" reuses a lingering empty "Untitled quiz" draft (0 questions) so
-- repeated clicks don't multiply empty rows. But a draft that is ACTIVELY being
-- generated into also has 0 questions during the concept-extraction phase (the
-- ~20-30s before the first batch persists) — so reuse would hand that busy draft
-- back as a "new" quiz, and the running generation's questions would then appear
-- in it (a quiz the professor never generated into).
--
-- This timestamp is set when a generation starts for a quiz and cleared when it
-- finishes; getOrCreateEmptyDraft excludes drafts stamped within the last few
-- minutes from reuse. One nullable column; null = not generating.
--
-- RLS: unchanged. Adding a column needs no new policy — the existing
-- per-section policies on `quizzes` still gate every row.
-- ============================================================

ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS generation_started_at timestamptz;

COMMENT ON COLUMN quizzes.generation_started_at IS
  'Set when an AI generation begins for this quiz, cleared when it ends. Excludes an actively-generating draft from "Create quiz" reuse so its questions never land in what looks like a new quiz. Null = not generating.';
