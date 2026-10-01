// Gemini AI client for quiz question generation and topic extraction.
// Takes extracted lecture content (from getTextForLLM) and generates
// quiz questions or extracts key topics via Google Gemini.

import { generateText, generateObject, NoObjectGeneratedError } from 'ai'
import { google } from '@ai-sdk/google'
import { jsonrepair } from 'jsonrepair'
import { logger } from '@/lib/logger'
import { looksLikeSummaryRefusal } from '@/lib/validations/lecture-summary'
import { QUIZ_GENERATION_MODEL, QUIZ_ANALYSIS_MODEL, TOPIC_EXTRACTION_MODEL, PHASE_GENERATION_MODEL, LIVE_QUIZ_GENERATION_MODEL, LECTURE_SUMMARY_MODEL, SESSION_REPORT_MODEL, CLASS_INSIGHTS_MODEL, PRECLASS_PRIMER_MODEL, ANNOUNCEMENT_REWRITE_MODEL } from '@/lib/ai/config'
import { buildQuizSystemPrompt, buildQuizCallAssignment, QUIZ_CONCEPT_EXTRACTION_PROMPT, TOPIC_EXTRACTION_PROMPT, SECTION_TOPIC_HIERARCHY_PROMPT, buildPhaseGenerationPrompt, buildLiveQuizPrompt, buildLectureSummaryPrompt, buildSessionReportNarrativePrompt, buildFlashcardsPrompt, buildPracticeQuizPrompt, buildPreclassPrimerPrompt, buildAnnouncementRewritePrompt, buildTranscriptExtractionPrompt } from '@/lib/ai/prompts'
import {
  planQuizBatches,
  splitContentBlocks,
  passagesForBatch,
  pickLeastVisited,
  type QuizConcept,
} from '@/lib/quiz/concept-plan'
import { SemanticDedup, verifyAnswerability, verifyDistinctFacts, verifyTopicConsistency } from '@/lib/ai/quiz-quality'
import { TOPIC_NAME_MAX, type SuggestedSkill } from '@/lib/validations/skill'
import {
  flashcardsOutputSchema,
  practiceQuizOutputSchema,
  type Flashcard,
  type PracticeQuestion,
} from '@/lib/validations/lc-class-insights'
import {
  transcriptExtractionOutputSchema,
  type ExtractedClaim,
} from '@/lib/validations/lc-transcript-insights'
import { primerScriptOutputSchema } from '@/lib/validations/preclass-primer'
import {
  createQuestionServerSchema,
  type CreateQuestionServerInput,
  type QuizItemType,
  type DifficultyLevel,
  type BloomsLevel,
} from '@/lib/validations/quiz'
import { guessingFor } from '@/lib/quiz/irt/estimator'
import { generateId } from '@/lib/quiz/utils'
import { parseBlanks, serializeBlankToken } from '@/lib/quiz/fill-in-blank'
import { recordAiUsage, type AiAttribution } from '@/lib/ai/usage'
import type { TokenUsage } from '@/lib/ai/cost'

/**
 * Fire-and-forget cost-ledger write for one model call. Deliberately not
 * awaited — telemetry never adds latency to (or breaks) the feature logging
 * it. No attribution (caller couldn't provide one) → recordAiUsage's own
 * missing-institution warning fires, so unattributed spend stays visible in
 * logs rather than silently dropped.
 */
function track(
  feature: string,
  model: string,
  usage: TokenUsage | undefined,
  attr: AiAttribution | undefined,
  metadata?: Record<string, unknown>,
): void {
  void recordAiUsage({
    feature,
    model,
    institutionId: attr?.institutionId,
    sectionId: attr?.sectionId,
    userId: attr?.userId,
    usage: usage ?? {},
    metadata,
  })
}

/**
 * Turn an AI fill-in-blank question (text with `_____` markers + a blanks[] answer
 * list) into inline `{{blank:id:answers}}` tokens, mapping markers to blanks in
 * order. Extra blanks (fewer markers than blanks) are appended so no answer is
 * dropped; extra markers (more markers than blanks) become EMPTY blanks — never
 * a dead literal `_____` a student couldn't fill — which the authoring UIs then
 * refuse to save until the professor types the missing answer.
 */
export function buildInlineFillInText(
  text: string,
  blanks: { id: string; acceptedAnswers: string[] }[],
): string {
  let i = 0
  let out = text.replace(/_{3,}/g, () => {
    const b = blanks[i]
    i += 1
    return b ? serializeBlankToken(b.id, b.acceptedAnswers) : serializeBlankToken(generateId(), [])
  })
  for (; i < blanks.length; i += 1) out += ` ${serializeBlankToken(blanks[i].id, blanks[i].acceptedAnswers)}`
  return out.slice(0, 2000)
}
import { z } from 'zod'

/** Clamp an optional number into [min,max]; returns undefined if absent/invalid. */
function clampNum(v: number | undefined, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.min(max, Math.max(min, v))
}

/** Strip leaked internal `[ASSET <id>]` tags from student-visible text. The
 *  prompt forbids them, but Gemini still occasionally parrots the tag into a
 *  question ("Based on Table [ASSET a1], ..."), which students must never see.
 *  Also catches the BARE paraphrased form — "As shown in Asset a37, ..."
 *  (observed in the 2026-07-18 benchmark, fixed-s30 Q17) — which the bracketed
 *  pattern misses; the id is replaced with a neutral reference so the sentence
 *  still reads. Exported for unit tests. */
export function stripAssetTags(s: string): string {
  return s
    .replace(/\s*\[ASSET [^\]]{1,80}\]/gi, '')
    .replace(/\basset\s+a\d{1,3}\b/gi, 'the source material')
    .replace(/ {2,}/g, ' ')
    .trim()
}

// ── Types ────────────────────────────────────────────────────────

export interface GeneratedQuestion extends CreateQuestionServerInput {
  /** Warning if AI output needed fixup (e.g., missing choices) */
  validationWarning?: string
  /** Raw, UNRESOLVED source attribution from the model: the `[Title, page N]`
   *  marker this question was drawn from. The server action resolves these into
   *  `sourceCitation` (matching the title to a real module item / upload path and
   *  range-checking the page) before returning to the client. */
  sourceTitle?: string
  sourcePage?: number
  /** Raw, UNRESOLVED visual reference: the `[ASSET <id>]` tag of the figure/
   *  chart/table this question is grounded in. The server action validates it
   *  against the asset registry and materializes a page-region crop into
   *  `imagePath` — a hallucinated ID silently yields a text-only question. */
  sourceAssetId?: string
}

export interface GenerateQuizParams {
  /** Formatted lecture content from getTextForLLM() */
  content: string
  /** Number of questions to generate — split into ≤10-question chunks internally */
  questionCount: number
  /** Optional professor instructions */
  customPrompt?: string
  /** When true, also generate a quiz title and description */
  includeMetadata?: boolean
  /** Optional: restrict to specific question types. Empty = AI decides. */
  questionTypes?: string[]
  /** Optional: difficulty distribution for adaptive quizzes */
  difficultyDistribution?: { easy: number; medium: number; hard: number }
  /** Cost-ledger attribution (institution/section/user) for the generation calls. */
  attribution?: AiAttribution
  /** Streaming hook — called with each chunk's fresh (deduped, capped) questions
   *  the moment that chunk completes, so a caller can surface batches as they
   *  arrive. Awaited, so a caller may post-process/emit before the next batch. */
  onBatch?: (questions: GeneratedQuestion[]) => void | Promise<void>
  /** Progress hook — short human-readable notes on non-happy-path moments
   *  (retrying a flaky batch, recovering a truncated response, material
   *  exhausted) so a streaming UI can explain a pause instead of going quiet. */
  onStatus?: (message: string) => void
  /** Usage hook — fired with each pipeline call's token usage (generation,
   *  concept extraction, audits) so a streaming UI can show a live running
   *  total. Zero extra cost: usage metadata rides every response anyway. */
  onUsage?: (usage: TokenUsage) => void
  /** Opt-in "beyond the document": when the source material runs dry before the
   *  requested count, fill the remainder with on-topic questions from the
   *  model's own knowledge (topic-consistency-checked, not source-answerable).
   *  These are tagged sourceCitation={kind:'ai_extended'} so the UI flags them. */
  beyondDocument?: boolean
  /** Stems of questions ALREADY on the target quiz (from a prior run). Seeds the
   *  dedup + avoid-list so a follow-up generation — e.g. the "fill the rest"
   *  action from a shortfall notice — doesn't recreate questions that exist. */
  priorStems?: string[]
  /** Pre-extracted concepts for this content (merged from the per-item lists
   *  stored at upload, design §11a) — when supplied with enough entries, the
   *  whole-document extraction call is skipped. Markers must match the
   *  content's "[Title, page N]" block markers. */
  concepts?: QuizConcept[]
}

// ── Parser ────────────────────────────────────────────────────────

export interface RawQuestion {
  questionText?: string
  questionType?: string
  difficulty?: string
  bloomsLevel?: string | null
  tags?: string[]
  points?: number
  explanation?: string
  // New: Coding snippets
  codeSnippet?: { language: string; code: string } | null
  // MC
  choices?: { id?: string; text?: string; isCorrect?: boolean }[]
  allowMultiple?: boolean
  // TF
  correctAnswer?: boolean
  // SA
  acceptedAnswers?: string[]
  caseSensitive?: boolean
  // FIB
  blanks?: { id?: string; acceptedAnswers?: string[]; caseSensitive?: boolean }[]
  // CCAT/IRT (v2): continuous difficulty/discrimination + rubric for constructed-response
  irtA?: number
  irtB?: number
  rubric?: { concept?: string; match?: string[] }[]
  // walkthrough only
  opening?: string
  maxTurns?: number
  // Source attribution: the document title + page this question was drawn from,
  // copied from a `[Title, page N]` marker in the supplied content.
  sourceTitle?: string
  sourcePage?: number
  // Visual reference: the `[ASSET <id>]` tag of the visual the question is about.
  sourceAssetId?: string
}

