// Pure planning logic for concept-first quiz generation
// (docs/designs/quizzes/quiz-generation-v2.md §2 boxes 2 — no AI calls, no I/O, fully
// unit-testable). The AI pieces (concept extraction, per-batch generation)
// live in src/lib/ai/llm-client.ts.

import { z } from 'zod'
import { logger } from '@/lib/logger'

/** One assessable concept extracted from the source material. */
export interface QuizConcept {
  name: string
  /** 1-10, how central to the material (extraction orders by this). */
  importance: number
  /** Exact source-marker lines ("[Title, page 4]") of the blocks teaching it. */
  markers: string[]
  /** One line on what a question about it should test. */
  summary: string
}

// ── Stored per-material concepts (design §11a) ──────────────────
// Written by the extraction worker at upload (module_items.content.concepts),
// consumed by quiz generation so a run skips the whole-document extraction
// call. Markers are stored as PAGE NUMBERS, not "[Title, page N]" strings —
// items get renamed after upload; their pages don't move.

export const storedQuizConceptSchema = z.object({
  name: z.string().min(1).max(120),
  importance: z.number().int().min(1).max(10),
  pages: z.array(z.number().int().min(1)).max(6),
  summary: z.string().max(300),
})
export type StoredQuizConcept = z.infer<typeof storedQuizConceptSchema>

/** Page numbers from "[Title, page N]" marker lines (dedup, sorted) — how the
 *  worker converts extraction markers into the title-independent stored form. */
export function pagesFromMarkers(markers: string[]): number[] {
  const pages = new Set<number>()
  for (const m of markers) {
    const match = /, page (\d+)\]$/.exec(m.trim())
    if (match) pages.add(Number(match[1]))
  }
  return [...pages].sort((a, b) => a - b).slice(0, 6)
}

/**
 * Rebuild runtime QuizConcepts from per-item stored concepts. Markers are
 * regenerated against each item's CURRENT title (matching the block markers
 * getExtractionContextForLLM emits at run time), then near-duplicate names
 * across items are merged — higher importance wins, markers union, first
 * summary kept — and the result is re-ranked. This is the merge the old
 * single whole-content extraction call did implicitly.
 */
