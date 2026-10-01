// Unified quiz-result normalizer.
//
// A quiz can be **standard** (everyone gets the same fixed questions) or
// **adaptive** (the engine picks each next question from how the student is
// doing). Historically the two produced completely different result shapes.
// `toUnifiedResult` collapses either into ONE `UnifiedResult`: the same grade,
// the same per-question review, the same topic breakdown — with the
// adaptive-only ability estimate carried as a clearly-separated optional block
// (never the grade).
//
// This module is intentionally PURE: it takes already-fetched, already-mapped
// rows and returns a value. No DB, no auth, no I/O — so it is exhaustively
// unit-testable and reusable by every surface (student results, professor
// insights, professor per-student detail). See
// docs/designs/quizzes/quiz-analytics-unification.md.

import { calculateSkillInsights, type SkillPerformanceResult } from './analytics-utils'

// ── Inputs (decoupled from DB row shape on purpose) ─────────────────

/**
 * The attempt fields the normalizer needs. `theta`/`se`/`stopReason` live
 * directly on the `quiz_attempts` row (not on the `QuizAttempt` domain type),
 * so we model just what we read here rather than depend on that type.
 */
export interface UnifiedAttemptInput {
  score: number | null // 0–100, the canonical grade for BOTH quiz types
  totalPoints: number | null
  earnedPoints: number | null
  resolvedQuestionIds: string[] // the questions actually served this attempt
  cohort: 'adaptive' | 'control' | null
  // Adaptive ability signals (any may be null):
  theta: number | null // v2 IRT ability estimate θ̂
  se: number | null // v2 IRT standard error
  stopReason: string | null // why the adaptive engine stopped
  finalRating: number | null // v1 Elo rating (fallback when no IRT θ̂)
}

export interface UnifiedAnswerInput {
  questionId: string
  isCorrect: boolean | null
  earnedPoints: number | null
  softScore: number | null // adaptive partial-credit grade in [0,1]
  textAnswer: string | null
  rationale: string | null // AI grading rationale (already access-gated by caller)
  nodesMet: number | null // rubric coverage — counts only, never node concepts
  nodesTotal: number | null
  isFormative: boolean // formative items are excluded from grade/topic stats
}

export interface UnifiedQuestionInput {
  id: string
  questionText: string
  type: string // content.questionType
  points: number
  tags: string[]
}

export interface ToUnifiedResultInput {
  isAdaptive: boolean
  passThreshold: number // 0–100
  attempt: UnifiedAttemptInput
  answers: UnifiedAnswerInput[]
  questions: UnifiedQuestionInput[] // every question we could resolve (served + fixed)
  fixedQuestionIds: string[] // the quiz's fixed assignment order (standard / fallback)
}

// ── Output ──────────────────────────────────────────────────────────

export interface UnifiedReviewQuestion {
  questionId: string
  questionText: string
  type: string
  points: number
  isCorrect: boolean | null
  earnedPoints: number | null
  textAnswer: string | null
  // Adaptive-only detail — `undefined` for standard, so the UI simply omits it:
  softScore?: number
  rationale?: string
  nodesMet?: number
  nodesTotal?: number
}

export interface AbilityEstimate {
  engine: 'irt' | 'elo'
  theta?: number // IRT θ̂
  se?: number // IRT standard error
  rating?: number // Elo final rating
  itemsServed: number
  stopReason: string | null
}

export interface UnifiedResult {
  isAdaptive: boolean
  grade: number // 0–100, the one comparable number that leads every page
  pass: boolean
  passThreshold: number
  totalPoints: number | null
  earnedPoints: number | null
  questionReview: UnifiedReviewQuestion[]
  topics: SkillPerformanceResult
  /** Adaptive-only diagnostic. `null` for standard, or when no signal exists. */
  ability: AbilityEstimate | null
  /**
   * True when neither the served list nor the fixed list resolved any
   * questions (e.g. a legacy attempt with no recorded served IDs). Lets the UI
   * render "no questions recorded" instead of a broken 0/0.
   */
  noQuestionsRecorded: boolean
}

// ── Question resolver ────────────────────────────────────────────────

/**
 * Pick the ordered question list for an attempt: the attempt's actually-served
 * questions when present (this is what fixes the broken adaptive views), else
 * fall back to the quiz's fixed assignment list. Either may be empty — the
 * caller treats an empty result as "no questions recorded".
 */
export function resolveQuestionOrder(servedIds: string[], fixedIds: string[]): string[] {
  return servedIds.length > 0 ? servedIds : fixedIds
}

// ── Ability resolver ─────────────────────────────────────────────────

/**
 * Prefer v2 IRT (θ̂/SE) when present; else fall back to v1 Elo (final rating);
 * else omit the block entirely. Standard quizzes never have an ability block.
 */