// One question as the model emits it — split out from the wrapper so the
// salvage path can validate elements individually (a truncated response's
// complete elements still pass; only the cut-off tail fails).
const aiQuestionSchema = z.object({
    questionText: z.string(),
    questionType: z.enum(['multiple_choice', 'true_false', 'short_answer', 'fill_in_blank', 'explanation', 'walkthrough']),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    bloomsLevel: z.enum(['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']).nullable().optional(),
    tags: z.array(z.string()).optional(),
    points: z.number().int().optional(),
    explanation: z.string().optional(),
    codeSnippet: z.object({
      language: z.string(),
      code: z.string(),
    }).nullable().optional(),
    // MC
    choices: z.array(z.object({
      text: z.string().min(1),
      isCorrect: z.boolean(),
    })).min(2).optional(),
    allowMultiple: z.boolean().optional(),
    // TF
    correctAnswer: z.boolean().optional(),
    // SA
    acceptedAnswers: z.array(z.string()).optional(),
    caseSensitive: z.boolean().optional(),
    // FIB
    blanks: z.array(z.object({
      acceptedAnswers: z.array(z.string()),
      caseSensitive: z.boolean().optional(),
    })).optional(),
    // CCAT/IRT (v2): continuous difficulty b ∈ [−3,3], discrimination a ∈ [0.5,2.5]
    irtB: z.number().optional(),
    irtA: z.number().optional(),
    // explanation/walkthrough: rubric of 2–4 conceptual nodes a good answer should
    // convey. NOTE: no `match` keyword array here on purpose — letting the model emit
    // unbounded keyword lists sent Gemini into degenerate repetition loops (45k–238k
    // chars of permuted phrases → truncated, unparseable JSON). The primary AI grader
    // scores by concept meaning; the offline keyword fallback derives keywords from
    // the concept text (see grader.ts keywordGrade).
    rubric: z.array(z.object({
      concept: z.string().min(1),
    })).optional(),
    // walkthrough only: the tutor's opening prompt + how many student turns to allow
    opening: z.string().optional(),
    maxTurns: z.number().int().optional(),
    // Source attribution HINT: the `[Title, page N]` marker the question was drawn
    // from. OPTIONAL on purpose — making it required makes Gemini's structured
    // output fail (AI_NoObjectGeneratedError → long retries). Gemini also frequently
    // omits it, so the server does NOT rely on it: it falls back to a deterministic
    // content match (see resolveQuestionCitation). When present and verifiable, it's
    // preferred; otherwise the page is inferred from the question text.
    sourceTitle: z.string().optional(),
    sourcePage: z.number().int().optional(),
    // Visual reference HINT: the `[ASSET <id>]` tag of the figure/chart/table a
    // question is grounded in. OPTIONAL like the citation hint above; validated
    // server-side against the registry of IDs we actually supplied.
    sourceAssetId: z.string().optional(),
})

const aiQuizOutputSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  questions: z.array(aiQuestionSchema),
})

/** Extract JSON from a response that may contain markdown code fences */
function extractJSON(text: string): string {
  // Try to extract from ```json ... ``` blocks first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) return fenceMatch[1].trim()
  // Otherwise return as-is (already raw JSON)
  return text.trim()
}

/** Caps for the AI-supplied quiz title/description. 200/2000 are the same caps
 *  `quizSchema` (and the studio form) enforce — a model value over them landed
 *  in the title input as something the professor could not save. */
const MAX_AI_QUIZ_TITLE = 200
const MAX_AI_QUIZ_DESCRIPTION = 2000

/** A recovered value that swallowed its sibling keys. Gemini periodically closes
 *  a string with the wrong quote (`"title": "…Quiz', 'description': '…`), which
 *  fails structured output and leaves jsonrepair scanning on to the NEXT quote —
 *  so the salvaged `title` carries the rest of the object inside it. That is the
 *  literal reported symptom (#102): a title reading
 *  `ECE-322 Lesson 0: … Quiz', 'description': 'This quiz covers…`.
 *  Cut at the swallowed key and keep what came before it. The quotes around the
 *  key are REQUIRED, not optional: a 2000-char description is free prose, and an
 *  unquoted match truncates legitimate text ("the fields: name, description: …").
 *  Every real occurrence carries them, since jsonrepair copies them verbatim. */
const SWALLOWED_KEY_RE = /['"]\s*,\s*['"](?:title|description|questions)['"]\s*:/i

/**
 * Deterministically clean an AI-supplied title/description before it reaches the
 * studio form. Unlike the questions array (every element is schema-validated),
 * these two fields used to pass through on a bare `typeof === 'string'` check,
 * so any model formatting slip landed verbatim in the professor's title input.
 *
 * FORMATTING ONLY — this performs NO HTML escaping and is not a sanitizer. It is
 * safe today because quiz title/description render exclusively as JSX text nodes;
 * any future HTML sink must escape at the sink, not rely on this. Exported for tests.
 */
export function cleanAiQuizMetadataField(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  // Bound the input before any regex runs: the two `\s*`-separated patterns below
  // backtrack quadratically on a long contiguous whitespace run, and a salvaged
  // value can carry a large slice of the model output. 20× the cap is far more
  // than any real title/description needs, so this never truncates a good value.
  const src = raw.slice(0, maxLength * 20)
  // Drop a swallowed sibling key, then keep the first line only — a stray
  // newline means the rest is commentary, never part of the title.
  let value = src.split(SWALLOWED_KEY_RE)[0].split('\n')[0]
  // The model occasionally labels the value it was asked for ("Title: …").
  value = value.replace(/^\s*\*{0,2}\s*(?:quiz\s+)?(?:title|description)\s*\*{0,2}\s*:\s*\*{0,2}\s*/i, '')
  // Unwrap MATCHED surrounding quotes only — a title that legitimately contains
  // a quote ("Hamlet" Analysis Quiz) must survive untouched. The delimiter must
  // not recur inside: `"Hamlet" vs "Macbeth"` both opens and closes on a quote,
  // and the greedy match would strip the two that belong to the title itself.
  const wrapped = /^(["'`])([\s\S]*)\1$/.exec(value.trim())
  if (wrapped && !wrapped[2].includes(wrapped[1])) value = wrapped[2]
  value = value.replace(/\s+/g, ' ').trim()
  if (!value) return undefined
  if (value.length <= maxLength) return value
  // Clamp on a word boundary when one is close to the limit, so the truncation
  // reads like a title rather than a cut-off word.
  const cut = value.slice(0, maxLength)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim()
}


export function parseRawQuestion(raw: RawQuestion, index: number): GeneratedQuestion | null {
  const questionType = raw.questionType as QuizItemType | undefined
  if (!questionType || !raw.questionText) return null

  const validTypes: QuizItemType[] = ['multiple_choice', 'true_false', 'short_answer', 'fill_in_blank', 'explanation', 'walkthrough']
  if (!validTypes.includes(questionType)) return null

  const validDifficulties: DifficultyLevel[] = ['easy', 'medium', 'hard']
  const difficulty: DifficultyLevel = validDifficulties.includes(raw.difficulty as DifficultyLevel)
    ? (raw.difficulty as DifficultyLevel)
    : 'medium'

  const validBlooms: BloomsLevel[] = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']
  const bloomsLevel: BloomsLevel | null = validBlooms.includes(raw.bloomsLevel as BloomsLevel)
    ? (raw.bloomsLevel as BloomsLevel)
    : null

  let content: CreateQuestionServerInput['content']
  let warning: string | undefined

  switch (questionType) {
    case 'multiple_choice': {
      const choices = (raw.choices || [])
        .filter((c) => c.text && c.text.trim())
        .map((c) => ({
          id: generateId(),
          text: stripAssetTags(c.text!),
          isCorrect: c.isCorrect ?? false,
        }))
      // Drop rather than fabricate: an MC the model returned without ≥2 real
      // choices or without a correct answer is ungradeable. The old code padded
      // with "Option N" placeholders that looked complete but graded every
      // student wrong — same failure class the fill-in-blank branch drops for.
      if (choices.length < 2 || !choices.some((c) => c.isCorrect)) return null
      content = {
        questionType: 'multiple_choice',
        choices,
        allowMultiple: raw.allowMultiple ?? false,
      }
      break
    }
    case 'true_false': {
      content = {
        questionType: 'true_false',
        correctAnswer: raw.correctAnswer ?? true,
      }
      break
    }
    case 'short_answer': {
      let acceptedAnswers = (raw.acceptedAnswers || []).map((a) => a.trim()).filter(Boolean)
      // Drop rather than fabricate: no accepted answer grades every student
      // wrong. The old code pushed a literal "Answer" (then expanded it into
      // "Answer/answer/ANSWER"), a finished-looking but broken question.
      if (acceptedAnswers.length === 0) return null
      // Auto-expand single answers with case/trimmed variants so students
      // aren't penalized for capitalization differences
      if (acceptedAnswers.length === 1) {
        const base = acceptedAnswers[0].trim()
        const variants = new Set([base, base.toLowerCase(), base.toUpperCase()])
        // Add title case if multi-word
        if (base.includes(' ')) {
          variants.add(base.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' '))
        }
        acceptedAnswers = Array.from(variants)
      }
      content = {
        questionType: 'short_answer',
        acceptedAnswers,
        caseSensitive: raw.caseSensitive ?? false,
      }
      break
    }
    case 'fill_in_blank': {
      // Keep answerless entries (as empty blanks) so markers map to blanks 1:1 —
      // a missing answer becomes an empty chip the professor must fill (authoring
      // blocks saving it), never a dead `_____` or a fabricated placeholder.
      const blanks = (raw.blanks || []).map((b) => ({
        id: generateId(),
        acceptedAnswers: (b.acceptedAnswers || []).filter(Boolean),
        caseSensitive: b.caseSensitive ?? false,
      }))
      const hasAnswers = blanks.some((b) => b.acceptedAnswers.length > 0)
      // The model sometimes answers SA-style — a top-level acceptedAnswers
      // instead of a blanks[] array. Salvage that as a single blank.
      const saStyle = (raw.acceptedAnswers || []).filter(Boolean)
      if (!hasAnswers && saStyle.length > 0) {
        blanks.length = 0
        blanks.push({ id: generateId(), acceptedAnswers: saStyle, caseSensitive: raw.caseSensitive ?? false })
      }
      // No real answer anywhere — drop the question. A fabricated placeholder
      // (the old ['answer'] fallback) renders as a finished-looking chip that
      // literally says "answer" and grades every student wrong.
      if (!hasAnswers && saStyle.length === 0) return null
      content = {
        questionType: 'fill_in_blank',
        blanks,
      }
      break
    }
    case 'explanation': {
      // Free-text, AI-graded against `rubric` (set on the result below).
      content = { questionType: 'explanation' }
      break
    }
    case 'walkthrough': {
      // Multi-turn Socratic interview; transcript graded against `rubric`.
      content = {
        questionType: 'walkthrough',
        opening: stripAssetTags(raw.opening || '').slice(0, 1000),
        maxTurns: Math.min(8, Math.max(2, raw.maxTurns ?? 4)),
      }
      break
    }
  }

  // Rubric is required for constructed-response items; drop empty nodes.
  const rubric =
    questionType === 'explanation' || questionType === 'walkthrough'
      ? (raw.rubric || [])
          .filter((n) => n.concept && n.concept.trim())
          .map((n) => ({
            concept: n.concept!.trim().slice(0, 500),
            match: (n.match || []).map((m) => String(m).slice(0, 80)),
          }))
      : null
  if (rubric && rubric.length === 0 && !warning) {
    warning = `Question ${index + 1}: ${questionType} needs a rubric of at least 1 conceptual node`
  }

  // Auto-set Elo rating from difficulty (legacy — retained for backward compat)
  const eloRating = difficulty === 'easy' ? 800 : difficulty === 'hard' ? 1600 : 1200
  const expectedTimeSeconds = difficulty === 'easy' ? 30 : difficulty === 'hard' ? 60 : 45

  // CCAT/IRT parameters: prefer the AI-emitted continuous a/b; fall back to a
  // difficulty→b map so every question is immediately servable (design §4).
  const fallbackB = difficulty === 'easy' ? -1 : difficulty === 'hard' ? 1 : 0
  const irtB = clampNum(raw.irtB, -3, 3) ?? fallbackB
  const irtA = clampNum(raw.irtA, 0.5, 2.5) ?? 1.2
  const numChoices =
    content.questionType === 'multiple_choice' ? content.choices.length : 4
  const irtC = guessingFor(questionType, numChoices)

  const cleanedText = stripAssetTags(raw.questionText).slice(0, 2000)
  // Fill-in-blank: embed the answers inline as {{blank:id:answers}} tokens so
  // the question authors/renders with the same inline-blank UI as hand-authored
  // ones (answers are stripped before a student ever sees the text). Then derive
  // content.blanks back FROM the final text — the same source-of-truth invariant
  // hand-authoring uses — so tokens and blanks can never disagree (surplus
  // markers minted as empty blanks are included; the wizard blocks publishing
  // them until the professor fills the chip).
  let questionText = cleanedText
  if (content.questionType === 'fill_in_blank') {
    const caseById = new Map(content.blanks.map((b) => [b.id, b.caseSensitive ?? false]))
    questionText = buildInlineFillInText(cleanedText, content.blanks)
    content = {
      questionType: 'fill_in_blank',
      blanks: parseBlanks(questionText).map((b) => ({
        ...b,
        caseSensitive: caseById.get(b.id) ?? false,
      })),
    }
  }
  const result: GeneratedQuestion = {
    questionText,
    content,
    difficulty,
    bloomsLevel,
    tags: (raw.tags || []).slice(0, 10).map((t) => String(t).slice(0, 50)),
    points: Math.min(100, Math.max(1, raw.points ?? 1)),
    explanation: stripAssetTags(raw.explanation || '').slice(0, 2000),
    isBonus: false,
    isExtraCredit: false,
    imageUrl: null,
    imagePath: null,
    codeSnippet: raw.codeSnippet || null,
    eloRating,
    expectedTimeSeconds,
    irtA,
    irtB,
    irtC,
    rubric,
    sourceCitation: null, // resolved by the server action from sourceTitle/sourcePage below
  }

  // Carry the model's raw (unresolved) source attribution through for the action
  // to resolve. Only keep a sane page number; the title is matched server-side.
  if (raw.sourceTitle && typeof raw.sourceTitle === 'string') {
    result.sourceTitle = raw.sourceTitle.slice(0, 300)
  }
  if (typeof raw.sourcePage === 'number' && Number.isInteger(raw.sourcePage) && raw.sourcePage >= 1) {
    result.sourcePage = raw.sourcePage
  }
  if (raw.sourceAssetId && typeof raw.sourceAssetId === 'string') {
    result.sourceAssetId = raw.sourceAssetId.trim().slice(0, 40)
  }

  // Validate against Zod schema
  const parsed = createQuestionServerSchema.safeParse(result)
  if (!parsed.success) {
    warning = `Question ${index + 1}: ${parsed.error.issues[0]?.message || 'Validation failed'}`
  }

  if (warning) result.validationWarning = warning

  return result
}

// ── Main Generator ────────────────────────────────────────────────

// A single generateObject call degrades past ~10 questions: the model coasts,
// emitting question text but dropping choices/answers/rubric (which the schema
// marks optional, so the stubs still validate). So we split the request into
// chunks of at most CHUNK_SIZE and run them one after another, merging results.
// Every call stays the size the model handles reliably — a 100-question request
// is just 10 small chunks, not one call the model can't sustain.
const QUIZ_CHUNK_SIZE = 10
// Extra chunks allowed beyond the planned ones to refill the gap left when the
// model repeats itself and dedup drops the copies (see generateQuizQuestions).
const QUIZ_TOPUP_MAX_ROUNDS = 4

type DifficultyDistribution = { easy: number; medium: number; hard: number }

/** Normalized question stem for dedup: lowercased, fill-in-blank tokens and all
 *  non-alphanumerics collapsed to single spaces — so "What is 2 + 2?" and
 *  "what is 2+2" collide. Empty string when there's nothing to compare. */
function normalizeStem(text: string): string {
  return text
    .toLowerCase()
    .replace(/\{\{blank:[^}]*\}\}/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Readable stem for the prompt's avoid-list: fill-in-blank tokens become
 *  "_____" so the model sees a sensible sentence, not internal token syntax. */
function readableStem(text: string): string {
  return text.replace(/\{\{blank:[^}]*\}\}/g, '_____').trim()
}

/** Seed a run's lexical-dedup set + prompt avoid-list from questions already on
 *  the quiz (params.priorStems), so a follow-up generation doesn't recreate
 *  them. Semantic (embedding) dedup isn't pre-seeded — the lexical set + the
 *  prompt avoid-list carry the load; a rare paraphrase slipping through is
 *  acceptable and far cheaper than embedding every prior stem up front. */
function seedPriorStems(seen: Set<string>, avoidStems: string[], priorStems?: string[]) {
  for (const raw of priorStems ?? []) {
    const key = normalizeStem(raw)
    if (key) seen.add(key)
    const readable = readableStem(raw)
    if (readable) avoidStems.push(readable)
  }
}

/** Split a whole-quiz difficulty distribution across chunks, preserving exact
 *  per-level totals (flatten to a list, slice per chunk). undefined per chunk
 *  when the caller didn't pin a distribution. */
function splitDifficultyAcrossChunks(
  dist: DifficultyDistribution | undefined,
  chunkSizes: number[],
): (DifficultyDistribution | undefined)[] {
  if (!dist) return chunkSizes.map(() => undefined)
  const flat: string[] = [
    ...Array<string>(dist.easy).fill('easy'),
    ...Array<string>(dist.medium).fill('medium'),
    ...Array<string>(dist.hard).fill('hard'),
  ]
  let pos = 0
  return chunkSizes.map((size) => {
    const slice = flat.slice(pos, pos + size)
    pos += size
    return {
      easy: slice.filter((d) => d === 'easy').length,
      medium: slice.filter((d) => d === 'medium').length,
      hard: slice.filter((d) => d === 'hard').length,
    }
  })
}

interface QuizChunkResult {
  questions: GeneratedQuestion[]
  /** How many raw items the model returned BEFORE validation/type filtering —
   *  `questions.length` far below this means drift (wrong types, ungradeable
   *  items), not a short response. */
  rawCount?: number
  title?: string
  description?: string
  error?: string
}

/**
 * Salvage questions from the raw text of a failed `generateObject` call.
 * `AI_NoObjectGeneratedError` (unparseable/truncated JSON) still carries the
 * model's raw text — usually a questions array whose complete elements are
 * perfectly good; only the cut-off tail is broken. Repair the JSON
 * (`jsonrepair` closes dangling brackets/strings) and keep every element that
 * still validates, instead of discarding a whole ~15s call. Exported for tests.
 */
export function salvageRawQuestions(
  text: string | undefined,
): { questions: RawQuestion[]; title?: string; description?: string } | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(jsonrepair(extractJSON(text))) as {
      title?: unknown
      description?: unknown
      questions?: unknown
    }
    if (!Array.isArray(parsed?.questions)) return null
    const questions = parsed.questions.filter(
      (q) => aiQuestionSchema.safeParse(q).success,
    ) as RawQuestion[]
    if (questions.length === 0) return null
    return {
      questions,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
    }
  } catch {
    return null // repair couldn't produce JSON — nothing to save
  }
}

