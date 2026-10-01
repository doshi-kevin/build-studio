// `retrieveForQuestion` — the layer that turns ONE student question into
// possibly several searches and one ranked list.
//
// Everything below the pool is already tested (search.ts, rerank.ts, the gate in
// pinecone-decompose.test.ts). What is new and load-bearing here is the merge:
//
//  · a page found by two sub-queries must keep its BEST score, because the score
//    is what `clearsRelevanceFloor` judges downstream — keeping the weaker one
//    turns a page the split FOUND into a page the floor drops, i.e. an honest
//    refusal for a question we actually had the material for;
//  · a spoken slide and a material page are different citations even at the same
//    (item, page), so the dedupe key must keep them apart;
//  · the pool is ranked against the ORIGINAL question, never a sub-query;
//  · and with the reranker off, the merged pool must still be cut to the width
//    one search would have returned — two sub-queries otherwise double the
//    prompt.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { STUDENT_QA_PROFILE, studentQaTopK } from '@/lib/pinecone/config'
import type { MaterialPageResult } from '@/lib/pinecone/search-types'

const shouldDecompose = vi.fn()
const decomposeQuery = vi.fn()
const searchMaterialPages = vi.fn()
const rerankPooled = vi.fn()

vi.mock('@/lib/pinecone/decompose', () => ({
  shouldDecompose: (...a: unknown[]) => shouldDecompose(...a),
  decomposeQuery: (...a: unknown[]) => decomposeQuery(...a),
}))
vi.mock('@/lib/pinecone/search', () => ({
  searchMaterialPages: (...a: unknown[]) => searchMaterialPages(...a),
  rerankPooled: (...a: unknown[]) => rerankPooled(...a),
}))

import { retrieveForQuestion } from '@/lib/pinecone/retrieve'

const INSTITUTION = 'a1b2c3d4-1111-4111-8111-000000000002'
const SECTION = 'a1b2c3d4-1111-4111-8111-000000000003'
const ITEM_A = 'a1b2c3d4-1111-4111-8111-00000000000a'
const ITEM_B = 'a1b2c3d4-1111-4111-8111-00000000000b'
const QUESTION = 'How do word2vec embeddings relate to a transformer’s input representations?'

function page(itemId: string, pageNumber: number, score: number, spoken = false): MaterialPageResult {
  return {
    moduleItemId: itemId,
    moduleId: 'm',
    pageNumber,
    score,
    title: spoken ? 'Live class' : 'Lecture',
    breadcrumb: '',
    text: `${itemId}#${pageNumber}${spoken ? ' spoken' : ''}`,
    ...(spoken ? { spoken: true } : {}),
  }
}

const call = (over: Partial<Parameters<typeof retrieveForQuestion>[0]> = {}) =>
  retrieveForQuestion({ institutionId: INSTITUTION, sectionId: SECTION, query: QUESTION, ...over })

/** Serve a different page list per sub-query. */
function servePerQuery(byQuery: Record<string, MaterialPageResult[]>) {
  searchMaterialPages.mockImplementation(async (input: { query: string }) => byQuery[input.query] ?? [])
}

beforeEach(() => {
  shouldDecompose.mockReset()
  decomposeQuery.mockReset()
  searchMaterialPages.mockReset()
  rerankPooled.mockReset()
  searchMaterialPages.mockResolvedValue([])
})

