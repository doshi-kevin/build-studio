// roadmap-rail-v1's ranking decision: given one topic's ranked page matches
// inside one document, which pages does the reference rail point at?
//
// Every number here is measured, not invented — they come from running the real
// profile over the seeded CS584 corpus (tmp/rail-probe). That matters because
// the obvious implementation, an absolute score floor, provably cannot work on
// this scale and the numbers are the proof: an off-topic control query scores
// 0.54 against a deck it has nothing to do with, while "optimization" against
// the 5-page note that is entirely about optimization peaks at 0.574. Any floor
// that rejects the first deletes the second.
import { describe, it, expect } from 'vitest'
import { selectRailPages, RAIL_TOP_N } from '@/lib/pinecone/topic-pages'

const m = (page: number, score: number) => ({ page, score })

describe('selectRailPages', () => {
  it('keeps the cluster at the top and drops the flat tail', () => {
    // "positional encoding" vs Lecture 6: three pages teach it, then the scores
    // level off across the rest of the deck.
    const pages = selectRailPages([
      m(30, 0.706), m(29, 0.66), m(31, 0.657),
      m(35, 0.627), m(39, 0.626), m(36, 0.624), m(1, 0.62),
    ])
    expect(pages).toEqual([30, 29, 31])
  })

  it('returns a single page when only one carries the topic', () => {
    // "negative sampling" vs the 4-page word2vec note.
    expect(selectRailPages([m(4, 0.71), m(1, 0.63), m(3, 0.62), m(2, 0.61)])).toEqual([4])
  })

  it('caps a genuinely diffuse topic instead of listing the document', () => {
    // "self-attention" vs the Transformers deck really is everywhere; the rail
    // is a pointer, so it says where to START, not where it appears.
    const flat = Array.from({ length: 12 }, (_, i) => m(i + 12, 0.683 - i * 0.002))
    expect(selectRailPages(flat)).toHaveLength(RAIL_TOP_N)
  })

  it('anchors a low-scoring topic that no absolute floor could keep', () => {
    // "optimization" vs the logistic-regression note: the whole document is
    // about it, so nothing stands out and every score is low. This is the case
    // an absolute floor tuned to reject off-topic matches would silently kill.
    // All three land inside the margin, which is the honest answer for a
    // five-page note whose every page is about the topic.
    expect(selectRailPages([m(1, 0.574), m(2, 0.568), m(5, 0.544)])).toEqual([1, 2, 5])
  })

  it('rejects matches below the garbage floor', () => {
    // A stray extraction artefact that matches nothing gets no anchor at all,
    // rather than pointing the student at the document's least-bad page.
    expect(selectRailPages([m(3, 0.31), m(9, 0.28)])).toEqual([])
  })

  it('reads the best score rather than trusting arrival order', () => {
    // The cutoff is defined against the best match; if that were taken as
    // "position 0" a provider returning unsorted matches would silently anchor
    // to whatever came first.
    expect(selectRailPages([m(8, 0.60), m(2, 0.70), m(5, 0.66)])).toEqual([2, 5])
  })

  it('drops a duplicate page kept by a re-index mid-query', () => {
    expect(selectRailPages([m(7, 0.70), m(7, 0.69), m(9, 0.68)])).toEqual([7, 9])
  })

  it('returns nothing for a material with no matches', () => {
    expect(selectRailPages([])).toEqual([])
  })
})
