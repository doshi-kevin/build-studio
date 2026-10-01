-- Move the answer-key AI fields OFF the student-readable assignments.settings.rubric
-- row into this staff-only table (feature/ai-grading, BLOCKER #1).
--
-- WHY: each rubric criterion in assignments.settings.rubric used to carry the answer
-- key inline (referenceAnswer, absoluteKeywords, paraphrases, distractors,
-- keywordAliases, checkMode) plus per-question scoringRules / antiCriteria. The
-- assignments RLS student SELECT policy grants a FULL-ROW select on settings, and
-- Postgres RLS cannot mask JSONB sub-keys (Supabase students share the
-- 'authenticated' role) — so an app-layer stripRubricAiFields was the ONLY guard and
-- a raw PostgREST read returned the whole key. This column physically relocates those
-- fields into assignment_answer_keys, which already ships staff-SELECT-only / admin-
-- write RLS, so no student-reachable row ever holds them again.
--
-- SHAPE: rubric_ai is a JSON object aligned to the rubric by index:
--   { "criteria":  { "<qIdx>:<cIdx>": { referenceAnswer, absoluteKeywords, ... } },
--     "questions": { "<qIdx>":        { scoringRules, antiCriteria } } }
-- splitRubricAi / mergeRubricAi (src/lib/validations/assignment.ts) are the single
-- source of truth for reading and writing it.
--
-- RLS: unchanged — the table's existing "Section owner/staff can read answer keys"
-- SELECT policy already covers this column, and there is still NO client write path
-- (all writes go through the server-side admin client). Adding a column to an
-- RLS-enabled table needs no new policy.

ALTER TABLE public.assignment_answer_keys
  ADD COLUMN IF NOT EXISTS rubric_ai jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.assignment_answer_keys.rubric_ai IS
  'Answer-key AI fields lifted out of the student-readable assignments.settings.rubric row: per-criterion reference answers/keywords and per-question scoring/anti-criteria, aligned to the rubric by index. Split/merged via splitRubricAi/mergeRubricAi.';

-- The autosaved rubric DRAFT (settings.rubricDraft) carried the same AI fields, and drafts
-- live in the same student-readable settings row — so the draft is the same leak. Its AI
-- fields go here too, in a SEPARATE column so a mid-edit draft never corrupts the APPROVED
-- answer key (rubric_ai) that the grader merges. saveAssignmentRubric clears it on approval.
ALTER TABLE public.assignment_answer_keys
  ADD COLUMN IF NOT EXISTS rubric_ai_draft jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.assignment_answer_keys.rubric_ai_draft IS
  'Answer-key AI fields for the autosaved (not-yet-approved) rubric draft, split off settings.rubricDraft. Isolated from rubric_ai (approved) so a draft never changes what the grader sees. Cleared on rubric approval.';

-- The row can now exist for rubric_ai ALONE: a professor may hand-author reference
-- answers with no uploaded key PDF, so saveAssignmentRubric upserts rubric_ai without a
-- parsed-text/source. Relax the text/source columns to nullable + defaulted (they stay
-- the key PDF's cache when one is uploaded; NULL/'' means "AI fields only, no key PDF").
ALTER TABLE public.assignment_answer_keys ALTER COLUMN text DROP NOT NULL;
ALTER TABLE public.assignment_answer_keys ALTER COLUMN source_path DROP NOT NULL;
ALTER TABLE public.assignment_answer_keys ALTER COLUMN source_name DROP NOT NULL;

-- ── BACKFILL existing rows ──────────────────────────────────────────────────────
-- New saves split on write, but rows written before this migration still carry the AI
-- fields inline in the student-readable settings — the leak persists for them until
-- re-saved. Relocate those fields into rubric_ai/rubric_ai_draft and strip them (plus
-- answerKeySource) from settings, matching splitRubricAi/stripRubricAiFields exactly.
-- Idempotent: guarded to only touch rows that still carry an inline AI field.

-- Session-local helpers (auto-dropped at end of session). _extract mirrors splitRubricAi's
-- RubricAi shape { criteria: {"<q>:<c>": {...}}, questions: {"<q>": {...}} }; _strip mirrors
-- stripRubricAiFields (rebuilds the questions array with the AI keys removed).
CREATE FUNCTION pg_temp._extract_rubric_ai(rubric jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_build_object(
    'criteria', COALESCE((
      SELECT jsonb_object_agg((qi-1)::text || ':' || (ci-1)::text, cai)
      FROM jsonb_array_elements(rubric->'questions') WITH ORDINALITY AS q(qv, qi)
      CROSS JOIN LATERAL jsonb_array_elements(qv->'criteria') WITH ORDINALITY AS c(cv, ci)
      CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
        'referenceAnswer', cv->'referenceAnswer', 'absoluteKeywords', cv->'absoluteKeywords',
        'paraphrases', cv->'paraphrases', 'distractors', cv->'distractors',
        'keywordAliases', cv->'keywordAliases', 'checkMode', cv->'checkMode')) AS cai) x
      WHERE cai <> '{}'::jsonb
    ), '{}'::jsonb),
    'questions', COALESCE((
      SELECT jsonb_object_agg((qi-1)::text, qai)
      FROM jsonb_array_elements(rubric->'questions') WITH ORDINALITY AS q(qv, qi)
      CROSS JOIN LATERAL (SELECT jsonb_strip_nulls(jsonb_build_object(
        'scoringRules', qv->'scoringRules', 'antiCriteria', qv->'antiCriteria')) AS qai) x
      WHERE qai <> '{}'::jsonb
    ), '{}'::jsonb));