describe('retrieveForQuestion — when the question is not split', () => {
  it('searches the whole question once and never calls the splitter', async () => {
    shouldDecompose.mockReturnValue(false)
    searchMaterialPages.mockResolvedValue([page(ITEM_A, 1, 0.9)])

    const out = await call({ rerank: true, includeTranscripts: true })

    expect(decomposeQuery).not.toHaveBeenCalled()
    expect(searchMaterialPages).toHaveBeenCalledTimes(1)
    expect(searchMaterialPages.mock.calls[0][0]).toMatchObject({
      query: QUESTION,
      topK: studentQaTopK(),
      rerank: true,
      includeTranscripts: true,
    })
    expect(out.subQueries).toEqual([])
    expect(out.pages).toHaveLength(1)
    delete process.env.RERANK_ENABLED
  })

  it('degrades to the whole question when the split fails', async () => {
    // decomposeQuery swallows its own errors and answers `[]`. That contract is
    // only worth anything if the caller reads it as "search the original" —
    // treating it as "no sub-queries, so nothing to search" would turn a
    // decomposer outage into a student getting no material at all.
    shouldDecompose.mockReturnValue(true)
    decomposeQuery.mockResolvedValue([])
    searchMaterialPages.mockResolvedValue([page(ITEM_A, 1, 0.9)])

    const out = await call({ rerank: true })

    expect(searchMaterialPages).toHaveBeenCalledTimes(1)
    expect(searchMaterialPages.mock.calls[0][0]).toMatchObject({ query: QUESTION, rerank: true })
    expect(out.pages).toHaveLength(1)
    expect(out.subQueries).toEqual([])
  })
})

describe('retrieveForQuestion — pooling across sub-queries', () => {
  const SUB_A = 'what is word2vec'
  const SUB_B = 'what are a transformer’s input representations'

  const prevEnv = process.env.RERANK_ENABLED
  beforeEach(() => {
    shouldDecompose.mockReturnValue(true)
    decomposeQuery.mockResolvedValue([SUB_A, SUB_B])
    // Splitting only happens when the cross-encoder is available to re-score
    // the pool — sub-query cosines are not comparable to the dense floor.
    process.env.RERANK_ENABLED = '1'
    // Stamped, or the whole-question fallback (rerank-failed) path triggers.
    rerankPooled.mockImplementation(async (_q: string, pooled: MaterialPageResult[]) =>
      pooled.map((p) => ({ ...p, reranked: true })),
    )
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.RERANK_ENABLED
    else process.env.RERANK_ENABLED = prevEnv
  })

  it('searches each sub-query and reports them back', async () => {
    servePerQuery({ [SUB_A]: [page(ITEM_A, 1, 0.6)], [SUB_B]: [page(ITEM_B, 3, 0.4)] })

    const out = await call({ rerank: true })

    expect(searchMaterialPages.mock.calls.map((c) => c[0].query).sort()).toEqual([SUB_A, SUB_B].sort())
    expect(out.subQueries).toEqual([SUB_A, SUB_B])
    expect(out.pages.map((p) => p.moduleItemId)).toEqual([ITEM_A, ITEM_B])
  })

  it('keeps a page found twice ONCE, at its best score — whichever half found it better', async () => {
    // Both directions on purpose: first-wins and last-wins are each a one-token
    // mutation of `page.score > seen.score`, and a fixture that only improves
    // (or only worsens) on the second sighting kills just one of them.
    servePerQuery({
      [SUB_A]: [page(ITEM_A, 1, 0.20), page(ITEM_B, 3, 0.80)],
      [SUB_B]: [page(ITEM_A, 1, 0.70), page(ITEM_B, 3, 0.30)],
    })

    const out = await call({ rerank: true })

    expect(out.pages).toHaveLength(2)
    expect(out.pages.map((p) => [p.moduleItemId, p.score])).toEqual([
      [ITEM_B, 0.80], // better on the first sighting
      [ITEM_A, 0.70], // better on the second
    ])
  })

  it('does not fold a spoken slide into the material page at the same (item, page)', async () => {
    // A deck's spoken slide carries its promoted material's id and the same
    // 1-based number as the page. They are different text and different
    // citations; keying on (item, page) alone would silently drop one of them.
    servePerQuery({
      [SUB_A]: [page(ITEM_A, 4, 0.5)],
      [SUB_B]: [page(ITEM_A, 4, 0.3, true)],
    })

    const out = await call({ rerank: true })

    expect(out.pages).toHaveLength(2)
    expect(out.pages.map((p) => p.spoken === true)).toEqual([false, true])
  })

  it('does not call the ranker when RERANK_ENABLED is 0, even with rerank: true', async () => {
    // The route always passes rerank: true, so this flag is the only thing
    // standing between "set the opt-out" and course page text still leaving
    // for a third-party ranker on every multi-topic question. Gating only
    // inside searchMaterialPages would leave this path uncovered.
    process.env.RERANK_ENABLED = '0'
    servePerQuery({ [QUESTION]: [page(ITEM_A, 1, 0.6)] })

    const out = await call({ rerank: true })

    expect(rerankPooled).not.toHaveBeenCalled()
    // …and it does not split either: without the ranker to re-score them, the
    // sub-query cosines would be judged against a floor calibrated on whole
    // questions, which measurably lets an out-of-corpus question through.
    expect(decomposeQuery).not.toHaveBeenCalled()
    expect(out.subQueries).toEqual([])
    expect(out.pages.length).toBeGreaterThan(0)
  })

  it('ranks the pool against the ORIGINAL question, and pays for exactly one rerank', async () => {
    // The kill switch is re-checked on THIS path too (the route always asks for
    // rerank:true, so gating only inside searchMaterialPages would let the flag
    // hold on single-topic questions and silently not hold on split ones).
    process.env.RERANK_ENABLED = '1'
    servePerQuery({ [SUB_A]: [page(ITEM_A, 1, 0.6)], [SUB_B]: [page(ITEM_B, 3, 0.4)] })
    // Stamped: an UNstamped return is the circuit-breaker's fallback, which now
    // routes to a whole-question re-search (covered in its own case below).
    rerankPooled.mockImplementation(async (_q: string, pooled: MaterialPageResult[]) =>
      pooled.slice(0, 1).map((p) => ({ ...p, reranked: true })),
    )

    const out = await call({ rerank: true })

    // Sub-query searches must NOT rerank — one call each would be billed and
    // then thrown away when the pools merge.
    for (const [input] of searchMaterialPages.mock.calls) expect(input.rerank).toBeFalsy()
    expect(rerankPooled).toHaveBeenCalledTimes(1)
    const [rankedAgainst, pooled, scope] = rerankPooled.mock.calls[0]
    expect(rankedAgainst).toBe(QUESTION)
    expect(pooled.map((p: MaterialPageResult) => p.moduleItemId)).toEqual([ITEM_A, ITEM_B])
    expect(scope).toMatchObject({ institutionId: INSTITUTION, sectionId: SECTION, topN: STUDENT_QA_PROFILE.rerankTopN })
    expect(out.pages).toHaveLength(1)
  })
})

