// Rank metrics for the retrieval eval gate (layer 1, athena-students.md §11).
//
// Pure functions over a ranked list of page keys — no Pinecone, no Supabase, no
// LLM judge. The golden set labels which pages are correct, so every number here
// is deterministic and reproducible, which is what makes it a gate rather than a
// vibe check.
//
// A "page key" is `${moduleItemId}#${pageNumber}` — the same identity retrieval
// returns and a student cites.

/** `${moduleItemId}#${pageNumber}` — the unit gold pages are labelled in. */
export type PageKey = string

export function pageKey(moduleItemId: string, pageNumber: number): PageKey {
  return `${moduleItemId}#${pageNumber}`
}

/**
 * Share of a query's gold pages present in the first `k` results.
 *
 * Measured on the candidate pool (pre-rerank) this answers "did the right page
 * even have a chance" — an embedding or chunking miss no reranker can repair.
 * Returns null when the case labels no gold pages (a refusal case), because 0
 * would drag the mean down for a case that has nothing to recall.
 */
export function recallAtK(ranked: PageKey[], gold: Set<PageKey>, k: number): number | null {
  if (gold.size === 0) return null
  const window = ranked.slice(0, k)
  let hits = 0
  for (const g of gold) if (window.includes(g)) hits++
  return hits / gold.size
}

/**
 * Reciprocal rank of the FIRST gold page (1/rank, 0 if none present).
 *
 * The early-warning metric: hit-based numbers stay green while ranking quietly
 * degrades, but the first gold page sliding from rank 1 to rank 4 shows here
 * immediately.
 */
export function mrr(ranked: PageKey[], gold: Set<PageKey>): number | null {
  if (gold.size === 0) return null
  for (let i = 0; i < ranked.length; i++) {
    if (gold.has(ranked[i])) return 1 / (i + 1)
  }
  return 0
}

/**
 * Rank-weighted context precision (RAGAS-style): mean of precision@k taken at
 * every rank that holds a gold page, divided by the gold pages actually present.
 *
 * Raw precision@6 is capped absurdly low when a query has one gold page (the
 * shaped.ai R-Precision caveat — 1/6 is a perfect result scoring 0.17), so the
 * weighting asks the question we care about instead: do the gold pages sit at
 * the TOP of what reaches the prompt? Returns null for a case with no gold, and
 * 0 when gold exists but none of it made the window.
 */
export function contextPrecision(ranked: PageKey[], gold: Set<PageKey>): number | null {
  if (gold.size === 0) return null
  let found = 0
  let sum = 0
  for (let i = 0; i < ranked.length; i++) {
    if (gold.has(ranked[i])) {
      found++
      sum += found / (i + 1) // precision@(i+1)
    }
  }
  return found === 0 ? 0 : sum / found
}

/** 1-based rank of the first gold page, or null when none was retrieved. */
export function firstGoldRank(ranked: PageKey[], gold: Set<PageKey>): number | null {
  for (let i = 0; i < ranked.length; i++) {
    if (gold.has(ranked[i])) return i + 1
  }
  return null
}

/** Mean of the values that apply, ignoring the n/a (null) cases. 0 when none apply. */
export function meanOf(values: Array<number | null>): number {
  const applicable = values.filter((v): v is number => v !== null)
  if (applicable.length === 0) return 0
  return applicable.reduce((a, b) => a + b, 0) / applicable.length
}

/** Round to 4dp so a committed baseline diffs cleanly instead of on float noise. */
export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}