/** How many extra questions each call asks for beyond its quota. Some raw
 *  items always fall to validation (ungradeable MC, missing answers) or dedup;
 *  the surplus absorbs that so the call still fills its quota. Overproduction
 *  is trimmed deterministically — the caller never receives more than asked. */
const QUIZ_OVERGEN = 2

/** One generateObject call for a single chunk of `count` questions. Catches its
 *  own errors so one failed chunk can't sink the whole batch. */
async function generateQuizChunk(
  params: GenerateQuizParams,
  count: number,
  includeMetadata: boolean,
  difficultyDistribution: DifficultyDistribution | undefined,
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high',
  // Position of this chunk's first question in the overall request, so
  // "Question N: …" warning strings stay globally numbered across chunks
  // instead of restarting at 1 in each.
  indexOffset: number,
  // Stems already produced for this quiz — passed to the prompt so the model
  // avoids repeating them (see generateQuizQuestions for why this matters).
  avoidStems: string[],
  // Concept-first mode: the concepts this call must cover, one question each.
  focusConcepts?: { name: string; summary: string }[],
): Promise<QuizChunkResult> {
  // Parse raw model output into validated questions, capped at this call's
  // quota. Shared by the success path and the salvage path. Logs WHY items
  // were dropped (off-type drift vs ungradeable) — the distinction drives
  // prompt tuning, and a silent all-drop batch was undiagnosable without it.
  const toQuestions = (rawQuestions: RawQuestion[]): GeneratedQuestion[] => {
    // The prompt names the allowed types, but the model occasionally emits one
    // that wasn't requested — e.g. an AI-graded `explanation` on a non-adaptive
    // quiz, which the standard flow can't grade. The output schema accepts all
    // six types, so enforce the caller's allow-list here: a stray type can never
    // reach the studio. No allow-list → the caller wanted a free mix.
    const allowedTypes = params.questionTypes?.length ? new Set(params.questionTypes) : null
    const questions: GeneratedQuestion[] = []
    let droppedInvalid = 0
    let droppedOffType = 0
    for (let i = 0; i < rawQuestions.length && questions.length < count; i++) {
      const q = parseRawQuestion(rawQuestions[i], indexOffset + i)
      if (!q) {
        droppedInvalid++
        continue
      }
      if (allowedTypes && !allowedTypes.has(q.content.questionType)) {
        droppedOffType++
        continue
      }
      questions.push(q)
    }
    if (droppedInvalid + droppedOffType > 0) {
      logger.info('generateQuizChunk: dropped raw items', { droppedInvalid, droppedOffType, kept: questions.length })
      // Dev-only: surface WHAT was invalid — undiagnosable from counts alone.
      const firstInvalid = rawQuestions.find((r) => !parseRawQuestion(r, 0))
      if (firstInvalid) {
        logger.debug('generateQuizChunk: first invalid raw item', {
          item: JSON.stringify(firstInvalid).slice(0, 600),
        })
      }
    }
    return questions
  }

  // Overgenerate: ask for a couple extra so validation/dedup drops don't leave
  // the call short; toQuestions trims back to the real quota. A pinned
  // difficulty distribution is padded with mediums so it still sums to the
  // asked count (a distribution that disagrees with "exactly N" confuses the
  // model into picking one or the other).
  const askCount = count + QUIZ_OVERGEN
  const askDifficulty = difficultyDistribution
    ? { ...difficultyDistribution, medium: difficultyDistribution.medium + QUIZ_OVERGEN }
    : undefined
  try {
    // Static-first prompt split (design §11b): the system prompt holds only
    // run-constant rules; everything per-call (count, difficulty, concepts,
    // avoid-list) rides the END of the user message, after the content. Gemini
    // implicit caching discounts a repeated request prefix, so calls that share
    // content (chunked path) or a system prompt (all paths) must not diverge
    // at byte one on a per-call value.
    const systemPrompt = buildQuizSystemPrompt(
      params.customPrompt,
      includeMetadata,
      params.questionTypes,
      params.beyondDocument,
    )
    const assignment = buildQuizCallAssignment(
      askCount,
      askDifficulty,
      avoidStems,
      focusConcepts,
      params.questionTypes,
    )
    const result = await generateObject({
      model: google(QUIZ_GENERATION_MODEL),
      system: systemPrompt,
      prompt: params.content
        ? `### SOURCE MATERIAL\n\n${params.content}\n\n${assignment}`
        : `${assignment}\n\nNo source material is provided — generate from the professor's instructions in the system rules.`,
      schema: aiQuizOutputSchema,
      temperature: 0.5,
      // Runaway guard (P0 experiment 2026-07-18): a failed structured-output
      // call runs to this ceiling before dying (~$0.10/failure at the old 32k
      // floor), so headroom is priced risk, not safety. Successful calls
      // measure ≤ ~300 out-tok/question (selection) and ~600 (rubric); 3k base
      // + 1k/question leaves >2× margin while capping a runaway at a third of
      // the old burn. jsonrepair salvage recovers a genuinely truncated call.
      maxOutputTokens: Math.min(65000, 3000 + askCount * 1000),
      providerOptions: {
        // thinkingLevel: pure selection types stay 'minimal' for speed; calls
        // that may contain rubric-bearing explanation/walkthrough items get a
        // step up (see the caller).
        google: { thinkingConfig: { thinkingLevel } },
      },
    })
    track('quiz_generation', QUIZ_GENERATION_MODEL, result.usage, params.attribution, {
      thinking_level: thinkingLevel,
      ask_count: askCount,
    })
    if (result.usage) params.onUsage?.(result.usage)
    const { title, description, questions: rawQuestions } = result.object
    return { questions: toQuestions(rawQuestions as RawQuestion[]), rawCount: rawQuestions.length, title, description }
  } catch (err) {
    // Salvage before failing: on unparseable/truncated JSON the error still
    // carries the raw model text — recover its valid elements instead of
    // discarding the whole call (this was the "wait 2 minutes, get a raw
    // parse error, zero questions" failure mode).
    if (NoObjectGeneratedError.isInstance(err)) {
      const salvaged = salvageRawQuestions(err.text)
      if (salvaged) {
        params.onStatus?.('Recovering a truncated response…')
        track('quiz_generation', QUIZ_GENERATION_MODEL, err.usage, params.attribution, {
          thinking_level: thinkingLevel,
          ask_count: askCount,
          salvaged: true,
        })
        if (err.usage) params.onUsage?.(err.usage)
        logger.warn('generateQuizChunk: salvaged questions from unparseable response', {
          salvaged: salvaged.questions.length,
        })
        return {
          questions: toQuestions(salvaged.questions),
          rawCount: salvaged.questions.length,
          title: salvaged.title,
          description: salvaged.description,
        }
      }
    }
    logger.error('generateQuizChunk: Error', err)
    return { questions: [], error: err instanceof Error ? err.message : String(err) }
  }
}

