/**
 * Keyword presence checking for rubric criteria.
 * Pure: no server-only import, deterministic, no network calls.
 *
 * v1 detects presence/absence only — not contradiction (e.g. sign flips).
 * The LLM infers contradiction from the student excerpt later.
 */

import type { KeywordResult } from './types'

/**
 * Normalize a string for keyword matching:
 *   - Unicode NFKC decomposition (handles composed/decomposed chars)
 *   - Lowercase
 *   - Hyphens → space (so "well-known" ≡ "well known")
 *   - Strip punctuation EXCEPT dots inside numbers (so "3.14" stays intact)
 *   - Collapse whitespace
 */
export function normalizeForMatch(s: string): string {
  // NFKC then lowercase
  let n = s.normalize('NFKC').toLowerCase()
  // Hyphens to space (must happen before punctuation strip so "well-known" → "well known")
  n = n.replace(/-/g, ' ')
  // Strip punctuation but KEEP dots that sit between digits (decimal points), so "3.14"
  // survives as one token while "end." loses its dot. The earlier `[^\w\s]` strip treated a
  // dot as punctuation and removed it regardless, making decimal preservation a no-op; the
  // single negative-lookahead/lookbehind pass below is the actual guard — a char is replaced
  // when it is not word/space AND not a digit-flanked dot.
  n = n.replace(/(?!\d\.\d)[^\w\s]/g, (m, offset, str) => {
    // Keep a dot only when both neighbours are digits.
    if (m === '.' && /\d/.test(str[offset - 1] ?? '') && /\d/.test(str[offset + 1] ?? '')) {
      return '.'
    }
    return ' '
  })
  // Collapse whitespace
  n = n.replace(/\s+/g, ' ').trim()
  return n
}

/**
 * True when `keyword` (already normalised) is found as a token-sequence in `normalizedText`.
 *
 * Matching rules:
 *  - Whole-word sequence containment: every token in the keyword phrase must appear
 *    in order as whole tokens in the text.
 *  - Plural/singular tolerance: the last token of the keyword matches if the text
 *    token equals keyword-last OR keyword-last + "s" OR keyword-last + "es",
 *    and conversely if the text token + "s"/"es" equals keyword-last.
 *  - Numbers match exactly after normalization.
 */
export function keywordPresent(keyword: string, normalizedText: string): boolean {
  const kwTokens = keyword.split(' ').filter(Boolean)
  if (kwTokens.length === 0) return false

  const textTokens = normalizedText.split(' ').filter(Boolean)
  if (textTokens.length === 0) return false

  /**
   * Check if two tokens match, applying plural/singular tolerance only on the
   * final token of the keyword phrase.
   */
  function tokensMatch(textTok: string, kwTok: string, isLast: boolean): boolean {
    if (textTok === kwTok) return true
    if (!isLast) return false
    // plural/singular: kw → try appending s/es to match text
    if (textTok === kwTok + 's') return true
    if (textTok === kwTok + 'es') return true
    // plural/singular: text → try appending s/es to match kw
    if (textTok + 's' === kwTok) return true
    if (textTok + 'es' === kwTok) return true
    return false
  }

  // Sliding window over text tokens looking for the keyword phrase.
  outer: for (let i = 0; i <= textTokens.length - kwTokens.length; i++) {
    for (let j = 0; j < kwTokens.length; j++) {
      const isLast = j === kwTokens.length - 1
      if (!tokensMatch(textTokens[i + j], kwTokens[j], isLast)) {
        continue outer
      }
    }
    return true
  }
  return false
}

/** One required keyword and its equivalent surface forms ("O(n log n)" ~ "O(n lg n)"). `term`
 *  must appear in the criterion's absoluteKeywords; any alias present satisfies the term. */
export interface KeywordAlias {
  term: string
  aliases: string[]
}

/**
 * Run all configured keywords against the student text.
 *
 * A keyword is FOUND when the keyword itself, OR any of its configured aliases (matched by
 * normalized `term`), appears in the text. Wiring aliases here is what stops a correct answer
 * written in an equivalent notation ("depth-first search" for "DFS") from being scored a miss.
 *
 * Returns null when:
 *  - `keywords` is undefined/empty (no keywords configured for this criterion)
 *
 * When `text` is null (unmapped question), all keywords are listed as missing.
 */
export function checkKeywords(
  keywords: string[] | undefined,
  text: string | null,
  aliases?: KeywordAlias[],
): KeywordResult | null {
  if (!keywords || keywords.length === 0) return null

  const normalizedText = text !== null ? normalizeForMatch(text) : null

  // Index aliases by normalized term so a keyword's equivalents can be looked up regardless of
  // surface form. Only aliases whose term maps to a configured keyword matter.
  const aliasesByTerm = new Map<string, string[]>()
  for (const a of aliases ?? []) {
    const normTerm = normalizeForMatch(a.term)
    if (normTerm) aliasesByTerm.set(normTerm, a.aliases)
  }

  const found: string[] = []
  const missing: string[] = []

  for (const kw of keywords) {
    const normKw = normalizeForMatch(kw)
    if (!normKw) continue
    if (normalizedText === null) {
      missing.push(kw)
      continue
    }
    let present = keywordPresent(normKw, normalizedText)
    if (!present) {
      // Fall back to the keyword's aliases: any equivalent surface form satisfies it.
      for (const alias of aliasesByTerm.get(normKw) ?? []) {
        const normAlias = normalizeForMatch(alias)
        if (normAlias && keywordPresent(normAlias, normalizedText)) {
          present = true
          break
        }
      }
    }
    if (present) found.push(kw)
    else missing.push(kw)
  }

  return { required: keywords, found, missing }
}
