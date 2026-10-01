// Cross-encoder reranking for the `student-qa-v1` profile — the pure half.
//
// Dense retrieval answers "which pages are about roughly this?"; a cross-encoder
// reads the question and the page TOGETHER and answers "does this page actually
// answer it?". The eval measured the gap this closes: the right page sat inside
// the top-40 pool on 94% of golden questions but inside the dense top-8 on 76%.
//
// The network call lives in client.ts (raw-SDK contact, vector-db rule 1); the
// reordering and the floor live here so both are unit-testable without Pinecone.

import { STUDENT_QA_PROFILE } from './config'
import type { MaterialPageResult } from './search-types'

/** One reranked position as the hosted model returns it. */
export interface RankedPosition {
  index: number
  score: number
}

/**
 * The text handed to the reranker for one page.
 *
 * The title goes in front of the body because a cross-encoder sees only this
 * string: a bare diagram page is a handful of axis labels, and "Lecture 5:
 * Seq2Seq and Attention" is most of what makes it rankable at all — the
 * sparse-text diagram problem §4 names.
 */
export function rerankDocumentFor(page: MaterialPageResult): string {
  const head = page.spoken ? `${page.title} (spoken), slide ${page.pageNumber}` : `${page.title}, page ${page.pageNumber}`
  return `${head}\n${page.text}`.slice(0, STUDENT_QA_PROFILE.rerankMaxDocChars)
}

/**
 * Reorder `pages` by the reranker's verdict and stamp the relevance score.
 *
 * `score` is REPLACED rather than sat beside the cosine, because everything
 * downstream (the floor, the "top result" telemetry, the eval) reads `score`,
 * and leaving two competing numbers on the object guarantees some caller reads
 * the wrong one. `reranked: true` is how a caller knows which floor applies.
 * Positions the model didn't return are dropped — it was asked for top-N.
 */
export function applyRerank(pages: MaterialPageResult[], ranked: RankedPosition[]): MaterialPageResult[] {
  const out: MaterialPageResult[] = []
  for (const r of ranked) {
    const page = pages[r.index]
    if (!page) continue // out-of-range index — ignore rather than trust it
    out.push({ ...page, score: r.score, reranked: true })
  }
  return out
}

/**
 * Does this page clear the relevance floor for the path it came through?
 *
 * A cross-encoder score is not a cosine — different scale, different spread —
 * so the reranked and dense paths carry separate thresholds and this is the one
 * place that picks between them. When nothing clears, the caller takes the
 * honest "insufficient context" branch (G1/G2).
 */
export function clearsRelevanceFloor(page: MaterialPageResult): boolean {
  return page.reranked
    ? page.score >= STUDENT_QA_PROFILE.rerankScoreFloor
    : page.score >= STUDENT_QA_PROFILE.scoreFloor
}