type QuizGenerationResult = {
  questions: GeneratedQuestion[]
  metadata?: { title: string; description: string }
  error?: string
  /** True when fewer questions than requested were delivered because the
   *  material ran out of distinct questions (barren streak / makeup cap) —
   *  lets the UI explain the shortfall instead of leaving it a mystery. */
  exhausted?: boolean
  /** True when a rate limit cut the run short after some questions succeeded —
   *  the shortfall is throttling, not exhausted material, so the UI tells the
   *  professor to retry for the rest rather than to add more sources. */
  rateLimited?: boolean
  /** How many of the delivered questions were AI-extended (generated beyond the
   *  document, tagged ai_extended) — lets the UI report "N from source + M
   *  topic-based" and the route decide whether a shortfall notice is warranted. */
  extendedCount?: number
}

/** Errored calls are retried, but this many failures IN A ROW means a hard
 *  outage — exit with what we have instead of hammering the API. A success
 *  resets the counter, so occasional flakes across a long run don't kill it. */
const MAX_CONSECUTIVE_CHUNK_FAILURES = 3

/** 'low' is reserved for batches that are ENTIRELY rubric-bearing types.
 *  P0 cost experiment (2026-07-18, tmp/quiz-cost-optimization/): 'low' runaway-
 *  failed 5/9 structured-output calls — each burning the full maxOutputTokens
 *  ceiling over 70–120s before dying unparseable — while 'minimal' failed 1/7
 *  and delivered the same structural validity. So mixed and unrestricted type
 *  sets run 'minimal'; only an explicit all-rubric request pays for reasoning.
 *  Watch-item: rubric quality at 'minimal' in mixed adaptive quizzes is
 *  unmeasured — revisit via the reasoning_tokens/thinking_level ledger data. */
function quizThinkingLevel(questionTypes?: string[]): 'minimal' | 'low' {
  const rubricOnly =
    !!questionTypes?.length && questionTypes.every((t) => t === 'explanation' || t === 'walkthrough')
  return rubricOnly ? 'low' : 'minimal'
}

/** Was this provider error a rate-limit / throttle? The AI SDK surfaces the
 *  HTTP status only inside the message string, so match broadly — a bare "429",
 *  Gemini's "RESOURCE_EXHAUSTED" / "Too Many Requests", or a quota message must
 *  all count, not just the literal "rate_limit". */
function isRateLimitError(raw: string): boolean {
  return /\b429\b|rate[_ -]?limit|too many requests|resource[_ ]?exhausted|quota/i.test(raw)
}

/** Provider error that means the request itself was too big for the model. */
function isContentTooLargeError(raw: string): boolean {
  return /request too large|too many tokens|context length|maximum (?:context|input) tokens/i.test(raw)
}

/** Turn a raw provider error into a calm, actionable message — or undefined if
 *  it's unrecognized (the caller keeps its own default). Rate limits and
 *  content-size failures are DISTINCT causes with distinct fixes; conflating
 *  them (the old regex mapped every rate limit to "content too large") sent the
 *  professor chasing the wrong fix. */
function friendlyQuizError(raw: string): string | undefined {
  if (isRateLimitError(raw)) {
    return 'The AI is busy right now. Please wait a minute and try again.'
  }
  if (isContentTooLargeError(raw)) {
    return 'Content too large for AI model. Try selecting fewer files or a smaller page range.'
  }
  if (/no object generated|could not parse/i.test(raw)) {
    return 'The AI returned an unreadable response. This is usually temporary — please try again.'
  }
  return undefined
}

/** Shared tail for both generation paths: friendly zero-questions errors and
 *  the optional title/description metadata from the first successful call. */
function buildQuizResponse(
  params: GenerateQuizParams,
  questions: GeneratedQuestion[],
  firstResult: QuizChunkResult | undefined,
  firstError: string | undefined,
): QuizGenerationResult {
  if (questions.length === 0) {
    const err = firstError ?? 'No questions were generated.'
    return { questions: [], error: friendlyQuizError(err) ?? err }
  }

  const response: QuizGenerationResult = { questions }
  if (questions.length < Math.max(1, params.questionCount)) response.exhausted = true
  // A rate limit that struck AFTER some batches succeeded used to vanish: the
  // professor silently got fewer questions than requested. Flag the shortfall
  // as throttling (retry gets the rest) so the studio doesn't misreport it as
  // the material running dry.
  if (response.exhausted && firstError && isRateLimitError(firstError)) response.rateLimited = true
  if (params.includeMetadata) {
    // Both fields are cleaned here rather than at their source because this is
    // the single funnel for the direct AND the salvage path (#102).
    const title = cleanAiQuizMetadataField(firstResult?.title, MAX_AI_QUIZ_TITLE)
    const description = cleanAiQuizMetadataField(firstResult?.description, MAX_AI_QUIZ_DESCRIPTION)
    // Fallback description from tags if the model returned empty (or the value
    // was unusable). An empty title is the honest fallback — the studio leaves
    // its "Untitled quiz" placeholder for the professor rather than showing a
    // fabricated name, and a surviving description still lands.
    const tags = [...new Set(questions.flatMap((q) => q.tags || []))].slice(0, 5)
    const fallbackDesc = tags.length > 0 ? `Covers: ${tags.join(', ')}.` : ''
    if (title || description || fallbackDesc) {
      response.metadata = { title: title ?? '', description: description ?? fallbackDesc }
    }
  }
  return response
}

/**
 * Legacy whole-content chunked generation — now the FALLBACK path, used when
 * the content is too small to be worth a planning pass, the request is tiny,
 * or concept extraction fails (docs/designs/quizzes/quiz-generation-v2.md §10). The
 * primary path is generateConceptQuiz below.
 */
