// Tests for the pure half of cross-encoder reranking (rerank.ts) and the two
// entitlement-derived knobs in config.ts.
//
// The thing worth pinning here is that TWO score scales now share one `score`
// field. A cross-encoder score is not a cosine, so `clearsRelevanceFloor` is the
// single place that picks a threshold — and a mutation that collapses it to one
// floor is invisible unless a fixture sits BETWEEN the two (0.12 and 0.58).
// Every floor test below is built around that gap on purpose.

import { describe, it, expect, afterEach } from 'vitest'
import { applyRerank, clearsRelevanceFloor, rerankDocumentFor } from '@/lib/pinecone/rerank'
import { STUDENT_QA_PROFILE, isRerankEnabled, studentQaTopK } from '@/lib/pinecone/config'
import type { MaterialPageResult } from '@/lib/pinecone/search-types'

function page(over: Partial<MaterialPageResult> = {}): MaterialPageResult {
  return {
    moduleItemId: 'item-a',
    moduleId: 'mod-1',
    pageNumber: 14,
    score: 0.7,
    title: 'Lecture 5: Seq2Seq and Attention',
    breadcrumb: 'Week 3 › Lecture 5',
    text: 'attention weights are a softmax over the encoder states',
    ...over,
  }
}

describe('rerankDocumentFor', () => {
  it('puts the title in front of the body — the only thing that makes a sparse diagram page rankable', () => {
    // The cross-encoder sees this string and nothing else, so dropping the
    // title is a silent quality regression rather than an error.
    const doc = rerankDocumentFor(page({ text: 'x → y' }))
    expect(doc).toBe('Lecture 5: Seq2Seq and Attention, page 14\nx → y')
  })

  it('marks a spoken result as spoken and counts it in slides, not pages', () => {
    const doc = rerankDocumentFor(page({ spoken: true, pageNumber: 12, text: 'so the key idea is' }))
    expect(doc).toBe('Lecture 5: Seq2Seq and Attention (spoken), slide 12\nso the key idea is')
  })

  it('cuts the document at the profile budget so one long page cannot blow the request', () => {
    const doc = rerankDocumentFor(page({ text: 'z'.repeat(10_000) }))
    expect(doc).toHaveLength(STUDENT_QA_PROFILE.rerankMaxDocChars)
    // The head survives the cut — truncation takes the tail, never the title.
    expect(doc.startsWith('Lecture 5: Seq2Seq and Attention, page 14\n')).toBe(true)
  })
})

describe('applyRerank', () => {
  const pages = [page({ pageNumber: 1, score: 0.9 }), page({ pageNumber: 2, score: 0.8 }), page({ pageNumber: 3, score: 0.7 })]

  it("returns the model's order, not the dense order", () => {
    const out = applyRerank(pages, [
      { index: 2, score: 0.61 },
      { index: 0, score: 0.44 },
    ])
    expect(out.map((p) => p.pageNumber)).toEqual([3, 1])
  })

  it('REPLACES the cosine with the cross-encoder score and stamps `reranked`', () => {
    // Keeping the cosine here would mean the reranked floor is compared against
    // a dense number downstream — the exact mixup clearsRelevanceFloor exists
    // to prevent.
    const out = applyRerank(pages, [{ index: 1, score: 0.61 }])
    expect(out[0]).toMatchObject({ pageNumber: 2, score: 0.61, reranked: true })
  })

  it('drops positions the model did not return — it was asked for a top-N', () => {
    expect(applyRerank(pages, [{ index: 0, score: 0.5 }])).toHaveLength(1)
  })

  it('ignores an out-of-range index without shifting the pages around it', () => {
    // A positional bug (reading pages[i] of the loop instead of pages[r.index])
    // would return page 1 here instead of page 3.
    const out = applyRerank(pages, [
      { index: 9, score: 0.99 },
      { index: 2, score: 0.5 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].pageNumber).toBe(3)
  })

  it('copies rather than mutates — the caller still holds the dense list for its fallback', () => {
    applyRerank(pages, [{ index: 0, score: 0.61 }])
    expect(pages[0]).toMatchObject({ score: 0.9 })
    expect(pages[0].reranked).toBeUndefined()
  })

  it('returns [] for an empty verdict (the caller, not this, decides that means failure)', () => {
    expect(applyRerank(pages, [])).toEqual([])
  })
})

describe('clearsRelevanceFloor', () => {
  // The whole point: 0.30 sits between the two floors, so each of these two
  // assertions fails under a different single-floor mutation.
  it('keeps a reranked page whose score would fail the DENSE floor', () => {
    expect(clearsRelevanceFloor(page({ score: 0.3, reranked: true }))).toBe(true)
  })

  it('drops a dense page at the same score — a cosine is judged on the cosine floor', () => {
    expect(clearsRelevanceFloor(page({ score: 0.3 }))).toBe(false)
  })

  it('treats an explicit reranked:false as dense (fallback results carry no stamp)', () => {
    expect(clearsRelevanceFloor(page({ score: 0.3, reranked: false }))).toBe(false)
    expect(clearsRelevanceFloor(page({ score: 0.6, reranked: false }))).toBe(true)
  })

  it('is inclusive at both floors', () => {
    expect(clearsRelevanceFloor(page({ score: STUDENT_QA_PROFILE.scoreFloor }))).toBe(true)
    expect(clearsRelevanceFloor(page({ score: STUDENT_QA_PROFILE.rerankScoreFloor, reranked: true }))).toBe(true)
  })

  it('drops a reranked page just under the reranked floor', () => {
    expect(clearsRelevanceFloor(page({ score: STUDENT_QA_PROFILE.rerankScoreFloor - 0.001, reranked: true }))).toBe(false)
  })
})

describe('rerank entitlement knobs', () => {
  const original = process.env.RERANK_ENABLED
  afterEach(() => {
    if (original === undefined) delete process.env.RERANK_ENABLED
    else process.env.RERANK_ENABLED = original
  })

  it('is ON by default and turned off only by an explicit opt-out', () => {
    // Default-on: reranking beats dense retrieval on every golden-set metric,
    // so the better answer is what an environment gets without configuring
    // anything, and the switch exists to turn it OFF.
    delete process.env.RERANK_ENABLED
    expect(isRerankEnabled()).toBe(true)
    process.env.RERANK_ENABLED = '1'
    expect(isRerankEnabled()).toBe(true)
    // Only an explicit opt-out disables it, in the two spellings someone would
    // actually reach for.
    process.env.RERANK_ENABLED = '0'
    expect(isRerankEnabled()).toBe(false)
    process.env.RERANK_ENABLED = 'FALSE'
    expect(isRerankEnabled()).toBe(false)
    // Anything else stays ON — a typo must never silently downgrade every
    // student's answers to the weaker ranking.
    process.env.RERANK_ENABLED = 'no'
    expect(isRerankEnabled()).toBe(true)
  })

  it('ties the pool width to the entitlement — a wide pool with no reranker is a 40-page prompt', () => {
    delete process.env.RERANK_ENABLED
    expect(studentQaTopK()).toBe(STUDENT_QA_PROFILE.topK)
    process.env.RERANK_ENABLED = '0'
    expect(studentQaTopK()).toBe(STUDENT_QA_PROFILE.denseTopK)
    // And the two really are different depths — otherwise the coupling is moot.
    expect(STUDENT_QA_PROFILE.topK).toBeGreaterThan(STUDENT_QA_PROFILE.denseTopK)
  })
})