export function mergeStoredConcepts(
  items: { title: string; concepts: StoredQuizConcept[] }[],
): QuizConcept[] {
  const byKey = new Map<string, QuizConcept>()
  for (const item of items) {
    for (const c of item.concepts) {
      const name = c.name.trim()
      const key = name.toLowerCase().replace(/\s+/g, ' ')
      if (!key) continue
      const markers = c.pages.map((p) => `[${item.title}, page ${p}]`)
      const existing = byKey.get(key)
      if (existing) {
        existing.importance = Math.max(existing.importance, c.importance)
        for (const m of markers) if (!existing.markers.includes(m)) existing.markers.push(m)
      } else {
        byKey.set(key, { name, importance: c.importance, markers, summary: c.summary })
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.importance - a.importance)
}

/** One planned generation call: which concepts it covers (one question each). */
export interface QuizBatch {
  concepts: QuizConcept[]
  difficulty?: { easy: number; medium: number; hard: number }
}

export interface QuizPlan {
  batches: QuizBatch[]
  /** Ranked concepts not yet assigned — drawn on when a batch under-delivers
   *  (dedup/validation drops) so the final count still lands on target. */
  pool: QuizConcept[]
  /** All concepts, importance-ranked — when the pool is empty, makeup batches
   *  cycle through these again (the avoid-list forces a different angle). */
  ranked: QuizConcept[]
}

/** First batch is small so the professor sees questions in seconds; later
 *  batches do the bulk. Their review time overlaps the remaining generation,
 *  so perceived wait ≈ time-to-first-batch (design §4b). */
export const QUIZ_BATCH_RAMP = [3, 5]
/** Raised 10→25 (2026-07-18, design §12): a live A/B on the same 30-question
 *  request measured the 22-question batch as the cheapest AND most stable call
 *  shape (−30% cost, −30% wall-clock, 30/30 both runs) — runaway failures
 *  cluster on ask≤3 makeup batches, not big ones, and per-concept passage
 *  narrowing keeps a 24-ask call under ~6k input tokens. Tradeoff accepted: a
 *  persistently-failing mega-batch blacklists more concepts at once (bounded
 *  by retry-at-minimal + salvage). */
export const QUIZ_BATCH_MAX = 25

/** Batch sizes for `total` questions: [3, 5, 10, 10, …, remainder]. Small
 *  requests (≤ first ramp step + 2) stay a single call — the ramp would only
 *  add call overhead. */
export function rampBatchSizes(total: number): number[] {
  if (total <= QUIZ_BATCH_RAMP[0] + 2) return [total]
  const sizes: number[] = []
  let left = total
  for (const step of QUIZ_BATCH_RAMP) {
    if (left <= 0) break
    const take = Math.min(step, left)
    sizes.push(take)
    left -= take
  }
  while (left > 0) {
    const take = Math.min(QUIZ_BATCH_MAX, left)
    sizes.push(take)
    left -= take
  }
  return sizes
}

/**
 * Split the LLM content dump into blocks keyed by their source-marker line.
 * `buildQuizGenerationContext` emits blocks that each start with a line like
 * "[601-sp09-midterm-solutions, page 3]"; everything up to the next marker
 * belongs to that block. Text before the first marker (title headers etc.) is
 * returned as `preamble` and prepended to every batch's content.
 */
export function splitContentBlocks(content: string): { preamble: string; blocks: Map<string, string> } {
  const blocks = new Map<string, string>()
  const markerRe = /^\[[^\]\n]+, page \d+\]$/gm
  const matches = [...content.matchAll(markerRe)]
  if (matches.length === 0) return { preamble: content, blocks }
  const preamble = content.slice(0, matches[0].index).trim()
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length
    const marker = matches[i][0]
    // Two concepts can share a page — keep the first occurrence (identical text).
    if (!blocks.has(marker)) blocks.set(marker, content.slice(start, end).trim())
  }
  return { preamble, blocks }
}

/** Cap per-batch passage content — passages are the whole point of the cost
 *  win (never re-send everything), but a batch of broad concepts could still
 *  union most of the document. */
const BATCH_CONTENT_MAX_CHARS = 60_000

/** Parse a "[Title, page N]" marker into comparable parts (null if malformed). */
function parseMarker(marker: string): { title: string; page: number } | null {
  const m = /^\[(.+), page (\d+)\]$/.exec(marker.trim())
  return m ? { title: m[1].trim().toLowerCase(), page: Number(m[2]) } : null
}

/**
 * Assemble the content for one batch: the unique source blocks its concepts
 * reference, in document order, prefixed by the preamble.
 *
 * Matching is exact-first, then FUZZY (same page + title containment either
 * way, case-insensitive): runtime-extracted markers are model-copied strings,
 * and one formatting drift — a shortened title, different casing — used to
 * zero out every match and silently re-send the ENTIRE corpus on every batch
 * (benchmark 2026-07-18 s60: 1.08M input tokens for 13 questions). The
 * full-content fallback is kept for truly unresolvable markers, but capped —
 * a question grounded in too much context beats one grounded in none, yet the
 * fallback must never cost more than a narrowed batch is allowed to.
 */