async function generateChunkedQuiz(params: GenerateQuizParams): Promise<QuizGenerationResult> {
  const total = Math.max(1, params.questionCount)

  // Chunk sizes: [10, 10, …, remainder]. ≤10 → a single chunk (old behaviour).
  const chunkSizes: number[] = []
  for (let n = total; n > 0; n -= QUIZ_CHUNK_SIZE) chunkSizes.push(Math.min(QUIZ_CHUNK_SIZE, n))
  const chunkDifficulties = splitDifficultyAcrossChunks(params.difficultyDistribution, chunkSizes)

  const thinkingLevel = quizThinkingLevel(params.questionTypes)

  // Why sequential and not concurrent: every chunk draws from the SAME source
  // content, so chunks that can't see each other produce the same questions —
  // a 30-question request would generate three near-identical batches of 10,
  // dedup would drop two of them, and the professor would get ~10. So we run
  // chunks in order, feeding each the stems already produced (`avoidStems`) so
  // the model makes genuinely new ones. Dedup on a normalized stem stays as a
  // safety net; `onBatch` surfaces each chunk's fresh, capped questions live.
  const seen = new Set<string>()
  const semanticDedup = new SemanticDedup(params.attribution)
  const avoidStems: string[] = []
  seedPriorStems(seen, avoidStems, params.priorStems)
  const questions: GeneratedQuestion[] = []
  let firstResult: QuizChunkResult | undefined
  let firstError: string | undefined

  // Run one chunk of `count`, seeded with the current avoid-list, and merge in
  // whatever is genuinely new — lexical dedup then semantic (embedding) dedup,
  // which catches the paraphrases lexical matching misses. Returns the raw
  // chunk result (for metadata/error).
  const runChunk = async (
    count: number,
    difficulty: DifficultyDistribution | undefined,
    includeMetadata: boolean,
    // Retry-at-minimal (P0 experiment 2026-07-18): a thinking runaway
    // reproduces on identical params, so retries drop the thinking level.
    level: 'minimal' | 'low' = thinkingLevel,
  ): Promise<QuizChunkResult> => {
    const res = await generateQuizChunk(
      params,
      count,
      includeMetadata,
      difficulty,
      level,
      questions.length, // global index offset for warning numbering
      avoidStems,
    )
    if (res.error && !firstError) firstError = res.error
    const lexFresh: GeneratedQuestion[] = []
    for (const q of res.questions) {
      const key = normalizeStem(q.questionText)
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      lexFresh.push(q)
    }
    const fresh = (await semanticDedup.filterFresh(lexFresh, (q) => readableStem(q.questionText))).slice(
      0,
      total - questions.length,
    )
    questions.push(...fresh)
    for (const q of fresh) avoidStems.push(readableStem(q.questionText))
    if (fresh.length > 0 && params.onBatch) await params.onBatch(fresh)
    return res
  }

  // Planned pass — the chunks that make up the requested total. Two stop rules,
  // for two different situations that must not be conflated:
  //  - A chunk SUCCEEDS but adds nothing new → the content is exhausted (same
  //    source + same avoid-list means the next chunk won't do better), so stop
  //    and return what the material genuinely supports.
  //  - A chunk ERRORS (Gemini flake: unparseable JSON → "No object generated",
  //    rate limit) → it produced nothing to judge exhaustion by, so RETRY that
  //    chunk. Treating a flake as "dry" aborted whole runs on one bad response.
  let failures = 0
  let barren = false
  let metadataPending = !!params.includeMetadata
  for (let i = 0; i < chunkSizes.length && questions.length < total; ) {
    const before = questions.length
    const res = await runChunk(
      chunkSizes[i],
      chunkDifficulties[i],
      metadataPending,
      failures > 0 ? 'minimal' : thinkingLevel,
    )
    if (res.error) {
      failures++
      if (failures >= MAX_CONSECUTIVE_CHUNK_FAILURES) break
      params.onStatus?.('Retrying a slow batch…')
      continue // transient failure — retry this chunk
    }
    failures = 0
    // Metadata (title/description) comes from the first SUCCESSFUL chunk — if
    // it were pinned to chunk index 0 and that chunk flaked, it'd be lost.
    if (metadataPending) {
      firstResult = res
      metadataPending = false
    }
    if (questions.length === before) { barren = true; break } // well is dry
    i++
  }

  // Top-up: the model sometimes overlaps within the planned pass and dedup drops
  // the copies, leaving us short even though the content holds more. Refill the
  // gap in ≤CHUNK_SIZE batches, each seeded with the full avoid-list. Skipped
  // when the planned pass ran dry or hit the failure cap. Bounded — stop on the
  // first SUCCESSFUL round that adds nothing new, or the round cap.
  for (
    let round = 0;
    !barren && failures < MAX_CONSECUTIVE_CHUNK_FAILURES && questions.length < total && round < QUIZ_TOPUP_MAX_ROUNDS;
    round++
  ) {
    const before = questions.length
    params.onStatus?.('Filling the remaining question slots…')
    const res = await runChunk(Math.min(QUIZ_CHUNK_SIZE, total - questions.length), undefined, false)
    if (res.error) {
      failures++
      continue
    }
    failures = 0
    if (questions.length === before) break // barren round — the well is dry
  }

  return buildQuizResponse(params, questions, firstResult, firstError)
}

// ── Concept-first generation (docs/designs/quizzes/quiz-generation-v2.md) ──

/** Gates for the concept-first path: tiny content isn't worth a planning
 *  call, and tiny requests would pay its latency for no coverage benefit. */
const CONCEPT_MIN_CONTENT_CHARS = 2000
const CONCEPT_MIN_QUESTIONS = 6
/** Accept an extraction only if it found a real spread of concepts —
 *  fewer means thin/junk material where blind chunking does just as well.
 *  Exported: the worker applies the same bar before STORING concepts. */
export const CONCEPT_MIN_CONCEPTS = 3

const quizConceptOutputSchema = z.object({
  /** One-line glanceable doc summary — consumed by the upload-time caller
   *  (roadmap chips); the quiz runtime ignores it. */
  summary: z.string(),
  concepts: z.array(
    z.object({
      name: z.string().min(1),
      importance: z.number(),
      markers: z.array(z.string()),
      summary: z.string(),
    }),
  ),
})

/**
 * The planning pass: one call over ALL selected content returns the ranked,
 * distinct, assessable concepts it teaches (with the source markers of the
 * blocks teaching each), plus a one-line doc summary. Returns null on failure
 * or a too-thin result (< CONCEPT_MIN_CONCEPTS).
 *
 * Two callers, one artifact (design §11a): the extraction worker runs it once
 * per uploaded file (concepts stored on the module item, summary + topic names
 * feed the roadmap), and quiz generation runs it only as the FALLBACK for
 * items without stored concepts / ad-hoc uploads.
 */
export async function extractQuizConcepts(
  content: string,
  attribution?: AiAttribution,
  onUsage?: (usage: TokenUsage) => void,
): Promise<{ concepts: QuizConcept[]; summary: string | null } | null> {
  try {
    const { object, usage } = await generateObject({
      model: google(QUIZ_ANALYSIS_MODEL),
      schema: quizConceptOutputSchema,
      system: QUIZ_CONCEPT_EXTRACTION_PROMPT,
      prompt: content,
      temperature: 0.3,
      maxOutputTokens: 8000,
      providerOptions: { google: { thinkingConfig: { thinkingLevel: 'low' } } },
    })
    track('quiz_concepts', QUIZ_ANALYSIS_MODEL, usage, attribution, { thinking_level: 'low' })
    if (usage) onUsage?.(usage)
    const concepts: QuizConcept[] = object.concepts
      .map((c) => ({
        name: c.name.trim().slice(0, 120),
        importance: Number.isFinite(c.importance) ? Math.min(10, Math.max(1, Math.round(c.importance))) : 5,
        markers: c.markers.filter((m) => m.trim()).slice(0, 6),
        summary: c.summary.trim().slice(0, 300),
      }))
      .filter((c) => c.name)
    if (concepts.length < CONCEPT_MIN_CONCEPTS) return null
    const summary = typeof object.summary === 'string' ? object.summary.trim().slice(0, SUMMARY_MAX_CHARS) || null : null
    return { concepts, summary }
  } catch (err) {
    logger.error('extractQuizConcepts: failed', err)
    return null
  }
}

/**
 * Concept-first generation: allocate the requested questions across the
 * extracted concepts (importance-ranked), then generate in ramped batches
 * (3, 5, 10, …) where every question targets ONE concept and each call sees
 * only its concepts' source blocks. Duplicates die at the source — batches
 * no longer independently rediscover the same salient facts — and the ramp
 * puts the first questions in front of the professor in seconds.
 */
