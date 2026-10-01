// Quality gate for AI-generated quiz questions
// (docs/designs/quizzes/quiz-generation-v2.md §4c): semantic near-duplicate detection
// via embeddings, and a round-trip answerability check against the source
// material. Both fail OPEN — a broken checker must never block generation;
// the lexical dedup and Zod validation upstream still hold the floor.

import { embedMany, generateObject } from 'ai'
import { google } from '@ai-sdk/google'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import { QUIZ_ANALYSIS_MODEL } from '@/lib/ai/config'
import { QUIZ_ANSWERABILITY_PROMPT, QUIZ_TOPIC_CONSISTENCY_PROMPT, QUIZ_REDUNDANCY_PROMPT } from '@/lib/ai/prompts'
import { recordAiUsage, type AiAttribution } from '@/lib/ai/usage'
import type { TokenUsage } from '@/lib/ai/cost'
import type { CreateQuestionServerInput } from '@/lib/validations/quiz'

export const QUIZ_DEDUP_EMBEDDING_MODEL = 'gemini-embedding-2'

/**
 * Re-calibrated 2026-08-06 for gemini-embedding-2, which replaced
 * gemini-embedding-001 when the pgvector layer was retired (#435). Nothing is
 * stored, so the swap needed no backfill — but it did need this number redone,
 * because the two models do not score the same way.
 *
 * Measured on 14 real question pairs (tmp/rail-probe/dedup-calibrate.mts):
 *
 *   true paraphrases          0.816, 0.900, 0.906, 0.915, 0.933, 0.934
 *   same-topic-but-different  0.715 … 0.822, 0.834, 0.836, 0.843
 *
 * Unlike 001 — whose populations split cleanly at 0.85 — these OVERLAP, and the
 * overlap has a shape worth knowing: every near-miss is the same sentence frame
 * with a swapped concept ("Define the softmax function" vs "Define the sigmoid
 * function", 0.843), while the one weak paraphrase differs in question FORM
 * ("Define X" vs "What does X do?", 0.816). This model weighs phrasing more
 * heavily than 001 did.
 *
 * 0.87 therefore sits above the swapped-concept cluster with real margin rather
 * than splitting a gap that no longer exists. It accepts one known miss (the
 * define/what-does pair) because the two errors do not cost the same: a
 * near-duplicate that survives is visible to the professor reviewing the quiz,
 * while a legitimately different question dropped as a "duplicate" disappears
 * without a trace. Fourteen pairs is a small sample — widen it before moving
 * this number again.
 */
export const QUIZ_DEDUP_COSINE_THRESHOLD = 0.87

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Incremental semantic dedup across a whole generation run. Each batch's
 * candidate stems are embedded in ONE call; a candidate too close (cosine ≥
 * threshold) to ANY previously accepted stem — including earlier accepts in
 * the same batch — is dropped. Catches the paraphrases lexical matching
 * misses ("What is backprop?" vs "Explain backpropagation").
 */
export class SemanticDedup {
  private accepted: number[][] = []

  /** Attribution mirrors verifyAnswerability's param — embedding calls are
   *  paid input tokens and land on the cost ledger like every other call. */
  constructor(private attribution?: AiAttribution) {}

  async filterFresh<T>(items: T[], stemOf: (item: T) => string): Promise<T[]> {
    if (items.length === 0) return items
    try {
      const { embeddings, usage } = await embedMany({
        model: google.textEmbedding(QUIZ_DEDUP_EMBEDDING_MODEL),
        values: items.map(stemOf),
      })
      void recordAiUsage({
        feature: 'quiz_dedup_embedding',
        model: QUIZ_DEDUP_EMBEDDING_MODEL,
        institutionId: this.attribution?.institutionId,
        sectionId: this.attribution?.sectionId,
        userId: this.attribution?.userId,
        usage: { inputTokens: usage?.tokens ?? 0 },
      })
      const fresh: T[] = []
      for (let i = 0; i < items.length; i++) {
        const vec = embeddings[i]
        const isDup = this.accepted.some((a) => cosineSimilarity(a, vec) >= QUIZ_DEDUP_COSINE_THRESHOLD)
        if (isDup) continue
        this.accepted.push(vec)
        fresh.push(items[i])
      }
      if (fresh.length < items.length) {
        logger.info('SemanticDedup: dropped near-duplicates', { candidates: items.length, kept: fresh.length })
      }
      return fresh
    } catch (err) {
      // Fail open: embeddings down ≠ generation down.
      logger.warn('SemanticDedup: embedding failed — lexical dedup only', {
        error: err instanceof Error ? err.message : String(err),
      })
      return items
    }
  }
}

// ── Answerability (round-trip consistency) ──────────────────────

