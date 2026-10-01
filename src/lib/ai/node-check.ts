import 'server-only'

/**
 * Node-check generation — the cheapest useful call in the codebase.
 *
 * Produces a small pool of low-stakes comprehension questions for one piece of
 * supplementary material (docs/designs/roadmap-mastery/roadmap-engine.md §14). A student answers
 * five of them to tick the node; it is a nudge to actually open the paper, never
 * an assessment.
 *
 * Three deliberate economies, because this runs once per uploaded extra and the
 * output is worth very little:
 *
 * 1. **It reuses what upload already computed.** `content.concepts` (name +
 *    one-line summary + importance, written by the extraction worker) is a
 *    distilled version of the document. We never re-read the file from storage,
 *    never re-extract, never call vision, never embed.
 * 2. **It does not reuse the quiz prompt.** `buildQuizSystemPrompt` is ~3.2k
 *    tokens of rules for high-stakes, Bloom's-tagged, citation-bearing items.
 *    None of that applies here, and it would dwarf the actual content. The
 *    prompt below is a few lines. (§14.3 says reuse the quiz *generation* path;
 *    that was written before the cost constraint — the destination tables are
 *    still separate, which was the point of that decision.)
 * 3. **Flash-lite, minimal thinking, no explanations.** Explanations would
 *    roughly double the output tokens and are never shown.
 */

import { generateObject } from 'ai'
import { google } from '@ai-sdk/google'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import {
  NODE_CHECK_MAX_INPUT_CHARS,
  NODE_CHECK_MODEL,
  NODE_CHECK_POOL_SIZE,
} from '@/lib/ai/config'
import { recordAiUsage, type AiAttribution } from '@/lib/ai/usage'

/**
 * The text we can write questions from, cheapest-first.
 *
 * Supplementary material is NOT extracted at upload — extraction only runs on
 * uploaded documents, which land as `lecture` items. Measured on a real course:
 * every reference/video/link/image had zero `extraction`, zero `concepts` and
 * zero `topics`, but nearly all had a professor-written `description`. So for
 * extras the description IS the source; `summary`/`concepts` stay here for the
 * items that do carry extraction, and cost nothing when absent.
 */
export interface NodeCheckSource {
  title: string
  /** Professor-written blurb — the only real source on most extras. */
  description?: string
  /** One-line document summary from extraction (extracted items only). */
  summary?: string
  /** Distilled concepts (name + summary), ranked by importance at upload time. */
  concepts?: { name: string; summary?: string }[]
  /** Topic names, when extraction produced them. */
  topics?: string[]
}

export interface NodeCheckQuestion {
  prompt: string
  choices: string[]
  answerIndex: number
}

const questionSchema = z.object({
  q: z.string().min(8).max(300),
  /** Exactly four options; the FIRST is the correct one (shuffled after). */
  a: z.array(z.string().min(1).max(200)).length(4),
})

const outputSchema = z.object({
  /** The generator's own call: nothing here is worth testing (§14.1). */
  notQuizzable: z.boolean().optional(),
  questions: z.array(questionSchema).default([]),
})

const SYSTEM = `Write short multiple-choice questions that check whether someone actually read the material.
Rules:
- 4 options each. Put the CORRECT option FIRST; the other 3 must be plausible but wrong.
- Test recall of what the material says. No trick questions, no outside knowledge.
- One sentence per question. No explanations, no numbering, no preamble.
- If the material is a syllabus, a schedule, a format guide, or otherwise has no content to comprehend, return notQuizzable: true and no questions.`

/**
 * Trim the source to a bounded, cheap prompt, and report how much of it is
 * actual CONTENT — the title alone is a label, not something to ask about.
 */
function buildInput(src: NodeCheckSource): { text: string; contentChars: number } {
  const parts: string[] = [`Title: ${src.title}`]
  let contentChars = 0
  const push = (label: string, body: string) => {
    parts.push(`${label}: ${body}`)
    contentChars += body.length
  }

  // No instructor_note here on purpose: it is a private field (see the item
  // editor) and these questions are shown to students.
  if (src.description) push('Description', src.description)
  if (src.summary) push('Summary', src.summary)

  const concepts = (src.concepts ?? []).filter((c) => c.name)
  if (concepts.length) {
    parts.push('Key points:')
    for (const c of concepts) {
      const line = c.summary ? `- ${c.name}: ${c.summary}` : `- ${c.name}`
      parts.push(line)
      contentChars += line.length
      if (parts.join('\n').length > NODE_CHECK_MAX_INPUT_CHARS) break
    }
  } else if (src.topics?.length) {
    push('Topics', src.topics.join(', '))
  }

  return { text: parts.join('\n').slice(0, NODE_CHECK_MAX_INPUT_CHARS), contentChars }
}

/**
 * Minimum characters of real content before we spend a call. Deliberately
 * permissive: measured on a real course, supplementary descriptions top out
 * around 70 characters ("The original word2vec paper."), so a stricter bar
 * meant the check never appeared at all.
 *
 * The trade-off is accepted and worth stating plainly: questions written from a
 * one-line blurb test the blurb, so a student can often pass without opening
 * the material. That is tolerable ONLY because this tick is explicitly
 * effort-evidence and never an assessment (§14.2) — it must not become one. The
 * generator still returns `notQuizzable` when even the blurb has nothing to
 * ask about, and those nodes fall back to the self check-off.
 */
const MIN_CONTENT_CHARS = 40

/**
 * Deterministic-enough shuffle: the model is told to put the answer first, so
 * without this every correct answer would be option A.
 */
function shuffleAnswer(q: z.infer<typeof questionSchema>, seed: number): NodeCheckQuestion {
  const target = seed % 4
  const choices = [...q.a]
  ;[choices[0], choices[target]] = [choices[target], choices[0]]
  return { prompt: q.q, choices, answerIndex: target }
}

export interface NodeCheckResult {
  questions: NodeCheckQuestion[]
  /** True when there is genuinely nothing to test — caller falls back to a self check-off. */
  notQuizzable: boolean
}

/**
 * Generate one item's pool. Returns `notQuizzable` (rather than throwing) both
 * when the model says so and when there is too little distilled source to ask
 * about — either way the node falls back to a plain self check-off, which
 * already works, so nothing is blocked by a weak generation.
 */
export async function generateNodeCheck(
  src: NodeCheckSource,
  attribution?: AiAttribution,
): Promise<NodeCheckResult> {
  const input = buildInput(src)
  // Don't pay for a call we already know will produce filler.
  if (input.contentChars < MIN_CONTENT_CHARS) return { questions: [], notQuizzable: true }

  try {
    const { object, usage } = await generateObject({
      model: google(NODE_CHECK_MODEL),
      system: SYSTEM,
      prompt: `${input.text}\n\nWrite ${NODE_CHECK_POOL_SIZE} questions.`,
      schema: outputSchema,
      temperature: 0.6,
      maxOutputTokens: 3000,
      providerOptions: {
        google: {
          // Writing recall questions from a supplied summary is not reasoning.
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
      },
    })

    void recordAiUsage({
      feature: 'roadmap_node_check',
      model: NODE_CHECK_MODEL,
      institutionId: attribution?.institutionId,
      sectionId: attribution?.sectionId,
      userId: attribution?.userId,
      usage,
    })

    if (object.notQuizzable || object.questions.length === 0) {
      return { questions: [], notQuizzable: true }
    }
    return {
      questions: object.questions.map((q, i) => shuffleAnswer(q, i + 1)),
      notQuizzable: false,
    }
  } catch (error) {
    logger.error('generateNodeCheck: failed', error, { title: src.title })
    throw error
  }
}