async function generateConceptQuiz(
  params: GenerateQuizParams,
  concepts: QuizConcept[],
): Promise<QuizGenerationResult> {
  const total = Math.max(1, params.questionCount)
  const { preamble, blocks } = splitContentBlocks(params.content)
  const plan = planQuizBatches(concepts, total, params.difficultyDistribution)
  const batchQueue = [...plan.batches]
  const pool = [...plan.pool]
  const thinkingLevel = quizThinkingLevel(params.questionTypes)

  const seen = new Set<string>()
  const semanticDedup = new SemanticDedup(params.attribution)
  // Avoid-list bookkeeping (design §11c): a grounded batch receives only ITS
  // concepts' prior stems — concept partitioning already prevents cross-topic
  // repeats, and the old flat all-stems list grew the prompt quadratically
  // over a run. `priorAvoid` (stems already on the quiz, not attributable to
  // a concept) is always included; the beyond-document fill cycles ALL topics
  // so it keeps the full run-wide list. Semantic dedup stays global — this
  // narrows prompt steering, never the safety net.
  const priorAvoid: string[] = []
  seedPriorStems(seen, priorAvoid, params.priorStems)
  const runStems: string[] = []
  const stemsByConcept = new Map<string, string[]>()
  const recordStems = (fresh: GeneratedQuestion[], concepts: QuizConcept[]) => {
    for (const q of fresh) {
      const stem = readableStem(q.questionText)
      runStems.push(stem)
      for (const c of concepts) {
        const list = stemsByConcept.get(c.name)
        if (list) list.push(stem)
        else stemsByConcept.set(c.name, [stem])
      }
    }
  }
  const avoidFor = (concepts: QuizConcept[]): string[] => {
    const out = [...priorAvoid]
    for (const c of concepts) {
      for (const s of stemsByConcept.get(c.name) ?? []) if (!out.includes(s)) out.push(s)
    }
    return out
  }
  const questions: GeneratedQuestion[] = []
  let firstResult: QuizChunkResult | undefined
  let firstError: string | undefined
  let failures = 0
  let metadataPending = !!params.includeMetadata
  // Cycled-makeup budget: revisiting concepts is bounded to half the request,
  // so persistent under-delivery converges instead of spinning.
  const makeupCap = Math.ceil(total / 2)
  let makeupUsed = 0
  // How many generation batches each concept has been part of — makeup draws
  // the LEAST-visited concepts first (see pickLeastVisited) so refills spread
  // across the material instead of re-hammering the top-ranked concepts.
  const visitsByConcept = new Map<string, number>()
  // Consecutive SUCCESSFUL batches that added nothing fresh (all output was a
  // near-duplicate of what we already have). Three in a row means the material
  // is exhausted at the current distinctness bar — stop grinding out makeup
  // calls that keep regenerating the same questions (observed live: a ~3-min
  // tail of quota-1 batches all dropped by semantic dedup).
  const BARREN_STREAK_LIMIT = 3
  let barrenStreak = 0

  // Concepts the model failed on twice (persistently broken output — e.g. the
  // choiceless-MC coasting failure) are blacklisted: makeup cycling must never
  // hand them back, or the run relives the identical failure on every revisit.
  const blacklisted = new Set<QuizConcept>()
  let cyclable = plan.ranked

  // Refill a shortfall of `deficit` question slots: concepts never assigned a
  // slot first (pool), then — bounded by makeupCap — cycling back through the
  // ranked list (the avoid-list forces a different angle on a revisit). The
  // makeup batch goes to the FRONT so replacements reach the professor soonest.
  const enqueueMakeup = (deficit: number) => {
    if (deficit <= 0 || questions.length >= total) return
    // Pool first, then cycle ranked concepts for the remainder — CAPPED, never
    // all-or-nothing: a single-batch deficit larger than the remaining cap used
    // to enqueue NOTHING and end the run early (benchmark 2026-07-18 s30 hit
    // this with a mega-batch deficit of 20 > cap 15 → 10/30 delivered).
    const makeup: QuizConcept[] = []
    const freshPool = pool.filter((c) => !blacklisted.has(c))
    if (freshPool.length > 0) {
      makeup.push(...freshPool.slice(0, deficit))
      for (const c of makeup) pool.splice(pool.indexOf(c), 1)
    }
    const remaining = deficit - makeup.length
    if (remaining > 0 && cyclable.length > 0 && makeupUsed < makeupCap) {
      const take = Math.min(remaining, makeupCap - makeupUsed)
      makeup.push(...pickLeastVisited(cyclable, visitsByConcept, take))
      makeupUsed += take
    }
    if (makeup.length > 0) batchQueue.unshift({ concepts: makeup })
  }

  let attempts = 0 // attempts on the CURRENT head batch
  while (batchQueue.length > 0 && questions.length < total) {
    const batch = batchQueue[0]
    const quota = Math.min(batch.concepts.length, total - questions.length)
    // No "writing questions" status here — the banner title already says the
    // quiz is generating; only stage changes worth reading get a note (the
    // planning/checking/retrying statuses around this loop).
    const batchContent = passagesForBatch(batch, preamble, blocks, params.content)
    const res = await generateQuizChunk(
      { ...params, content: batchContent },
      quota,
      metadataPending,
      batch.difficulty,
      // Retry-at-minimal: the dominant failure mode is a thinking runaway that
      // reproduces on identical params — the retry drops to 'minimal' instead
      // of paying the same burn twice (P0 experiment 2026-07-18).
      attempts > 0 ? 'minimal' : thinkingLevel,
      questions.length, // global index offset for warning numbering
      avoidFor(batch.concepts),
      batch.concepts.slice(0, quota).map((c) => ({ name: c.name, summary: c.summary })),
    )
    // A batch that ERRORS or SUCCEEDS WITH ZERO VALID QUESTIONS (the model
    // drifted off the allowed types, or returned only ungradeable items —
    // observed live ~once per 4 batches) gets ONE retry, then is skipped so
    // the remaining batches still generate. Unlike the chunked path, zero
    // yield here never means "content exhausted": this batch's concepts are
    // untried material. Hard-outage cap on consecutive ERRORS still exits.
    const zeroYield = !res.error && res.questions.length === 0
    if (res.error) {
      if (!firstError) firstError = res.error
      failures++
      if (failures >= MAX_CONSECUTIVE_CHUNK_FAILURES) break
    } else {
      failures = 0
    }
    if (res.error || zeroYield) {
      logger.warn('generateConceptQuiz: batch yielded nothing', {
        quota,
        rawCount: res.rawCount ?? 0,
        error: res.error ?? null,
        attempt: attempts + 1,
      })
      attempts++
      if (attempts < 2) {
        params.onStatus?.(res.error ? 'Retrying a slow batch…' : 'A batch came back unusable — retrying…')
        continue // retry this batch once
      }
      batchQueue.shift() // twice unlucky — skip it, keep covering the rest
      attempts = 0
      // A twice-failed batch's concepts are blacklisted (the model relives the
      // identical failure on revisits), and its quota isn't silently lost:
      // it's refilled from OTHER concepts.
      for (const c of batch.concepts) blacklisted.add(c)
      cyclable = cyclable.filter((c) => !blacklisted.has(c))
      params.onStatus?.('Working around problem material…')
      enqueueMakeup(quota)
      continue
    }
    attempts = 0
    if (metadataPending) {
      firstResult = res
      metadataPending = false
    }
    batchQueue.shift()
    for (const c of batch.concepts) {
      visitsByConcept.set(c.name, (visitsByConcept.get(c.name) ?? 0) + 1)
    }

    // Quality gate (design §4c), in order: lexical dedup → semantic dedup
    // (embeddings — catches true paraphrases) → answerability audit (drops
    // questions the source can't answer) → same-fact redundancy audit (drops
    // questions testing knowledge already covered — the failure mode embedding
    // distance measurably can't catch, see QUIZ_REDUNDANCY_PROMPT) → cap to
    // the remaining quota. Only survivors are streamed; every drop becomes
    // deficit and is made up from replacement concepts below.
    const lexFresh: GeneratedQuestion[] = []
    for (const q of res.questions) {
      const key = normalizeStem(q.questionText)
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      lexFresh.push(q)
    }
    if (lexFresh.length > 0) {
      params.onStatus?.(`Checking ${lexFresh.length} draft question${lexFresh.length === 1 ? '' : 's'} for duplicates and accuracy…`)
    }
    let fresh = await semanticDedup.filterFresh(lexFresh, (q) => readableStem(q.questionText))
    fresh = await verifyAnswerability(fresh, batchContent, params.attribution, params.onUsage)
    fresh = await verifyDistinctFacts(
      fresh,
      (q) => readableStem(q.questionText),
      [...priorAvoid, ...runStems],
      params.attribution,
      params.onUsage,
    )
    fresh = fresh.slice(0, total - questions.length)
    questions.push(...fresh)
    recordStems(fresh, batch.concepts)
    if (fresh.length > 0 && params.onBatch) await params.onBatch(fresh)

    // Under-delivery (validation/dedup drops): refill so the run still lands
    // on target. Makeup is capped so a hostile run (throttled API dropping
    // most items) converges to a shortfall rather than looping.
    logger.info('generateConceptQuiz: batch done', {
      quota,
      raw: res.rawCount ?? 0,
      valid: res.questions.length,
      fresh: fresh.length,
      totalSoFar: questions.length,
      poolLeft: pool.length,
    })
    if (fresh.length === 0) {
      barrenStreak++
      if (barrenStreak >= BARREN_STREAK_LIMIT) {
        logger.info('generateConceptQuiz: material exhausted — consecutive batches added nothing new', {
          delivered: questions.length,
          requested: total,
        })
        params.onStatus?.('The selected materials have run out of distinct questions.')
        break
      }
    } else {
      barrenStreak = 0
    }
    enqueueMakeup(quota - fresh.length)
  }

  // ── Beyond-the-document fill (opt-in) ──────────────────────────
  // The source ran dry before the requested count and the professor allowed
  // on-topic questions from the model's own knowledge. Fill the remaining
  // deficit: still TARGET the document's own concepts (stay on-syllabus), but
  // generate from general knowledge (no source grounding), gate with the
  // topic-consistency check instead of source-answerability, and tag each
  // ai_extended so the studio flags them for a harder review.
  let extendedCount = 0
  if (params.beyondDocument && questions.length < total && failures < MAX_CONSECUTIVE_CHUNK_FAILURES) {
    const topicNames = plan.ranked.map((c) => c.name)
    const briefs = plan.ranked.map((c) => `[${c.name}] ${c.summary}`).join('\n\n')
    let extFailures = 0
    // Advance the concept cursor every iteration (success OR failure) so a
    // batch that comes back unusable (e.g. the intermittent choiceless-MC
    // failure) doesn't get retried on the identical concepts — the next round
    // targets fresh topics/angles instead of reliving the same failure.
    let cycleOffset = 0
    while (questions.length < total && extFailures < 3) {
      const batchN = Math.min(total - questions.length, 8)
      // One concept per slot, cycling the ranked list so the fill spreads
      // across the document's topics instead of hammering the first few.
      const focus = Array.from({ length: batchN }, (_, i) => {
        const c = plan.ranked[(cycleOffset + i) % plan.ranked.length]
        return { name: c.name, summary: c.summary }
      })
      cycleOffset += batchN
      params.onStatus?.('Writing topic-based questions beyond the document…')
      const res = await generateQuizChunk(
        { ...params, content: briefs, beyondDocument: true },
        batchN,
        false,
        undefined,
        thinkingLevel,
        questions.length,
        [...priorAvoid, ...runStems],
        focus,
      )
      if (res.error || res.questions.length === 0) {
        extFailures++
        continue
      }
      // Same gate as the grounded path MINUS answerability: lexical + semantic
      // dedup, then topic-consistency (on-topic + correct by standard knowledge).
      const lexFresh: GeneratedQuestion[] = []
      for (const q of res.questions) {
        const key = normalizeStem(q.questionText)
        if (key && seen.has(key)) continue
        if (key) seen.add(key)
        lexFresh.push(q)
      }
      let fresh = await semanticDedup.filterFresh(lexFresh, (q) => readableStem(q.questionText))
      fresh = await verifyTopicConsistency(fresh, topicNames, params.attribution, params.onUsage)
      fresh = await verifyDistinctFacts(
        fresh,
        (q) => readableStem(q.questionText),
        [...priorAvoid, ...runStems],
        params.attribution,
        params.onUsage,
      )
      fresh = fresh.slice(0, total - questions.length)
      if (fresh.length === 0) {
        extFailures++
        continue
      }
      // Tag ai_extended (the model's own primary tag names the topic; fall back
      // to the targeted concept) and strip any spurious source hint so citation
      // resolution downstream can't overwrite the tag with a bogus page.
      for (const q of fresh) {
        const topic = q.tags?.[0]?.trim() || focus[0]?.name || 'General'
        q.sourceCitation = { kind: 'ai_extended', topic: topic.slice(0, 300) }
        q.sourceTitle = undefined
        q.sourcePage = undefined
        q.sourceAssetId = undefined
      }
      extFailures = 0
      questions.push(...fresh)
      extendedCount += fresh.length
      recordStems(fresh, [])
      if (params.onBatch) await params.onBatch(fresh)
    }
    logger.info('generateConceptQuiz: beyond-document fill done', {
      extendedCount,
      totalSoFar: questions.length,
      requested: total,
    })
  }

  const response = buildQuizResponse(params, questions, firstResult, firstError)
  if (extendedCount > 0) response.extendedCount = extendedCount
  return response
}

/**
 * Public entry: concept-first when there's real material and a real request
 * (the planning pass needs both to pay off), chunked otherwise — and chunked
 * again if extraction fails or finds too little, so the professor never sees
 * a regression from the planner (design §10 fallback).
 */
export async function generateQuizQuestions(params: GenerateQuizParams): Promise<QuizGenerationResult> {
  const total = Math.max(1, params.questionCount)
  if (
    params.content &&
    params.content.length >= CONCEPT_MIN_CONTENT_CHARS &&
    // Beyond-document runs (incl. a small "fill the rest" deficit) always need
    // the concept plan to anchor topic-based questions — so bypass the
    // min-questions gate that otherwise keeps tiny requests on the chunked path.
    (total >= CONCEPT_MIN_QUESTIONS || params.beyondDocument)
  ) {
    // Concepts stored at upload time (design §11a) skip the whole-document
    // extraction call — the most expensive-input, slowest pre-question step.
    if (params.concepts && params.concepts.length >= CONCEPT_MIN_CONCEPTS) {
      params.onStatus?.(`Planning ${total} question${total === 1 ? '' : 's'} across ${params.concepts.length} saved topics…`)
      return generateConceptQuiz(params, params.concepts)
    }
    params.onStatus?.('Analyzing the material for key topics…')
    const extracted = await extractQuizConcepts(params.content, params.attribution, params.onUsage)
    if (extracted) {
      params.onStatus?.(`Found ${extracted.concepts.length} topics — planning ${total} question${total === 1 ? '' : 's'} across them…`)
      return generateConceptQuiz(params, extracted.concepts)
    }
    logger.warn('generateQuizQuestions: concept extraction failed or too thin — using chunked fallback')
  }
  params.onStatus?.('Writing questions from your material…')
  return generateChunkedQuiz(params)
}

// ── Topic Extraction ────────────────────────────────────────────

/** Max stored length for an AI-generated node summary (capped before storage). */
const SUMMARY_MAX_CHARS = 240

export interface TopicExtractionResult {
  topics: string[]
  /** One-line glanceable summary, or null when the model didn't return one. */
  summary: string | null
}

/**
 * Parse topics + an optional summary from the model's (possibly malformed) JSON.
 * Handles truncated responses by falling back to quoted-string extraction for
 * topics; the summary is only trusted from a clean object parse.
 */
