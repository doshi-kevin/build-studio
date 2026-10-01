/**
 * Shared authoring metadata, attachable to ANY studio block (notebook cell, question, …).
 *
 * This is a SHELL-level capability: it lives in the block's `metadata.studio` so every
 * template inherits it for free, and (for notebook cells) it round-trips losslessly inside
 * the .ipynb because nbformat passes cell metadata through verbatim.
 *
 * Manual only: points, a professor-authored explanation (worked reasoning), ordered
 * progressive hints, and free-text concept tags. No AI, no grading.
 */

export type Difficulty = 'easy' | 'medium' | 'hard'

export type BloomLevel =
  | 'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create'

export const BLOOM_LEVELS: BloomLevel[] = [
  'remember', 'understand', 'apply', 'analyze', 'evaluate', 'create',
]

export interface AuthoringMeta {
  /** Marks/points for this block. */
  points?: number
  /** Professor-authored worked reasoning (not shown to students until configured later). */
  explanation?: string
  /** Ordered hints, revealed one-by-one in the student flow (a later batch). */
  hints?: string[]
  /** Free-text concept/module tags (no concept catalogue exists yet, bindable later). */
  conceptTags?: string[]
  /** Authoring-only difficulty tag. */
  difficulty?: Difficulty
  /** Authoring-only grade weighting, percent of the overall grade. */
  weight?: number
  /** Professor-only expected answer / answer key (authoring; not student-facing). */
  answerKey?: string
  /** Whether this block counts toward grading (authoring flag). */
  graded?: boolean
  /** Bloom's taxonomy cognitive level. */
  bloom?: BloomLevel
  /** Bonus block: awards points but isn't part of the base total. */
  bonus?: boolean
  /** Extra-credit block: points count on top of the maximum. */
  extraCredit?: boolean
  /** Estimated time to complete this block, in minutes. */
  estimatedMinutes?: number
  /** Target word count for an answer cell. */
  wordCountTarget?: number
}

const KEY = 'studio'

function isStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Read authoring meta from a block's metadata object (safe against arbitrary JSON). */
export function getAuthoring(metadata: Record<string, unknown> | undefined): AuthoringMeta {
  const raw = metadata?.[KEY]
  if (!raw || typeof raw !== 'object') return {}
  const m = raw as Record<string, unknown>
  const out: AuthoringMeta = {}
  if (typeof m.points === 'number' && !Number.isNaN(m.points)) out.points = m.points
  if (typeof m.explanation === 'string') out.explanation = m.explanation
  const hints = isStringArray(m.hints)
  if (hints.length) out.hints = hints
  const tags = isStringArray(m.conceptTags)
  if (tags.length) out.conceptTags = tags
  if (m.difficulty === 'easy' || m.difficulty === 'medium' || m.difficulty === 'hard') out.difficulty = m.difficulty
  if (typeof m.weight === 'number' && !Number.isNaN(m.weight)) out.weight = m.weight
  if (typeof m.answerKey === 'string') out.answerKey = m.answerKey
  if (typeof m.graded === 'boolean') out.graded = m.graded
  if (BLOOM_LEVELS.includes(m.bloom as BloomLevel)) out.bloom = m.bloom as BloomLevel
  if (typeof m.bonus === 'boolean') out.bonus = m.bonus
  if (typeof m.extraCredit === 'boolean') out.extraCredit = m.extraCredit
  if (typeof m.estimatedMinutes === 'number' && !Number.isNaN(m.estimatedMinutes)) out.estimatedMinutes = m.estimatedMinutes
  if (typeof m.wordCountTarget === 'number' && !Number.isNaN(m.wordCountTarget)) out.wordCountTarget = m.wordCountTarget
  return out
}

/** Return a new metadata object with authoring meta written under `studio` (or removed when empty). */
export function setAuthoring(
  metadata: Record<string, unknown>,
  meta: AuthoringMeta,
): Record<string, unknown> {
  const clean: AuthoringMeta = {}
  if (typeof meta.points === 'number' && !Number.isNaN(meta.points)) clean.points = meta.points
  if (meta.explanation && meta.explanation.trim()) clean.explanation = meta.explanation
  if (meta.hints && meta.hints.length) clean.hints = meta.hints
  if (meta.conceptTags && meta.conceptTags.length) clean.conceptTags = meta.conceptTags
  if (meta.difficulty) clean.difficulty = meta.difficulty
  if (typeof meta.weight === 'number' && !Number.isNaN(meta.weight)) clean.weight = meta.weight
  if (meta.answerKey && meta.answerKey.trim()) clean.answerKey = meta.answerKey
  if (typeof meta.graded === 'boolean') clean.graded = meta.graded
  if (meta.bloom) clean.bloom = meta.bloom
  if (meta.bonus) clean.bonus = meta.bonus
  if (meta.extraCredit) clean.extraCredit = meta.extraCredit
  if (typeof meta.estimatedMinutes === 'number' && !Number.isNaN(meta.estimatedMinutes)) clean.estimatedMinutes = meta.estimatedMinutes
  if (typeof meta.wordCountTarget === 'number' && !Number.isNaN(meta.wordCountTarget)) clean.wordCountTarget = meta.wordCountTarget

  const next = { ...metadata }
  if (Object.keys(clean).length === 0) delete next[KEY]
  else next[KEY] = clean
  return next
}

export function hasAuthoring(meta: AuthoringMeta): boolean {
  return (
    meta.points !== undefined ||
    !!meta.explanation?.trim() ||
    !!meta.hints?.length ||
    !!meta.conceptTags?.length ||
    !!meta.difficulty ||
    meta.weight !== undefined ||
    !!meta.answerKey?.trim() ||
    meta.graded !== undefined ||
    !!meta.bloom ||
    !!meta.bonus ||
    !!meta.extraCredit ||
    meta.estimatedMinutes !== undefined ||
    meta.wordCountTarget !== undefined
  )
}

const DIFFICULTY_ORDER: Difficulty[] = ['easy', 'medium', 'hard']

/** Cycle easy → medium → hard → (cleared). */
export function nextDifficulty(d: Difficulty | undefined): Difficulty | undefined {
  if (!d) return 'easy'
  const i = DIFFICULTY_ORDER.indexOf(d)
  return DIFFICULTY_ORDER[i + 1]
}
