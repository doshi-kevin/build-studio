/**
 * Shared types for the AI-grading pipeline (v3 — whole-submission + retrieval fallback).
 * Pure: no server-only import, no side effects — safe to import anywhere.
 */

// ── Thresholds ────────────────────────────────────────────────────────────────

/** Max chars before we fall back from whole-submission to per-question region retrieval. */
export const WHOLE_SUBMISSION_MAX_CHARS = 60_000

/**
 * Advisory similarity threshold below which a ticked criterion with unverifiable evidence
 * gets a structured "No supporting signal found." note prepended to its rationale.
 * Uncalibrated — treat as a hint, never as a hard gate.
 */
export const LOW_SIMILARITY_THRESHOLD = 0.5

/**
 * Similarity-only mode (AI_GRADING_SIMILARITY_ONLY=1): a criterion is ticked when its
 * max passage cosine clears this AND no required keyword is missing. Calibrated for
 * sentence-window chunks (similarity v2): 0.83 was the best per-question-accuracy
 * threshold in the HW2 eval (docs/designs/assignments-grading/ai-grading-eval-reports.md Report 3). Experimental —
 * similarity catches Wrong well but under-awards full credit; see Report 3 takeaway.
 */
export const SIMILARITY_TICK_THRESHOLD = 0.83

/**
 * Hybrid mode: a criterion is auto-certified (ticked, no LLM review) when its
 * max passage cosine ≥ this AND no required keyword is missing. Criteria below
 * go to the LLM review call. Raised 0.80 → 0.85 after the Report 5 run showed
 * 4 false certifications on the weakest submission at 0.80 (certified ticks
 * are never LLM-reviewed, so certification precision matters more than recall).
 */
export const HYBRID_SIMILARITY_TICK_THRESHOLD = 0.85

/** Number of top passages retrieved per question in region mode. */
export const REGION_TOP_K = 3

/** Max chars of retrieved passages for a single question (region mode). */
export const MAX_REGION_CHARS_PER_QUESTION = 12_000

/** Max total region chars across all questions (region mode). */
export const MAX_REGION_CHARS_TOTAL = 48_000

export const MAX_EMBED_CHUNK_CHARS = 8000

/**
 * Rough token estimate from character count (English prose).
 * Treat as advisory — never a correctness dependency.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

// ── Core types ────────────────────────────────────────────────────────────────

export interface KeywordResult {
  required: string[]
  found: string[]
  missing: string[]
}

/** One rubric criterion, fully resolved, ready for the grader. */
export interface CriterionRef {
  /** Composite key: "<questionIndex>:<criterionIndex>" */
  key: string
  questionIndex: number
  questionLabel: string
  criterionIndex: number
  description: string
  points: number
  referenceAnswer: string | null
  absoluteKeywords: string[]
  /** Equivalent surface forms per required keyword — folded into the keyword check so an
   *  answer in an equivalent notation is not scored a miss. */
  keywordAliases: { term: string; aliases: string[] }[]
  /** Keyword check result computed against the whole submission text. */
  keywordResult: KeywordResult | null
  /** Max cosine similarity between any passage vector and this criterion's reference vector.
   *  null when no reference vector exists, no passages were produced, or embedding failed. */
  similarity: number | null
}

/** A retrieved region of text for one question (region mode only). */
export interface QuestionRegion {
  questionIndex: number
  questionLabel: string
  text: string
}

/**
 * All context assembled for one student submission, ready for the LLM grader.
 *
 * mode 'whole'   — entire submission fits in context; wholeText is set.
 * mode 'regions' — submission exceeded WHOLE_SUBMISSION_MAX_CHARS; per-question
 *                  regions retrieved via cosine search; regions is set.
 *
 * submissionText is always set to the full (possibly truncated) normalized text
 * for evidence verification and keyword checks, regardless of mode.
 */
export interface GradingContext {
  mode: 'whole' | 'regions'
  /** All criteria in (qIdx, cIdx) order, numbered 1..N. */
  criteria: CriterionRef[]
  /** Set in mode 'whole'. */
  wholeText: string | null
  /** Set in mode 'regions'. */
  regions: QuestionRegion[] | null
  /** Normalized whole text for evidence verification + keyword checks. */
  submissionText: string
  /** True when embedding failed during region fallback; lowers confidence. */
  degraded: boolean
}

// ── Output types ─────────────────────────────────────────────────────────────

export interface SuggestedCriterion {
  key: string
  tick: boolean
  suggestedPoints: number
  rationale: string
  flagged: boolean
  /** Verbatim quote the model cited as supporting evidence. Empty string when none. */
  evidence: string
  /** Copied from CriterionRef.similarity — persisted so the UI can show it without re-running signals. */
  similarity: number | null
}

export interface AiGradeSuggestion {
  criteria: SuggestedCriterion[]
  /** Criterion keys with tick=true — drop-in for gradeSubmission.rubricScores. */
  suggestedRubricScores: string[]
  suggestedScore: number
  feedback: string
  confidence: 'high' | 'medium' | 'low'
  flaggedCount: number
  unmappedQuestionIndexes: number[]
  model: string
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 when either vector has zero norm (guard against NaN).
 * Pure: no I/O, no imports.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dot / denom
}