export function parseTopicsAndSummary(text: string): { topics: string[] | null; summary: string | null } {
  let summary: string | null = null

  // Try clean JSON parse first
  try {
    const clean = extractJSON(text)
    const parsed = JSON.parse(clean)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.summary === 'string') {
      summary = parsed.summary.trim().slice(0, SUMMARY_MAX_CHARS) || null
    }
    if (Array.isArray(parsed?.topics)) {
      return { topics: parsed.topics.filter((t: unknown) => typeof t === 'string'), summary }
    }
    if (Array.isArray(parsed)) {
      return { topics: parsed.filter((t: unknown) => typeof t === 'string'), summary }
    }
  } catch {
    // Fall through to regex extraction (summary is lost on truncation — acceptable)
  }

  // Extract quoted strings from partial/truncated JSON
  const matches = text.match(/"([^"]{2,80})"/g)
  if (!matches) return { topics: null, summary }

  const topics = matches
    .map((m) => m.slice(1, -1)) // strip quotes
    .filter((t) => !['topics', 'topic', 'summary'].includes(t.toLowerCase())) // skip key names
    .filter((t) => t.length >= 2 && t.length <= 80)

  return { topics: topics.length >= 2 ? topics : null, summary }
}

/**
 * Extract 5-7 key topics + a one-line summary from lecture content using Gemini Flash.
 * Uses plain text generation with manual JSON parsing for maximum reliability.
 * Falls back to regex extraction from partial/truncated responses.
 * Returns { topics, summary }, or null if topic extraction fails.
 */
export async function extractTopicsFromContent(
  content: string,
  attribution?: AiAttribution,
): Promise<TopicExtractionResult | null> {
  try {
    if (!content.trim()) return null

    // Use only first 8000 chars — topics need a summary, not the full document.
    // Large inputs cause Gemini Flash preview to truncate its output.
    const truncatedContent = content.slice(0, 8000)

    const result = await generateText({
      model: google(TOPIC_EXTRACTION_MODEL),
      system: TOPIC_EXTRACTION_PROMPT,
      prompt: truncatedContent,
      temperature: 0.3,
      maxOutputTokens: 2000,
      providerOptions: {
        google: {
          // Gemini 3 Flash has thinking enabled by default, and thinking tokens
          // count against maxOutputTokens — causing truncated responses for
          // simple tasks. Set minimal thinking to preserve output budget.
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
      },
    })

    track('topic_extraction', TOPIC_EXTRACTION_MODEL, result.usage, attribution)

    if (!result.text) {
      logger.warn('extractTopicsFromContent: Empty response from model')
      return null
    }

    const { topics, summary } = parseTopicsAndSummary(result.text)

    if (!topics || topics.length < 2) {
      logger.warn('extractTopicsFromContent: Too few topics extracted', {
        count: topics?.length,
        text: result.text.slice(0, 300),
      })
      return null
    }

    return {
      topics: topics.map((t) => t.trim().slice(0, 100)).slice(0, 7),
      summary,
    }
  } catch (err) {
    logger.error('extractTopicsFromContent: Extraction failed', err)
    return null
  }
}

// ── Topic Mastery: section topic hierarchy ──────────────────────

// Plain schema for the structured call (no transforms — generateObject needs a
// clean object schema). Cleanup/trimming happens after.
const topicHierarchyLLMSchema = z.object({
  topics: z.array(
    z.object({
      name: z.string(),
      info: z.string().nullable(),
      subtopics: z.array(
        z.object({
          name: z.string(),
          info: z.string().nullable(),
        }),
      ),
    }),
  ),
})

/**
 * Suggest a curated two-level topic outline (main topics + subtopics) for a
 * whole course/section, for the Topic Mastery feature. Returns null on empty
 * input or failure — the professor can then build the list manually.
 * The result is a SUGGESTION: the professor reviews and curates before it's saved.
 */
export async function suggestSectionSkillHierarchy(
  content: string,
  attribution?: AiAttribution,
): Promise<SuggestedSkill[] | null> {
  try {
    if (!content.trim()) return null
    const truncated = content.slice(0, 100_000)

    const { object, usage } = await generateObject({
      model: google(TOPIC_EXTRACTION_MODEL),
      schema: topicHierarchyLLMSchema,
      system: SECTION_TOPIC_HIERARCHY_PROMPT,
      prompt: truncated,
      temperature: 0.3,
      maxOutputTokens: 4000,
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: 'minimal' } },
      },
    })

    track('topic_hierarchy', TOPIC_EXTRACTION_MODEL, usage, attribution)

    const clean = (s: string | null | undefined) => (s ?? '').trim()
    const cap = (s: string) => s.slice(0, TOPIC_NAME_MAX)
    const topics: SuggestedSkill[] = (object.topics || [])
      .map((t) => ({
        name: cap(clean(t.name)),
        info: clean(t.info).slice(0, 500) || undefined,
        subtopics: (t.subtopics || [])
          .map((s) => ({
            name: cap(clean(s.name)),
            info: clean(s.info).slice(0, 500) || undefined,
          }))
          .filter((s) => s.name.length > 0),
      }))
      .filter((t) => t.name.length > 0)

    return topics.length > 0 ? topics : null
  } catch (err) {
    logger.error('suggestSectionSkillHierarchy: failed', err)
    return null
  }
}

/**
 * Pick the best-fitting existing main topic for a newly-added topic, or null if
 * it's a distinct main topic. Used for AI placement-on-add (the professor decides).
 */