const verdictSchema = z.object({
  verdicts: z.array(z.object({ index: z.number().int(), ok: z.boolean() })),
})

/** Only key-verifiable types get the round-trip check — explanation/
 *  walkthrough have no single answer key; their rubric is the quality gate. */
const CHECKABLE_TYPES = new Set(['multiple_choice', 'true_false', 'short_answer', 'fill_in_blank'])

/** One-line answer key for the checker ("the marked answer"). */
function answerKeyText(content: CreateQuestionServerInput['content']): string {
  switch (content.questionType) {
    case 'multiple_choice':
      return content.choices.filter((c) => c.isCorrect).map((c) => c.text).join(' | ')
    case 'true_false':
      return String(content.correctAnswer)
    case 'short_answer':
      return content.acceptedAnswers.join(' | ')
    case 'fill_in_blank':
      return content.blanks.map((b) => b.acceptedAnswers.join('/')).join(' , ')
    default:
      return ''
  }
}

/** Bound the source excerpt we re-send for checking. */
const ANSWERABILITY_SOURCE_MAX_CHARS = 50_000

/**
 * Round-trip consistency check (the standard synthetic-QA filter): a second
 * cheap call verifies each question is answerable from the source excerpt and
 * that its marked answer agrees with the source. Returns the questions that
 * pass; on checker failure returns ALL questions (fail open).
 */
export async function verifyAnswerability<
  T extends { questionText: string; content: CreateQuestionServerInput['content'] },
>(questions: T[], sourceContent: string, attribution?: AiAttribution, onUsage?: (usage: TokenUsage) => void): Promise<T[]> {
  const checkable = questions
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => CHECKABLE_TYPES.has(q.content.questionType))
  if (checkable.length === 0) return questions

  try {
    const numbered = checkable
      .map(({ q, index }) => `${index}. [${q.content.questionType}] ${q.questionText}\n   Marked answer: ${answerKeyText(q.content)}`)
      .join('\n')
    const result = await generateObject({
      model: google(QUIZ_ANALYSIS_MODEL),
      schema: verdictSchema,
      system: QUIZ_ANSWERABILITY_PROMPT,
      prompt: `--- SOURCE EXCERPT ---\n${sourceContent.slice(0, ANSWERABILITY_SOURCE_MAX_CHARS)}\n\n--- QUESTIONS TO AUDIT ---\n${numbered}`,
      temperature: 0,
      maxOutputTokens: 2000,
      providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
    })
    if (result.usage) onUsage?.(result.usage)
    // Only honor verdicts for indices we actually submitted — a hallucinated
    // index must never drop a rubric question that was exempt from the audit.
    const checkableIdx = new Set(checkable.map(({ index }) => index))
    const bad = new Set(
      result.object.verdicts.filter((v) => !v.ok && checkableIdx.has(v.index)).map((v) => v.index),
    )
    // Ledger write carries the drop rate — the number that decides whether this
    // audit stage keeps earning its latency (design §10 / cost plan P0).
    void recordAiUsage({
      feature: 'quiz_answerability',
      model: QUIZ_ANALYSIS_MODEL,
      institutionId: attribution?.institutionId,
      sectionId: attribution?.sectionId,
      userId: attribution?.userId,
      usage: result.usage ?? {},
      metadata: { checked: checkable.length, dropped: bad.size },
    })
    if (bad.size > 0) {
      logger.warn('verifyAnswerability: dropped unanswerable/wrong-key questions', {
        checked: checkable.length,
        dropped: bad.size,
      })
    }
    return questions.filter((_, index) => !bad.has(index))
  } catch (err) {
    // Fail open: the checker is a net, not a gatekeeper.
    logger.warn('verifyAnswerability: check failed — keeping all questions', {
      error: err instanceof Error ? err.message : String(err),
    })
    return questions
  }
}

/** Bound the existing-question list sent to the redundancy audit: the most
 *  recent stems matter most, and 160 chars carries a stem's tested fact. */
const REDUNDANCY_EXISTING_MAX = 120
const REDUNDANCY_STEM_MAX_CHARS = 160

/**
 * Same-fact redundancy audit (the gap embedding dedup measurably can't close —
 * see QUIZ_REDUNDANCY_PROMPT): a cheap call judges whether each candidate
 * tests the SAME knowledge as a question already on the quiz (or an earlier
 * candidate in the same batch), regardless of phrasing or format. ALL types
 * are audited — redundancy is about the stem, not the answer key. Same
 * fail-open contract as the other audits.
 */