function resolveAbility(attempt: UnifiedAttemptInput, itemsServed: number): AbilityEstimate | null {
  if (attempt.theta != null) {
    return {
      engine: 'irt',
      theta: attempt.theta,
      // SE defaults to a wide 1.0 when absent so the UI never shows a
      // misleadingly tight ± on an unknown error.
      se: attempt.se ?? 1,
      itemsServed,
      stopReason: attempt.stopReason,
    }
  }
  if (attempt.finalRating != null) {
    return {
      engine: 'elo',
      rating: attempt.finalRating,
      itemsServed,
      stopReason: attempt.stopReason,
    }
  }
  return null
}

// ── Normalizer ───────────────────────────────────────────────────────

export function toUnifiedResult(input: ToUnifiedResultInput): UnifiedResult {
  const { isAdaptive, passThreshold, attempt, answers, questions, fixedQuestionIds } = input

  const order = resolveQuestionOrder(attempt.resolvedQuestionIds, fixedQuestionIds)
  const questionById = new Map(questions.map((q) => [q.id, q]))
  const answerByQuestion = new Map(answers.map((a) => [a.questionId, a]))

  // Per-question review follows the resolved order; skip ids we couldn't load
  // (e.g. a since-deleted question) rather than render a blank row.
  const questionReview: UnifiedReviewQuestion[] = []
  for (const qId of order) {
    const q = questionById.get(qId)
    if (!q) continue
    const a = answerByQuestion.get(qId)
    const review: UnifiedReviewQuestion = {
      questionId: q.id,
      questionText: q.questionText,
      type: q.type,
      points: q.points,
      isCorrect: a?.isCorrect ?? null,
      earnedPoints: a?.earnedPoints ?? null,
      textAnswer: a?.textAnswer ?? null,
    }
    // Attach adaptive-only detail only when it carries information, so standard
    // reviews stay clean and the UI can branch on presence.
    if (a) {
      if (a.softScore != null) review.softScore = a.softScore
      if (a.rationale) review.rationale = a.rationale
      if (a.nodesTotal != null) {
        review.nodesMet = a.nodesMet ?? 0
        review.nodesTotal = a.nodesTotal
      }
    }
    questionReview.push(review)
  }

  // Topics reuse the existing shared util. For adaptive answers graded by
  // soft-score (isCorrect null), treat ≥ 0.5 as correct so partial credit still
  // informs strengths/weaknesses. Formative items never count toward topics.
  const topicAnswers = answers
    .filter((a) => !a.isFormative)
    .map((a) => ({
      questionId: a.questionId,
      isCorrect: a.isCorrect ?? (a.softScore != null ? a.softScore >= 0.5 : false),
    }))
  /* Collapse casing variants of the same tag before counting. Tags are free
     text written by professors AND by the AI generator, and the two write paths
     disagree on casing, so "Backprop" and "backprop" used to appear as two
     separate rows on this one screen.

     Deliberately NOT canonicalizeName, even though that is the skill pool's
     de-dup key. It strips every non-alphanumeric character, which merges "C++",
     "C#" and "C" into one topic — fine when the target is a curated skill a
     professor can rename, wrong for raw per-question tags on a programming
     course, where it would silently mislabel a row. Case and surrounding
     whitespace are the actual disagreement between the two write paths, so
     that is all this folds.

     The counts themselves stay per-attempt and raw: for a single attempt "you
     got 3 of 5" is the right answer, and a mastery score (weighted,
     recency-decayed) is not defined for one event. */
  const foldTag = (tag: string) => tag.trim().toLowerCase().replace(/\s+/g, ' ')
  const displayForFolded = new Map<string, string>()
  for (const q of questions) {
    for (const tag of q.tags) {
      const key = foldTag(tag)
      if (key && !displayForFolded.has(key)) displayForFolded.set(key, tag.trim())
    }
  }
  const questionTags: Record<string, string[]> = {}
  for (const q of questions) {
    questionTags[q.id] = [
      ...new Set(q.tags.map((tag) => displayForFolded.get(foldTag(tag)) ?? tag).filter(Boolean)),
    ]
  }
  const topics = calculateSkillInsights(topicAnswers, questionTags)

  const grade = attempt.score ?? 0
  const ability = isAdaptive ? resolveAbility(attempt, attempt.resolvedQuestionIds.length) : null

  return {
    isAdaptive,
    grade,
    pass: grade >= passThreshold,
    passThreshold,
    totalPoints: attempt.totalPoints,
    earnedPoints: attempt.earnedPoints,
    questionReview,
    topics,
    ability,
    noQuestionsRecorded: questionReview.length === 0,
  }
}