describe('retrieveForQuestion — when the reranker fails mid-request', () => {
  const prevEnv = process.env.RERANK_ENABLED
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.RERANK_ENABLED
    else process.env.RERANK_ENABLED = prevEnv
  })

  it('re-searches the WHOLE question rather than serving sub-query scores', async () => {
    // The gate can't prevent this one: the split already happened when the
    // ranker failed. Serving the pool would hand the caller cosines produced by
    // narrow sub-queries to judge against a floor calibrated on whole
    // questions — the exact mismatch that let "alpha-beta pruning relate to
    // minimax" score 0.587 against a 0.58 floor and get answered.
    process.env.RERANK_ENABLED = '1'
    shouldDecompose.mockReturnValue(true)
    decomposeQuery.mockResolvedValue(['a', 'b'])
    servePerQuery({
      a: [page(ITEM_A, 1, 0.9)],
      b: [page(ITEM_B, 2, 0.8)],
      [QUESTION]: [page(ITEM_A, 7, 0.55)],
    })
    // The circuit-breaker's declared fallback: dense order, no `reranked` stamp.
    rerankPooled.mockImplementation(async (_q: string, pooled: MaterialPageResult[]) => pooled)

    const out = await call({ rerank: true })

    expect(searchMaterialPages.mock.calls.map((c) => c[0].query)).toContain(QUESTION)
    expect(out.pages.map((p) => p.pageNumber)).toEqual([7])
    expect(out.subQueries).toEqual([])
  })
})
