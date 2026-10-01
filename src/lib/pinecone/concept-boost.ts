// Concept→page boost (design doc §4 "Question names a known concept"): when a
// query literally names a stored course concept, the pages that teach it —
// from module_items.content.concepts[].pages — are pinned above the dense
// near-duplicate pages a plain similarity search surfaces. A direct-lookup
// precision win layered on top of vector retrieval.
//
// Pure logic only (no I/O) so it's unit-testable; the concept load + hydration
// live in search.ts. Pinning is scoped to pages that already pass the same
// visibility/tenant gates as any other retrieved page — this module only
// reorders, it never widens access.

/** Score bump applied to a pinned concept page. Larger than any cosine score
 *  (≤ ~1), so pinned pages sort above every non-pinned page and clear the
 *  retrieval floor; relative order within each group is preserved. */
export const CONCEPT_PIN_BOOST = 1

/** One (concept name → page) reference, flattened from a material's stored concepts. */
export interface ConceptPageRef {
  name: string
  moduleItemId: string
  page: number
}

/** Key identifying a page across the retrieval set. */
export function pageKey(moduleItemId: string, page: number): string {
  return `${moduleItemId}#${page}`
}

/** Lowercase, collapse every run of non-alphanumerics to one space, trim — so
 *  "Scaled Dot-Product Attention" and "scaled dot product attention" match. */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Pure: the keys of concept pages whose concept NAME appears as a whole phrase
 * in the query. Phrase-boundary match (space-padded) keeps it precise — it
 * fires on "explain multi-head attention", not on an incidental word overlap,
 * and won't match a morphological variant ("KV caching" ≠ "KV cache"), which is
 * the intended trade-off: the boost is a high-confidence direct lookup, and
 * plain vector retrieval still covers the softer cases.
 */
export function matchConceptPages(query: string, concepts: ConceptPageRef[]): Set<string> {
  const haystack = ` ${normalizeForMatch(query)} `
  const pinned = new Set<string>()
  for (const c of concepts) {
    const name = normalizeForMatch(c.name)
    if (name.length < 3) continue // ignore trivially-short names (over-match risk)
    if (haystack.includes(` ${name} `)) pinned.add(pageKey(c.moduleItemId, c.page))
  }
  return pinned
}

/**
 * Pure: boost the score of any result whose page is pinned, then re-sort by
 * score descending. Pinned pages rise above the near-duplicates; ties and
 * within-group order fall out of the stable-ish numeric sort. Returns a new
 * array; inputs are not mutated.
 */
export function applyConceptBoost<T extends { moduleItemId: string; pageNumber: number; score: number }>(
  results: T[],
  pinned: Set<string>,
  boost: number = CONCEPT_PIN_BOOST,
): T[] {
  if (pinned.size === 0) return results
  return results
    .map((r) => (pinned.has(pageKey(r.moduleItemId, r.pageNumber)) ? { ...r, score: r.score + boost } : r))
    .sort((a, b) => b.score - a.score)
}
