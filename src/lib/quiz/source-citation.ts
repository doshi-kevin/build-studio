// Attributes an AI-generated quiz question to the source file + page it was
// drawn from, so the professor can peek the exact page in the quiz creator.
// See docs/designs/quizzes/hybrid-extraction-and-citation.md §15.
//
// Two signals, in order of trust:
//   1. The model's own `[Title, page N]` hint, IF it matches a real source and
//      the page is in range (resolveSourceCitation). Gemini emits this only
//      sporadically — it's a bonus, not the mechanism.
//   2. A deterministic content match (attributeByContent): the page whose
//      extracted text overlaps the question most. This is what actually makes
//      the feature work, with no dependency on the model populating a field.
// Either way we only ever return a citation pointing at a file we were given,
// on a page that exists — never a broken link.

import type { SourcePageCitation } from '@/lib/validations/quiz'

/** A source the quiz generator drew from. `pages` carries each page's extracted
 *  text for content matching (optional — model-hint resolution doesn't need it). */
export interface QuizSource {
  title: string
  pageCount: number
  ref:
    | { kind: 'module_item'; moduleItemId: string }
    | { kind: 'upload'; filePath: string }
  /** Whether the peek endpoint can render this file's pages (PDF/PPT only).
   *  Stamped into the citation so the source chip can disable the peek for
   *  docx/xlsx/image sources instead of opening an error pane. */
  renderable?: boolean
  pages?: { page: number; text: string }[]
}

/** Lowercase, collapse internal whitespace, trim — for tolerant title matching. */
function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Find the source a model-supplied title refers to. Exact (normalized) match
 *  first, then a bidirectional substring fallback (mirrors the AI tutor's
 *  matchCitationDoc). First match wins on ties. Returns undefined if none. */
function matchSource(title: string, sources: QuizSource[]): QuizSource | undefined {
  const q = normalizeTitle(title)
  if (!q) return undefined
  const exact = sources.find((s) => normalizeTitle(s.title) === q)
  if (exact) return exact
  return sources.find((s) => {
    const t = normalizeTitle(s.title)
    return t.includes(q) || q.includes(t)
  })
}

/** Build a SourceCitation from a matched source + page. */
function cite(source: QuizSource, page: number): SourcePageCitation {
  const citation: SourcePageCitation =
    source.ref.kind === 'module_item'
      ? { kind: 'module_item', moduleItemId: source.ref.moduleItemId, page, title: source.title }
      : { kind: 'upload', filePath: source.ref.filePath, page, title: source.title }
  if (source.renderable !== undefined) citation.renderable = source.renderable
  return citation
}

/**
 * Turn a model's (sourceTitle, sourcePage) hint into a verified SourceCitation,
 * or null if it can't be trusted: no title, no/invalid page, no matching source,
 * or a page outside the document.
 */
export function resolveSourceCitation(
  sourceTitle: string | undefined,
  sourcePage: number | undefined,
  sources: QuizSource[],
): SourcePageCitation | null {
  if (!sourceTitle || typeof sourcePage !== 'number' || !Number.isInteger(sourcePage) || sourcePage < 1) {
    return null
  }
  const source = matchSource(sourceTitle, sources)
  if (!source) return null
  if (source.pageCount > 0 && sourcePage > source.pageCount) return null
  return cite(source, sourcePage)
}

// Common words that carry no topic signal — excluded from overlap scoring.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'as', 'by', 'at', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'which',
  'what', 'when', 'how', 'why', 'who', 'whom', 'can', 'will', 'would', 'should', 'could', 'may', 'might',
  'do', 'does', 'did', 'has', 'have', 'had', 'not', 'no', 'yes', 'than', 'then', 'so', 'such', 'into', 'each',
  'following', 'used', 'use', 'using', 'between', 'during', 'primary', 'standard', 'context', 'given', 'output',
])

/** Distinct meaningful tokens (lowercased, ≥3 chars, non-stopword). */
function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw)
  }
  return out
}

/**
 * Attribute a question to the source page whose extracted text best overlaps the
 * question's words. Returns the best page if it clears a small overlap floor
 * (so a question with no real match in the deck stays uncited), else null.
 */
export function attributeByContent(questionText: string, sources: QuizSource[]): SourcePageCitation | null {
  const qTokens = tokenize(questionText)
  if (qTokens.size === 0) return null

  let best: { source: QuizSource; page: number; score: number } | null = null
  for (const source of sources) {
    for (const p of source.pages ?? []) {
      const pTokens = tokenize(p.text)
      let score = 0
      for (const t of qTokens) if (pTokens.has(t)) score++
      if (!best || score > best.score) best = { source, page: p.page, score }
    }
  }

  // Require at least 2 distinct topic-word overlaps to claim a page — below that
  // it's noise, and a wrong peek is worse than none.
  if (!best || best.score < 2) return null
  if (best.source.pageCount > 0 && best.page > best.source.pageCount) return null
  return cite(best.source, best.page)
}

/**
 * Resolve a question's citation: prefer the model's verifiable hint, else fall
 * back to a deterministic content match against the source pages.
 */
export function resolveQuestionCitation(
  sourceTitle: string | undefined,
  sourcePage: number | undefined,
  questionText: string,
  sources: QuizSource[],
): SourcePageCitation | null {
  return resolveSourceCitation(sourceTitle, sourcePage, sources) ?? attributeByContent(questionText, sources)
}