export async function verifyDistinctFacts<T>(
  candidates: T[],
  // Readable stem per candidate (fill-in-blank {{blank:...}} tokens rendered
  // as "_____" by the caller — internal token syntax must not reach the prompt).
  stemOf: (item: T) => string,
  existingStems: string[],
  attribution?: AiAttribution,
  onUsage?: (usage: TokenUsage) => void,
): Promise<T[]> {
  // Nothing to be redundant WITH: no priors and at most one candidate.
  if (candidates.length === 0 || (existingStems.length === 0 && candidates.length < 2)) {
    return candidates
  }
  try {
    const existing = existingStems
      .slice(-REDUNDANCY_EXISTING_MAX)
      .map((s) => `- ${s.slice(0, REDUNDANCY_STEM_MAX_CHARS)}`)
      .join('\n')
    const numbered = candidates
      .map((q, index) => `${index}. ${stemOf(q).slice(0, REDUNDANCY_STEM_MAX_CHARS)}`)
      .join('\n')
    const result = await generateObject({
      model: google(QUIZ_ANALYSIS_MODEL),
      schema: verdictSchema,
      system: QUIZ_REDUNDANCY_PROMPT,
      prompt: `--- EXISTING QUESTIONS ---\n${existing || '(none yet)'}\n\n--- CANDIDATES TO AUDIT ---\n${numbered}`,
      temperature: 0,
      maxOutputTokens: 2000,
      providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
    })
    if (result.usage) onUsage?.(result.usage)
    const validIdx = new Set(candidates.map((_, index) => index))
    const bad = new Set(
      result.object.verdicts.filter((v) => !v.ok && validIdx.has(v.index)).map((v) => v.index),
    )
    void recordAiUsage({
      feature: 'quiz_redundancy',
      model: QUIZ_ANALYSIS_MODEL,
      institutionId: attribution?.institutionId,
      sectionId: attribution?.sectionId,
      userId: attribution?.userId,
      usage: result.usage ?? {},
      metadata: { checked: candidates.length, dropped: bad.size },
    })
    if (bad.size > 0) {
      logger.warn('verifyDistinctFacts: dropped same-fact redundant questions', {
        checked: candidates.length,
        dropped: bad.size,
      })
    }
    return candidates.filter((_, index) => !bad.has(index))
  } catch (err) {
    logger.warn('verifyDistinctFacts: check failed — keeping all questions', {
      error: err instanceof Error ? err.message : String(err),
    })
    return candidates
  }
}

/**
 * Topic-consistency check for "beyond the document" (AI-extended) questions.
 * These aren't answerable from any source — the quality bar is instead: is the
 * question genuinely ON one of the allowed topics, and is its marked answer
 * correct by standard knowledge? Same shape/fail-open contract as
 * verifyAnswerability, but audits against a TOPIC LIST, not source content.
 */
export async function verifyTopicConsistency<
  T extends { questionText: string; content: CreateQuestionServerInput['content'] },
>(questions: T[], topics: string[], attribution?: AiAttribution, onUsage?: (usage: TokenUsage) => void): Promise<T[]> {
  const checkable = questions
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => CHECKABLE_TYPES.has(q.content.questionType))
  if (checkable.length === 0) return questions

  try {
    const numbered = checkable
      .map(({ q, index }) => `${index}. [${q.content.questionType}] ${q.questionText}\n   Marked answer: ${answerKeyText(q.content)}`)
      .join('\n')
    const result = await generateObject({
      model: google(QUIZ_ANALYSIS_MODEL),
      schema: verdictSchema,
      system: QUIZ_TOPIC_CONSISTENCY_PROMPT,
      prompt: `--- ALLOWED TOPICS ---\n${topics.map((t) => `- ${t}`).join('\n')}\n\n--- QUESTIONS TO AUDIT ---\n${numbered}`,
      temperature: 0,
      maxOutputTokens: 2000,
      providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
    })
    if (result.usage) onUsage?.(result.usage)
    const checkableIdx = new Set(checkable.map(({ index }) => index))
    const bad = new Set(
      result.object.verdicts.filter((v) => !v.ok && checkableIdx.has(v.index)).map((v) => v.index),
    )
    void recordAiUsage({
      feature: 'quiz_topic_consistency',
      model: QUIZ_ANALYSIS_MODEL,
      institutionId: attribution?.institutionId,
      sectionId: attribution?.sectionId,
      userId: attribution?.userId,
      usage: result.usage ?? {},
      metadata: { checked: checkable.length, dropped: bad.size },
    })
    if (bad.size > 0) {
      logger.warn('verifyTopicConsistency: dropped off-topic/incorrect questions', {
        checked: checkable.length,
        dropped: bad.size,
      })
    }
    return questions.filter((_, index) => !bad.has(index))
  } catch (err) {
    logger.warn('verifyTopicConsistency: check failed — keeping all questions', {
      error: err instanceof Error ? err.message : String(err),
    })
    return questions
  }
}