export function passagesForBatch(
  batch: QuizBatch,
  preamble: string,
  blocks: Map<string, string>,
  fullContent: string,
): string {
  const wanted = [...new Set(batch.concepts.flatMap((c) => c.markers))]
  const matched = new Set<string>()
  const unresolved: string[] = []
  for (const w of wanted) {
    if (blocks.has(w)) matched.add(w)
    else unresolved.push(w)
  }
  if (unresolved.length > 0) {
    const parsedBlocks = [...blocks.keys()]
      .map((key) => ({ key, parsed: parseMarker(key) }))
      .filter((b): b is { key: string; parsed: { title: string; page: number } } => b.parsed !== null)
    for (const w of unresolved) {
      const p = parseMarker(w)
      if (!p) continue
      for (const b of parsedBlocks) {
        if (
          b.parsed.page === p.page &&
          (b.parsed.title.includes(p.title) || p.title.includes(b.parsed.title))
        ) {
          matched.add(b.key)
        }
      }
    }
  }
  const parts: string[] = []
  for (const [marker, text] of blocks) {
    if (matched.has(marker)) parts.push(text)
  }
  if (parts.length === 0) {
    logger.warn('passagesForBatch: no concept markers resolved — capped full-content fallback', {
      wanted: wanted.slice(0, 4),
      blockCount: blocks.size,
    })
    // fullContent already begins with the preamble — cap only, no prepend.
    return fullContent.slice(0, BATCH_CONTENT_MAX_CHARS)
  }
  const body = parts.join('\n\n').slice(0, BATCH_CONTENT_MAX_CHARS)
  return preamble ? `${preamble}\n\n${body}` : body
}

/**
 * Order makeup picks so a deficit is refilled from the LEAST-visited concepts
 * first (importance breaks ties). The old head-of-ranked cycling piled every
 * makeup question onto the already-heaviest top concepts — the s100 benchmark's
 * same-fact clusters (5× perplexity, 5× BLEU-vs-ROUGE) all sat on top-ranked
 * concepts. Repeats (take > concepts available) cycle the sorted order.
 */
export function pickLeastVisited(
  concepts: QuizConcept[],
  visits: Map<string, number>,
  take: number,
): QuizConcept[] {
  if (concepts.length === 0 || take <= 0) return []
  const sorted = [...concepts].sort(
    (a, b) => (visits.get(a.name) ?? 0) - (visits.get(b.name) ?? 0) || b.importance - a.importance,
  )
  return Array.from({ length: take }, (_, i) => sorted[i % sorted.length])
}

/**
 * Allocate `total` questions across ranked concepts and split them into ramped
 * batches. Concepts are consumed in importance order (extraction pre-sorts;
 * re-sorted defensively); when there are fewer concepts than questions we
 * cycle back through them — the generation prompt then covers the same concept
 * from a different angle. Whole-quiz difficulty distribution is sliced across
 * batches exactly (same guarantee as the legacy splitDifficultyAcrossChunks).
 */
export function planQuizBatches(
  concepts: QuizConcept[],
  total: number,
  difficultyDistribution?: { easy: number; medium: number; hard: number },
): QuizPlan {
  const ranked = [...concepts].sort((a, b) => b.importance - a.importance)
  const sizes = rampBatchSizes(total)

  // Difficulty: flatten to a per-question list, slice per batch.
  const flatDiff: ('easy' | 'medium' | 'hard')[] | null = difficultyDistribution
    ? [
        ...Array<'easy'>(difficultyDistribution.easy).fill('easy'),
        ...Array<'medium'>(difficultyDistribution.medium).fill('medium'),
        ...Array<'hard'>(difficultyDistribution.hard).fill('hard'),
      ]
    : null

  const batches: QuizBatch[] = []
  let slot = 0
  for (const size of sizes) {
    const batchConcepts: QuizConcept[] = []
    for (let i = 0; i < size; i++) {
      batchConcepts.push(ranked[(slot + i) % ranked.length])
    }
    const batch: QuizBatch = { concepts: batchConcepts }
    if (flatDiff) {
      const sliceDiff = flatDiff.slice(slot, slot + size)
      batch.difficulty = {
        easy: sliceDiff.filter((d) => d === 'easy').length,
        medium: sliceDiff.filter((d) => d === 'medium').length,
        hard: sliceDiff.filter((d) => d === 'hard').length,
      }
    }
    batches.push(batch)
    slot += size
  }

  // Replacement pool: ranked concepts never assigned to any slot. Empty when
  // total ≥ concepts.length (every concept already used at least once).
  const pool = slot < ranked.length ? ranked.slice(slot) : []
  return { batches, pool, ranked }
}