export async function suggestSkillParent(
  name: string,
  mains: string[],
  attribution?: AiAttribution,
): Promise<string | null> {
  try {
    if (!name.trim() || mains.length === 0) return null
    const { text, usage } = await generateText({
      model: google(TOPIC_EXTRACTION_MODEL),
      system:
        'Place a new course topic under the single best-fitting main topic. Reply with EXACTLY one main topic copied from the list, or "NONE" if it is itself a distinct main topic. No other text.',
      prompt: `New topic: "${name}"\nMain topics:\n${mains.map((m) => `- ${m}`).join('\n')}`,
      temperature: 0,
      maxOutputTokens: 40,
      providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
    })
    track('topic_parent', TOPIC_EXTRACTION_MODEL, usage, attribution)
    const ans = (text || '').trim().replace(/^["']|["']$/g, '')
    if (!ans || /^none$/i.test(ans)) return null
    return (
      mains.find((m) => m.toLowerCase() === ans.toLowerCase()) ??
      mains.find((m) => ans.toLowerCase().includes(m.toLowerCase())) ??
      null
    )
  } catch (err) {
    logger.error('suggestSkillParent: failed', err)
    return null
  }
}

// ── Phase Generation ────────────────────────────────────────────

export interface GeneratePhaseParams {
  /** Student's free-text planning document */
  planningDoc: string
  /** Professor-set project description */
  projectDescription?: string
  /** Professor-set project guidelines */
  projectGuidelines?: string
  /** Project due date (ISO string) for date range calculation */
  projectDueDate?: string | null
}

export interface GeneratedPhaseResult {
  title: string
  description: string
  start_date: string | null
  due_date: string | null
}


/**
 * Generate structured project phases from a planning document using Gemini.
 * AI decides the appropriate number of phases based on project scope.
 * Returns an array of phase objects, or an error message.
 */
export async function generateProjectPhases(
  params: GeneratePhaseParams,
  attribution?: AiAttribution,
): Promise<{ phases: GeneratedPhaseResult[]; error?: string }> {
  try {
    const systemPrompt = buildPhaseGenerationPrompt(params.projectDueDate)

    // Build context from all available sources
    const contextParts: string[] = []
    if (params.projectDescription) {
      contextParts.push(`PROJECT DESCRIPTION (from professor):\n${params.projectDescription}`)
    }
    if (params.projectGuidelines) {
      contextParts.push(`PROJECT GUIDELINES (from professor):\n${params.projectGuidelines}`)
    }
    contextParts.push(`STUDENT PLANNING DOCUMENT:\n${params.planningDoc}`)

    const content = contextParts.join('\n\n---\n\n')

    const { text, usage } = await generateText({
      model: google(PHASE_GENERATION_MODEL),
      system: systemPrompt,
      prompt: `Analyze the following project context and generate an appropriate number of structured phases:\n\n${content}`,
      temperature: 0.5,
      maxOutputTokens: 4000,
    })

    track('project_phases', PHASE_GENERATION_MODEL, usage, attribution)

    if (!text) {
      return { phases: [], error: 'No response from AI model' }
    }

    let parsed: { phases?: Array<{ title?: string; description?: string; start_date?: string | null; due_date?: string | null }> }
    try {
      parsed = JSON.parse(extractJSON(text))
    } catch {
      logger.error('generateProjectPhases: Failed to parse JSON', { responseText: text.slice(0, 500) })
      return { phases: [], error: 'AI returned invalid JSON' }
    }

    if (!Array.isArray(parsed.phases)) {
      return { phases: [], error: 'AI response missing phases array' }
    }

    // Validate and clean each phase
    const phases: GeneratedPhaseResult[] = []
    for (const raw of parsed.phases) {
      if (!raw.title) continue
      phases.push({
        title: String(raw.title).slice(0, 200),
        description: String(raw.description || '').slice(0, 2000),
        start_date: raw.start_date || null,
        due_date: raw.due_date || null,
      })
    }

    if (phases.length === 0) {
      return { phases: [], error: 'AI generated no valid phases' }
    }

    return { phases }
  } catch (err) {
    logger.error('generateProjectPhases: Generation failed', err)

    const raw = err instanceof Error ? err.message : String(err)
    if (isRateLimitError(raw)) {
      return { phases: [], error: 'The AI is busy right now. Please wait a minute and try again.' }
    }
    if (isContentTooLargeError(raw)) {
      return { phases: [], error: 'Content too large for AI model. Try shortening your planning document.' }
    }
    return { phases: [], error: raw }
  }
}

// ── Live Classroom Quiz Generation ──────────────────────────────

export interface LiveQuizQuestion {
  id: string
  prompt: string
  choices: Array<{ id: string; text: string }>
  correctChoiceId: string
  concept: string
  explanation: string
}

interface GenerateLiveQuizParams {
  slideContent: string
  transcription: string
  slidesCovered: number
  /** Section's tracked subtopic names — grounds each question's `concept` tag
   *  onto the real topic pool so it maps cleanly onto mastery. */
  conceptPool?: string[]
}

const liveQuizOutputSchema = z.object({
  title: z.string().min(1).max(200),
  questions: z.array(z.object({
    prompt: z.string().min(1),
    choices: z.array(z.object({
      text: z.string().min(1),
    })).min(4).max(4),
    correctChoiceIndex: z.number().int().min(0).max(3),
    concept: z.string().min(1).max(50),
    explanation: z.string().min(1),
  })).min(1).max(10),
})

export async function generateLiveQuizFromTranscription(
  params: GenerateLiveQuizParams,
  attribution?: AiAttribution,
): Promise<{ title: string; questions: LiveQuizQuestion[]; error?: string }> {
  try {
    const systemPrompt = buildLiveQuizPrompt(params.slidesCovered, params.conceptPool)

    const userContent = `--- Slide Content ---
${params.slideContent}

--- Professor's Spoken Transcription ---
${params.transcription}`

    const { object, usage } = await generateObject({
      model: google(LIVE_QUIZ_GENERATION_MODEL),
      schema: liveQuizOutputSchema,
      system: systemPrompt,
      prompt: userContent,
      temperature: 0.5,
    })

    track('live_quiz_generation', LIVE_QUIZ_GENERATION_MODEL, usage, attribution)

    const questions: LiveQuizQuestion[] = object.questions.map((q) => {
      const choices = q.choices.map((c, i) => ({
        id: generateId(),
        text: c.text,
        _index: i,
      }))

      const correctChoice = choices[q.correctChoiceIndex]
      if (!correctChoice) {
        logger.warn('generateLiveQuiz: invalid correctChoiceIndex', { index: q.correctChoiceIndex })
      }

      return {
        id: generateId(),
        prompt: q.prompt,
        choices: choices.map(({ id, text }) => ({ id, text })),
        correctChoiceId: correctChoice?.id ?? choices[0]?.id ?? '',
        concept: q.concept,
        explanation: q.explanation,
      }
    })

    return { title: object.title, questions }
  } catch (err) {
    logger.error('generateLiveQuizFromTranscription: failed', err)
    const raw = err instanceof Error ? err.message : String(err)
    return { title: '', questions: [], error: raw }
  }
}

// ── Live Classroom Lecture Summary ──────────────────────────────

interface SummarizeLectureParams {
  slideContent: string
  transcription: string
  slidesCovered: number
}

/**
 * Student "Catch me up": summarize the whole lecture so far from the
 * per-slide transcript + slide text. Returns markdown.
 */
export async function summarizeLectureContent(
  params: SummarizeLectureParams,
  attribution?: AiAttribution,
): Promise<{ summary: string; error?: string }> {
  try {
    const userContent = `--- Slide Content ---
${params.slideContent}

--- Professor's Spoken Transcription ---
${params.transcription}`

    const { text, usage } = await generateText({
      model: google(LECTURE_SUMMARY_MODEL),
      system: buildLectureSummaryPrompt(params.slidesCovered),
      prompt: userContent,
      temperature: 0.3,
      maxOutputTokens: 4000,
      providerOptions: {
        google: {
          // Summarizing supplied content is extraction, not deep reasoning —
          // cap thinking to keep mid-class latency low (mirrors
          // extractTopicsFromContent).
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
      },
    })

    track('lecture_summary', LECTURE_SUMMARY_MODEL, usage, attribution)

    if (!text || !text.trim()) {
      return { summary: '', error: 'No response from AI model' }
    }

    /* A refusal is not a summary (#646). With thin material the model replies asking
       for the content instead of summarizing it, and that reply used to be stored and
       shown to students AS their lecture recap — one stored summary was a 222-char
       "Please provide the text from the slides…". Only emptiness was checked, and a
       refusal is not empty.

       Treated as a generation failure so the caller's existing summaryFailed path
       renders an honest unavailable state, exactly as it already does for flashcards.
       Kept deliberately narrow: the phrase must appear at the START of a SHORT reply,
       so a genuine summary that happens to quote such a sentence is never discarded.
       Getting this wrong costs a real summary, so it errs toward keeping content. */
    const trimmed = text.trim()
    if (looksLikeSummaryRefusal(trimmed)) {
      logger.warn('summarizeLectureContent: model returned a refusal, not a summary', {
        length: trimmed.length,
        preview: trimmed.slice(0, 120),
      })
      return { summary: '', error: 'Not enough lecture material to summarize' }
    }

    return { summary: trimmed }
  } catch (err) {
    logger.error('summarizeLectureContent: failed', err)
    const raw = err instanceof Error ? err.message : String(err)
    return { summary: '', error: raw }
  }
}

// ── Live Classroom Session Report Narrative ─────────────────────

interface SessionReportNarrativeParams {
  /** Per-slide transcript, already truncated by the caller. */
  transcription: string
  /** JSON-serialized computed stats (attendance, quizzes, polls, Q&A). */
  statsJson: string
}

/**
 * Post-session report narrative for the professor. The numbers are all
 * computed in code; the model only writes the prose interpretation.
 */
export async function generateSessionReportNarrative(
  params: SessionReportNarrativeParams,
  attribution?: AiAttribution,
): Promise<{ narrative: string; error?: string }> {
  try {
    const userContent = `--- Lecture Transcript (per slide) ---
${params.transcription}

--- Computed Session Statistics ---
${params.statsJson}`

    const { text, usage } = await generateText({
      model: google(SESSION_REPORT_MODEL),
      system: buildSessionReportNarrativePrompt(),
      prompt: userContent,
      temperature: 0.3,
      maxOutputTokens: 2000,
      providerOptions: {
        google: {
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
      },
    })

    track('session_report', SESSION_REPORT_MODEL, usage, attribution)

    if (!text || !text.trim()) {
      return { narrative: '', error: 'No response from AI model' }
    }

    return { narrative: text.trim() }
  } catch (err) {
    logger.error('generateSessionReportNarrative: failed', err)
    const raw = err instanceof Error ? err.message : String(err)
    return { narrative: '', error: raw }
  }
}

// ── Class Insights: Flashcards + Practice Quiz (student study pack) ──

interface ClassInsightsGenParams {
  slideContent: string
  transcription: string
}

/**
 * Auto-generate study flashcards from a finished lecture's slide text +
 * spoken transcript. One call per ended room. Output is Zod-validated by the
 * schema before it reaches the caller.
 */
export async function generateFlashcards(
  params: ClassInsightsGenParams,
  attribution?: AiAttribution,
): Promise<{ cards: Flashcard[]; error?: string }> {
  try {
    const userContent = `--- Slide Content ---
${params.slideContent}

--- Professor's Spoken Transcription ---
${params.transcription}`

    const { object, usage } = await generateObject({
      model: google(CLASS_INSIGHTS_MODEL),
      schema: flashcardsOutputSchema,
      system: buildFlashcardsPrompt(),
      prompt: userContent,
      temperature: 0.4,
    })

    track('class_insights_flashcards', CLASS_INSIGHTS_MODEL, usage, attribution)

    return { cards: object.cards }
  } catch (err) {
    logger.error('generateFlashcards: failed', err)
    return { cards: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Auto-generate a static, ungraded, reveal-based practice quiz from a
 * finished lecture. One call per ended room. Output is Zod-validated.
 */
export async function generatePracticeQuiz(
  params: ClassInsightsGenParams,
  attribution?: AiAttribution,
): Promise<{ questions: PracticeQuestion[]; error?: string }> {
  try {
    const userContent = `--- Slide Content ---
${params.slideContent}

--- Professor's Spoken Transcription ---
${params.transcription}`

    const { object, usage } = await generateObject({
      model: google(CLASS_INSIGHTS_MODEL),
      schema: practiceQuizOutputSchema,
      system: buildPracticeQuizPrompt(),
      prompt: userContent,
      temperature: 0.5,
    })

    track('class_insights_practice_quiz', CLASS_INSIGHTS_MODEL, usage, attribution)

    return { questions: object.questions }
  } catch (err) {
    logger.error('generatePracticeQuiz: failed', err)
    return { questions: [], error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Transcript extraction (roadmap signals + Athena) ────────────

/**
 * Pull the professor's spoken commitments, exam scope, emphasis and off-deck
 * teaching out of one ended class (docs/designs/roadmap-mastery/roadmap-engine.md §5.1).
 *
 * Returns claims that are *shape*-valid only. They are NOT yet trustworthy —
 * the caller must run `verifyAndAnchorClaims()` to check each quote against the
 * real transcript before anything is stored. Zod can prove a quote is a string;
 * only the transcript can prove the professor said it.
 *
 * Temperature 0: this is extraction, not writing. Any creativity here shows up
 * as a promise the professor never made.
 */
export async function extractTranscriptInsights(
  params: { context: string },
  attribution?: AiAttribution,
): Promise<{ claims: ExtractedClaim[]; error?: string }> {
  try {
    const { object, usage } = await generateObject({
      model: google(CLASS_INSIGHTS_MODEL),
      schema: transcriptExtractionOutputSchema,
      system: buildTranscriptExtractionPrompt(),
      prompt: params.context,
      temperature: 0,
    })

    track('class_insights_transcript_extraction', CLASS_INSIGHTS_MODEL, usage, attribution)

    return { claims: object.claims }
  } catch (err) {
    logger.error('extractTranscriptInsights: failed', err)
    return { claims: [], error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Pre-Class Primer script (spoken advance organizer) ──────────

/**
 * Generate the spoken script for a Pre-Class Primer from a lecture's assembled
 * source content. One call per primer. Output is Zod-validated (a single
 * `script` string) before it reaches the caller. `userContent` is the labelled
 * source assembled by src/lib/preclass-audio/content.ts.
 */
export async function generatePrimerScript(
  userContent: string,
  attribution?: AiAttribution,
): Promise<{ script: string; error?: string }> {
  try {
    const { object, usage } = await generateObject({
      model: google(PRECLASS_PRIMER_MODEL),
      schema: primerScriptOutputSchema,
      system: buildPreclassPrimerPrompt(),
      prompt: userContent,
      temperature: 0.6,
    })

    track('primer_script', PRECLASS_PRIMER_MODEL, usage, attribution)

    return { script: object.script.trim() }
  } catch (err) {
    logger.error('generatePrimerScript: failed', err)
    return { script: '', error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Announcement rewrite ("Rewrite with Athena") ────────────────

/** Cap the input we send — announcements are short; this guards a pathological
 *  paste from blowing up the request. Matches the content field's own 10k cap. */
const ANNOUNCEMENT_REWRITE_MAX_CHARS = 10_000

/**
 * Polish a professor's announcement draft. Single generateText call — rewrites
 * the prose for clarity/tone while preserving facts (see the prompt). Plain text
 * in, plain text out; the caller re-renders it into the editor.
 */
export async function rewriteAnnouncement(
  content: string,
  attribution?: AiAttribution,
): Promise<{ text: string; error?: string }> {
  try {
    const trimmed = content.trim()
    if (!trimmed) return { text: '', error: 'Nothing to rewrite' }

    const { text, usage } = await generateText({
      model: google(ANNOUNCEMENT_REWRITE_MODEL),
      system: buildAnnouncementRewritePrompt(),
      prompt: trimmed.slice(0, ANNOUNCEMENT_REWRITE_MAX_CHARS),
      temperature: 0.4,
      maxOutputTokens: 4000,
      providerOptions: {
        // Rewriting supplied prose is not deep reasoning — cap thinking to keep
        // the round-trip snappy (mirrors summarizeLectureContent).
        google: { thinkingConfig: { thinkingLevel: 'minimal' } },
      },
    })

    track('announcement_rewrite', ANNOUNCEMENT_REWRITE_MODEL, usage, attribution)

    if (!text || !text.trim()) return { text: '', error: 'No response from AI model' }
    return { text: text.trim() }
  } catch (err) {
    logger.error('rewriteAnnouncement: failed', err)
    return { text: '', error: err instanceof Error ? err.message : String(err) }
  }
}