$fn$;

CREATE FUNCTION pg_temp._strip_rubric_ai(rubric jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN rubric->'questions' IS NULL THEN rubric ELSE jsonb_set(rubric, '{questions}', (
    SELECT COALESCE(jsonb_agg(
      ((qv - 'scoringRules' - 'antiCriteria') || jsonb_build_object('criteria', (
        SELECT COALESCE(jsonb_agg(
          (cv - 'referenceAnswer' - 'absoluteKeywords' - 'paraphrases' - 'distractors' - 'keywordAliases' - 'checkMode')
          ORDER BY ci), '[]'::jsonb)
        FROM jsonb_array_elements(qv->'criteria') WITH ORDINALITY AS c(cv, ci)
      ))) ORDER BY qi), '[]'::jsonb)
    FROM jsonb_array_elements(rubric->'questions') WITH ORDINALITY AS q(qv, qi)
  )) END;
$fn$;

INSERT INTO public.assignment_answer_keys (assignment_id, institution_id, section_id, rubric_ai, rubric_ai_draft)
SELECT a.id, a.institution_id, a.section_id,
       pg_temp._extract_rubric_ai(a.settings->'rubric'),
       pg_temp._extract_rubric_ai(a.settings->'rubricDraft')
FROM public.assignments a
WHERE a.settings::text ~ '(referenceAnswer|absoluteKeywords|paraphrases|distractors|keywordAliases|checkMode|scoringRules|antiCriteria)'
ON CONFLICT (assignment_id) DO UPDATE SET
  rubric_ai = EXCLUDED.rubric_ai,
  rubric_ai_draft = EXCLUDED.rubric_ai_draft;

UPDATE public.assignments a SET settings =
  (a.settings #- '{answerKeySource}')
  || jsonb_strip_nulls(jsonb_build_object(
       'rubric',      CASE WHEN a.settings->'rubric' IS NOT NULL      THEN pg_temp._strip_rubric_ai(a.settings->'rubric') END,
       'rubricDraft', CASE WHEN a.settings->'rubricDraft' IS NOT NULL THEN pg_temp._strip_rubric_ai(a.settings->'rubricDraft') END))
WHERE a.settings::text ~ '(referenceAnswer|absoluteKeywords|paraphrases|distractors|keywordAliases|checkMode|scoringRules|antiCriteria|answerKeySource)';

DROP FUNCTION pg_temp._extract_rubric_ai(jsonb);
DROP FUNCTION pg_temp._strip_rubric_ai(jsonb);
