-- ============================================================
-- AI quiz — persistent "generation shortfall" notice on quizzes
-- ============================================================
-- When an AI generation delivers fewer questions than requested because the
-- source material ran dry, the studio shows a persistent, dismissible notice
-- offering to fill the rest with on-topic questions from the model's own
-- knowledge ("beyond the document"). The notice must survive reload and
-- navigation until the professor acts on it or dismisses it, so it lives on the
-- quiz row rather than in client state.
--
-- One nullable jsonb column. Null = no outstanding notice. Shape:
--   {
--     "requested": 10,
--     "delivered": 8,
--     "request": { "moduleItemIds": [...], "additionalFilePaths": [...],
--                  "questionCount": 10, "customPrompt"?, "includeMetadata"?,
--                  "questionTypes"? },
--     "createdAt": "2026-07-16T00:00:00.000Z"
--   }
-- `request` is the original generation request, replayed (with
-- beyondDocument=true and questionCount=deficit) by the one-click "fill the
-- rest" action.
--
-- RLS: unchanged. Adding a column needs no new policy — the existing
-- per-section policies on `quizzes` still gate every row.
-- ============================================================

ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS generation_notice jsonb;

COMMENT ON COLUMN quizzes.generation_notice IS
  'AI-generation shortfall notice: {requested, delivered, request, createdAt} shown persistently in the studio to offer a topic-based "fill the rest" (beyond-document). Null when none/dismissed.';
