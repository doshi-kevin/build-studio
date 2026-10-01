/**
 * Passage chunker for the AI-grading retrieval pipeline.
 *
 * Pure: no server-only import, no I/O — safe to import anywhere and unit-test directly.
 *
 * Turns a student submission (text + notebooks) into an ordered list of text passages
 * for embedding. Passages are then cosine-matched against rubric reference vectors to
 * locate student answers without relying on structural label alignment.
 */

import type { ParsedNotebook } from '@/lib/assignments/notebook'

export interface Passage {
  text: string
}

/**
 * Chunker result. `truncated` is true when the passage cap (MAX_PASSAGES) discarded
 * content, so the caller can degrade a grade computed from a partial view of the
 * submission instead of silently scoring what fit.
 */
export interface ChunkResult {
  passages: Passage[]
  truncated: boolean
}

/** Soft target passage size (chars). Paragraphs are packed up to this. */
const SOFT_PASSAGE_CHARS = 800
/** A single paragraph longer than this is hard-split on sentence/line boundaries. */
const HARD_SPLIT_CHARS = 1000
/** Max passages per submission (keep first N; rest discarded). */
const MAX_PASSAGES = 200

// ── Text chunker ─────────────────────────────────────────────────────────────

/**
 * Split a plain-text submission into passages.
 *
 * - Split on blank lines into paragraphs.
 * - Greedily pack consecutive paragraphs up to ~SOFT_PASSAGE_CHARS.
 * - Any single paragraph longer than HARD_SPLIT_CHARS is hard-split on
 *   sentence endings ('. ', '? ', '! ', '\n') first, then by chars as fallback.
 * - Empty/whitespace-only paragraphs are dropped.
 */
export function chunkText(text: string): Passage[] {
  if (!text.trim()) return []

  // Split on blank lines.
  const rawParagraphs = text.split(/\n{2,}/)
  const paragraphs: string[] = []
  for (const p of rawParagraphs) {
    const trimmed = p.trim()
    if (!trimmed) continue
    if (trimmed.length <= HARD_SPLIT_CHARS) {
      paragraphs.push(trimmed)
    } else {
      // Hard-split long paragraph on sentence boundaries then by chars.
      paragraphs.push(...splitLong(trimmed))
    }
  }

  if (paragraphs.length === 0) return []

  // Greedily pack into passages.
  const passages: Passage[] = []
  let current = ''
  for (const para of paragraphs) {
    if (!current) {
      current = para
    } else if (current.length + 1 + para.length <= SOFT_PASSAGE_CHARS) {
      current += '\n\n' + para
    } else {
      passages.push({ text: current })
      current = para
    }
  }
  if (current) passages.push({ text: current })

  return passages
}

/** Split a long string on sentence/line boundaries, then chars, targeting ~SOFT_PASSAGE_CHARS. */
function splitLong(text: string): string[] {
  // Try to split on sentence endings.
  const parts: string[] = []
  // Simple sentence splitter: split after '. ', '? ', '! ', or '\n'.
  const sentenceRe = /(?<=[.?!])\s+|\n/g
  const sentences = text.split(sentenceRe).filter((s) => s.trim())

  let current = ''
  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (!trimmed) continue
    if (!current) {
      current = trimmed
    } else if (current.length + 1 + trimmed.length <= SOFT_PASSAGE_CHARS) {
      current += ' ' + trimmed
    } else {
      if (current) parts.push(current)
      current = trimmed
    }
  }
  if (current) parts.push(current)

  // Any remaining part that's still too long: hard-split by chars.
  const result: string[] = []
  for (const part of parts) {
    if (part.length <= HARD_SPLIT_CHARS) {
      result.push(part)
    } else {
      for (let i = 0; i < part.length; i += SOFT_PASSAGE_CHARS) {
        result.push(part.slice(i, i + SOFT_PASSAGE_CHARS))
      }
    }
  }
  return result.filter((s) => s.trim())
}

// ── Notebook chunker ─────────────────────────────────────────────────────────

/**
 * Turn a parsed Jupyter notebook into passages: one passage per cell.
 *
 * - markdown/raw cell: its source text.
 * - code cell: fenced source + text outputs + error outputs.
 * - image outputs: ignored.
 * - Empty cells: skipped.
 */
export function chunkNotebook(nb: ParsedNotebook): Passage[] {
  const passages: Passage[] = []
  for (const cell of nb.cells) {
    const parts: string[] = []

    if (cell.cellType === 'code') {
      const src = cell.source.trim()
      if (src) parts.push('```\n' + src + '\n```')
      for (const out of cell.outputs) {
        if (out.type === 'text' && out.content.trim()) {
          parts.push(out.content.trim())
        } else if (out.type === 'error') {
          parts.push(`Error: ${out.errorType}: ${out.errorValue}`)
        }
        // type === 'image' → skip
      }
    } else {
      // markdown or raw
      const src = cell.source.trim()
      if (src) parts.push(src)
    }

    if (parts.length === 0) continue
    const text = parts.join('\n\n').trim()
    if (text) passages.push({ text })
  }
  return passages
}

// ── Sentence-window chunker (similarity signal, v2) ─────────────────────────

/**
 * Split text into overlapping sentence windows (3 sentences, step 2) for the
 * similarity signal. Finer than chunkText's ~800-char passages: isolates
 * individual claims so a wrong statement can't hide inside an on-topic
 * paragraph (eval: per-question accuracy 25% → 50%, see
 * docs/designs/assignments-grading/ai-grading-eval-reports.md Report 3). Used for whole-mode students
 * only — region retrieval keeps the coarse passages.
 */
export function chunkSentenceWindows(text: string): ChunkResult {
  const sentences = text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (sentences.length === 0) return { passages: [], truncated: false }
  const windows: Passage[] = []
  for (let i = 0; i < sentences.length; i += 2) {
    windows.push({ text: sentences.slice(i, i + 3).join(' ') })
    if (i + 3 >= sentences.length) break
  }
  const truncated = windows.length > MAX_PASSAGES
  return { passages: windows.slice(0, MAX_PASSAGES), truncated }
}

// ── Combined chunker ─────────────────────────────────────────────────────────

/**
 * Chunk a full student submission into passages for embedding.
 *
 * Concatenates chunkText(text) + chunkNotebook(each notebook).
 * Caps at MAX_PASSAGES (first 200 kept).
 * Returns [] when neither text nor notebooks produce any content.
 */
export function chunkSubmission(text: string | null, notebooks: ParsedNotebook[]): ChunkResult {
  const all: Passage[] = []

  if (text) {
    all.push(...chunkText(text))
  }

  for (const nb of notebooks) {
    all.push(...chunkNotebook(nb))
  }

  if (all.length > MAX_PASSAGES) {
    return { passages: all.slice(0, MAX_PASSAGES), truncated: true }
  }
  return { passages: all, truncated: false }
}
