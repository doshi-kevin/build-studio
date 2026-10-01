// Heuristic-gated query decomposition (design §2 box 1, §4 "Cross-lecture
// question").
//
// A single embedding can only chase one meaning. Ask "how do word2vec
// embeddings relate to the input representations a transformer sees?" and the
// vector lands between the two topics and matches neither confidently: measured
// on the golden set, that question retrieved 3 pages, topped out at 0.185, and
// recovered NONE of its gold. Split into "what is word2vec" + "what are a
// transformer's input representations", retrieve each, pool — and both lectures
// come back at 0.65 and 0.43.
//
// Gated, not always-on: most questions are single-topic and splitting them adds
// a model call and two extra searches for nothing. The gate is a cheap pattern
// match so a simple question never pays for the machinery.

import 'server-only'

import { generateObject } from 'ai'
import { google } from '@ai-sdk/google'
import { z } from 'zod'

import { logger } from '@/lib/logger'
import { recordAiUsage } from '@/lib/ai/usage'

/** Cheapest model in the fleet — this is a rewrite, not a reasoning task. */
const DECOMPOSE_MODEL = 'gemini-3.1-flash-lite-preview'

/** Two sub-queries is the shape that helps; more fragments the question. */
const MAX_SUB_QUERIES = 3

/**
 * Connectives that mean "this question spans two things".
 *
 * Deliberately NOT bare "and": course material is full of conjunctive titles
 * ("Seq2Seq and Attention", "GloVe and word2vec") and firing on those would
 * split single-topic questions. Every pattern here needs a relation between two
 * subjects, which is the case decomposition actually fixes.
 */
const MULTI_PART = /\b(relates? to|related to|relationship between|difference between|differences between|compared? (?:to|with)|comparison between|versus|vs\.?|as opposed to|connect(?:s|ed)? to|lead(?:s)? (?:up )?to|build(?:s)? on)\b/i

/** Below this a question is too short to be genuinely two-part. */
const MIN_WORDS = 6

/**
 * Should this question be split before retrieval?
 *
 * Pure and conservative: a false negative costs nothing (today's behaviour), a
 * false positive costs a model call and two searches. On the 28-case golden set
 * this fires on 3 — the ones that actually span two lectures.
 */
export function shouldDecompose(query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.split(/\s+/).length < MIN_WORDS) return false
  return MULTI_PART.test(trimmed)
}

const SubQueries = z.object({
  subQueries: z
    .array(z.string())
    .describe('Two or three standalone search queries, each about ONE topic from the question.'),
})

const SYSTEM = `You split a student's multi-topic question into standalone search queries for a course-material search engine.

Rules:
- One topic per sub-query. If the question asks how A relates to B, produce a query about A and a query about B.
- Each sub-query must stand alone — no pronouns, no "it", no reference to the other sub-query.
- Keep the student's own vocabulary; do not introduce terms they didn't use.
- 2 sub-queries normally, 3 only if the question genuinely covers three topics.
- If the question is really about ONE topic, return it unchanged as a single sub-query.
- Output only the queries.`

/**
 * Split a question into sub-queries. Returns `[]` when the split fails or adds
 * nothing, which the caller reads as "retrieve the original question" — a
 * decomposition outage must degrade to today's behaviour, never to an error.
 */
export async function decomposeQuery(
  query: string,
  scope: { institutionId: string; sectionId: string; userId?: string },
): Promise<string[]> {
  try {
    const { object, usage } = await generateObject({
      model: google(DECOMPOSE_MODEL),
      schema: SubQueries,
      system: SYSTEM,
      prompt: query,
      // No thinking budget: this is a rewrite, and reasoning tokens would cost
      // more than the retrieval it is trying to improve.
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
    })

    void recordAiUsage({
      feature: 'material_search',
      model: DECOMPOSE_MODEL,
      institutionId: scope.institutionId,
      sectionId: scope.sectionId,
      userId: scope.userId ?? null,
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
      },
      metadata: { stage: 'decompose' },
    })

    const cleaned = object.subQueries
      .map((q) => q.trim())
      .filter((q) => q.length > 0)
      .slice(0, MAX_SUB_QUERIES)

    // One sub-query is the model telling us the question was single-topic after
    // all — that's the original search, so say so rather than run it twice.
    return cleaned.length >= 2 ? cleaned : []
  } catch (error) {
    logger.warn('decomposeQuery: split failed — retrieving the whole question', {
      source: 'pinecone.decompose',
      sectionId: scope.sectionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
