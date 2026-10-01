// The student-question retrieval path: decompose if the question spans topics,
// retrieve per sub-query, pool, then rank the pool against what the student
// actually asked.
//
// This sits ABOVE `searchMaterialPages` rather than inside it. The primitive
// answers "find pages for THIS string" and stays that way; deciding that one
// question is really two is a different job, and folding it in would make the
// primitive's contract depend on the phrasing of its input.

import 'server-only'

import { STUDENT_QA_PROFILE, isRerankEnabled, studentQaTopK } from './config'
import { decomposeQuery, shouldDecompose } from './decompose'
import { rerankPooled, searchMaterialPages } from './search'
import type { MaterialPageResult } from './search-types'

export interface RetrieveResult {
  pages: MaterialPageResult[]
  /** The sub-queries actually searched — `[]` when the question wasn't split.
   *  Surfaced so the caller can show its work and the eval can tell a
   *  decomposed run from a plain one. */
  subQueries: string[]
}

/**
 * Retrieve the pages for a student's question.
 *
 * Rank the pool against the ORIGINAL question, never the sub-queries: the
 * sub-queries exist to widen what gets found, but relevance is judged by what
 * the student asked. Ranking each half separately would let a page that answers
 * one half perfectly outrank a page that speaks to the whole question.
 */
export async function retrieveForQuestion(input: {
  institutionId: string
  sectionId: string
  query: string
  includeTranscripts?: boolean
  rerank?: boolean
  userId?: string
}): Promise<RetrieveResult> {
  const { institutionId, sectionId, query } = input
  const scope = { institutionId, sectionId, userId: input.userId }

  // Decomposition rides on reranking, and not just for quality. Sub-query
  // cosines are systematically HIGHER than a whole question's — a narrower query
  // matches its best page harder — while `scoreFloor` is calibrated on
  // whole-question cosines with ~0.01 of margin. Measured: "how does alpha-beta
  // pruning relate to minimax search" refuses correctly as one question (0.569)
  // and is ANSWERED as the sub-query "alpha-beta pruning" (0.587), a G1
  // fabrication leak. The cross-encoder re-scores the pool on its own calibrated
  // scale and removes the mismatch; without it, splitting is unsafe.
  const canDecompose = (input.rerank ?? false) && isRerankEnabled()
  const subQueries = canDecompose && shouldDecompose(query) ? await decomposeQuery(query, scope) : []
  if (subQueries.length === 0) {
    const pages = await searchMaterialPages({
      ...scope,
      query,
      topK: studentQaTopK(),
      includeTranscripts: input.includeTranscripts,
      rerank: input.rerank,
    })
    return { pages, subQueries: [] }
  }

  // Each sub-query retrieves on its own, WITHOUT reranking — reranking per
  // sub-query would spend a call each and then throw the ordering away when the
  // pools merge.
  const perQuery = await Promise.all(
    subQueries.map((q) =>
      searchMaterialPages({
        ...scope,
        query: q,
        topK: studentQaTopK(),
        includeTranscripts: input.includeTranscripts,
      }),
    ),
  )

  // Pool and dedupe on (item, page), keeping each page's best score. A page both
  // halves surface is one page, and the stronger match is the honest score.
  const byPage = new Map<string, MaterialPageResult>()
  for (const page of perQuery.flat()) {
    // A spoken result whose deck was never promoted to course material has an
    // EMPTY moduleItemId, so keying on it alone would collide slide 12 of two
    // different lectures and silently drop one. The breadcrumb carries the room
    // and deck, which is what actually distinguishes them.
    const key = page.spoken ? `s#${page.breadcrumb}` : `p#${page.moduleItemId}#${page.pageNumber}`
    const seen = byPage.get(key)
    if (!seen || page.score > seen.score) byPage.set(key, page)
  }
  const pooled = [...byPage.values()].sort((a, b) => b.score - a.score)

  // Capped before it goes out: N sub-queries × the pool width can exceed the
  // ranker's 100-record limit, which would either bill as two queries or be
  // rejected outright — and a rejection fails open, nulling out the feature on
  // exactly the questions decomposition exists to help.
  const ranked = await rerankPooled(query, pooled.slice(0, STUDENT_QA_PROFILE.topK), {
    ...scope,
    topN: STUDENT_QA_PROFILE.rerankTopN,
  })

  // The reranker can still fail per-request after we've already split. Serving
  // the pool then would hand the caller sub-query cosines to judge against the
  // whole-question floor — the same mismatch the gate above avoids. So redo the
  // whole question instead: one extra search, on the rare failure path, for
  // scores the floor was actually calibrated on.
  if (!ranked.some((p) => p.reranked)) {
    const pages = await searchMaterialPages({
      ...scope,
      query,
      topK: studentQaTopK(),
      includeTranscripts: input.includeTranscripts,
    })
    return { pages, subQueries: [] }
  }
  return { pages: ranked, subQueries }
}
