// @vitest-environment node
//
// Pure planning logic for concept-first quiz generation (no AI, no mocks):
// batch ramp sizing, content-block splitting by source marker, passage
// assembly per batch, and question-slot allocation across ranked concepts.
import { describe, it, expect } from 'vitest'
import {
  rampBatchSizes,
  splitContentBlocks,
  passagesForBatch,
  planQuizBatches,
  pickLeastVisited,
  pagesFromMarkers,
  mergeStoredConcepts,
  type QuizConcept,
  type StoredQuizConcept,
} from '@/lib/quiz/concept-plan'

const concept = (name: string, importance: number, markers: string[] = []): QuizConcept => ({
  name,
  importance,
  markers,
  summary: `tests ${name}`,
})

describe('rampBatchSizes', () => {
  it('ramps 3, 5, 25, 25, … so the first batch lands fast and the bulk amortizes', () => {
    expect(rampBatchSizes(30)).toEqual([3, 5, 22])
    expect(rampBatchSizes(18)).toEqual([3, 5, 10])
    expect(rampBatchSizes(100)).toEqual([3, 5, 25, 25, 25, 17])
  })

  it('keeps small requests a single call (ramp would only add overhead)', () => {
    expect(rampBatchSizes(1)).toEqual([1])
    expect(rampBatchSizes(5)).toEqual([5])
    expect(rampBatchSizes(6)).toEqual([3, 3])
  })

  it('always sums to the requested total', () => {
    for (const n of [1, 4, 7, 13, 30, 55, 100]) {
      expect(rampBatchSizes(n).reduce((a, b) => a + b, 0)).toBe(n)
    }
  })
})

describe('splitContentBlocks', () => {
  const content = `Title: NLP Course

[Lecture 1, page 1]
Intro to n-grams.

[Lecture 1, page 2]
Laplace smoothing details.

[Lecture 2, page 1]
Backpropagation.`

  it('splits blocks by their marker line and keeps the preamble', () => {
    const { preamble, blocks } = splitContentBlocks(content)
    expect(preamble).toBe('Title: NLP Course')
    expect([...blocks.keys()]).toEqual(['[Lecture 1, page 1]', '[Lecture 1, page 2]', '[Lecture 2, page 1]'])
    expect(blocks.get('[Lecture 1, page 2]')).toContain('Laplace smoothing')
    expect(blocks.get('[Lecture 1, page 2]')).not.toContain('Backpropagation')
  })

  it('returns everything as preamble when there are no markers', () => {
    const { preamble, blocks } = splitContentBlocks('just plain text, no markers')
    expect(preamble).toBe('just plain text, no markers')
    expect(blocks.size).toBe(0)
  })
})

describe('passagesForBatch', () => {
  const { preamble, blocks } = splitContentBlocks(`Header

[Doc, page 1]
Block one.

[Doc, page 2]
Block two.

[Doc, page 3]
Block three.`)

  it('assembles only the batch concepts’ blocks, in document order', () => {
    const batch = {
      concepts: [concept('c3', 5, ['[Doc, page 3]']), concept('c1', 9, ['[Doc, page 1]'])],
    }
    const out = passagesForBatch(batch, preamble, blocks, 'FULL')
    expect(out).toContain('Header')
    expect(out).toContain('Block one')
    expect(out).toContain('Block three')
    expect(out).not.toContain('Block two')
    // Document order, not concept order
    expect(out.indexOf('Block one')).toBeLessThan(out.indexOf('Block three'))
  })

  it('falls back to CAPPED full content when no marker resolves (hallucinated refs)', () => {
    const batch = { concepts: [concept('x', 5, ['[Nope, page 99]'])] }
    expect(passagesForBatch(batch, preamble, blocks, 'FULL CONTENT')).toBe('FULL CONTENT')
    // The fallback must never re-send an unbounded corpus (the s60 benchmark
    // pathology: 1.08M input tokens) — it is capped like a narrowed batch.
    const huge = 'X'.repeat(200_000)
    expect(passagesForBatch(batch, preamble, blocks, huge).length).toBeLessThanOrEqual(60_000)
  })

  it('fuzzily matches model-drifted markers by page + title containment', () => {
    // Runtime-extracted markers are model-copied: "[Lecture 4, page 2]" must
    // still find the block titled "[Doc, page 2]"? No — different titles never
    // match. But a SHORTENED real title must: block "[Doc, page 2]", marker
    // "[doc, page 2]" (case) and "[Doc — extended title, page 2]" (containment).
    const cased = { concepts: [concept('x', 5, ['[doc, page 2]'])] }
    expect(passagesForBatch(cased, preamble, blocks, 'FULL')).toContain('Block two')
    const contained = { concepts: [concept('x', 5, ['[Doc extra words, page 3]'])] }
    expect(passagesForBatch(contained, preamble, blocks, 'FULL')).toContain('Block three')
    // Same title but WRONG page must not match anything → capped fallback.
    const wrongPage = { concepts: [concept('x', 5, ['[Doc, page 99]'])] }
    expect(passagesForBatch(wrongPage, preamble, blocks, 'FULL')).toBe('FULL')
  })
})

describe('planQuizBatches', () => {
  it('assigns top concepts first and pools the leftovers as replacements', () => {
    const concepts = Array.from({ length: 12 }, (_, i) => concept(`c${i}`, 12 - i))
    const plan = planQuizBatches(concepts, 8) // sizes [3, 5]
    expect(plan.batches.map((b) => b.concepts.length)).toEqual([3, 5])
    // First batch = most important concepts → professor sees the best first.
    expect(plan.batches[0].concepts.map((c) => c.name)).toEqual(['c0', 'c1', 'c2'])
    expect(plan.pool.map((c) => c.name)).toEqual(['c8', 'c9', 'c10', 'c11'])
  })

  it('cycles concepts when there are fewer than questions (different angle per revisit)', () => {
    const concepts = [concept('a', 9), concept('b', 5)]
    const plan = planQuizBatches(concepts, 6) // sizes [3, 3]
    const names = plan.batches.flatMap((b) => b.concepts.map((c) => c.name))
    expect(names).toEqual(['a', 'b', 'a', 'b', 'a', 'b'])
    expect(plan.pool).toEqual([]) // every concept used — nothing left to replace with
  })

  it('slices a pinned difficulty distribution across batches exactly', () => {
    const concepts = Array.from({ length: 10 }, (_, i) => concept(`c${i}`, 10 - i))
    const plan = planQuizBatches(concepts, 8, { easy: 2, medium: 4, hard: 2 })
    const totals = { easy: 0, medium: 0, hard: 0 }
    for (const b of plan.batches) {
      expect(b.concepts.length).toBe(b.difficulty!.easy + b.difficulty!.medium + b.difficulty!.hard)
      totals.easy += b.difficulty!.easy
      totals.medium += b.difficulty!.medium
      totals.hard += b.difficulty!.hard
    }
    expect(totals).toEqual({ easy: 2, medium: 4, hard: 2 }) // per-level totals preserved
  })

  it('re-sorts by importance defensively even if extraction order drifts', () => {
    const plan = planQuizBatches([concept('low', 2), concept('high', 9)], 2)
    expect(plan.batches[0].concepts[0].name).toBe('high')
  })
})

describe('pagesFromMarkers', () => {
  it('parses page numbers from marker lines, deduped and sorted', () => {
    expect(pagesFromMarkers(['[Intro to NLP, page 14]', '[Intro to NLP, page 3]', '[Intro to NLP, page 14]'])).toEqual([3, 14])
  })

  it('ignores strings that are not valid markers (hallucinated output)', () => {
    expect(pagesFromMarkers(['page 4', 'Laplace smoothing', '[Notes, page x]'])).toEqual([])
  })

  it('survives commas and brackets inside the title', () => {
    expect(pagesFromMarkers(['[Lecture 2: Sets, Maps [draft], page 7]'])).toEqual([7])
  })
})

describe('mergeStoredConcepts', () => {
  const stored = (name: string, importance: number, pages: number[]): StoredQuizConcept => ({
    name,
    importance,
    pages,
    summary: `tests ${name}`,
  })

  it('rebuilds markers from pages against each item CURRENT title', () => {
    const merged = mergeStoredConcepts([
      { title: 'Week 1 (renamed)', concepts: [stored('Perplexity', 8, [2, 5])] },
    ])
    expect(merged[0].markers).toEqual(['[Week 1 (renamed), page 2]', '[Week 1 (renamed), page 5]'])
  })

  it('merges near-identical names across items: max importance, unioned markers, re-ranked', () => {
    const merged = mergeStoredConcepts([
      { title: 'Slides A', concepts: [stored('Laplace  Smoothing', 5, [1]), stored('Perplexity', 9, [3])] },
      { title: 'Slides B', concepts: [stored('laplace smoothing', 7, [4])] },
    ])
    expect(merged.map((c) => c.name)).toEqual(['Perplexity', 'Laplace  Smoothing'])
    const laplace = merged[1]
    expect(laplace.importance).toBe(7)
    expect(laplace.markers).toEqual(['[Slides A, page 1]', '[Slides B, page 4]'])
  })

  it('merged markers resolve against the blocks the runtime content formatter emits', () => {
    // End-to-end invariant: stored pages → markers → splitContentBlocks keys.
    const content = '[Deck, page 1]\nAlpha teaches X\n\n[Deck, page 2]\nBeta teaches Y'
    const merged = mergeStoredConcepts([{ title: 'Deck', concepts: [stored('Beta', 6, [2])] }])
    const { preamble, blocks } = splitContentBlocks(content)
    const passage = passagesForBatch({ concepts: merged }, preamble, blocks, content)
    expect(passage).toContain('Beta teaches Y')
    expect(passage).not.toContain('Alpha teaches X')
  })
})

// Makeup refills draw the LEAST-visited concepts first — the old head-of-ranked
// cycling piled every refill onto the already-heaviest top concepts (the s100
// benchmark's same-fact clusters all sat on top-ranked concepts).
describe('pickLeastVisited', () => {
  const a = concept('a', 9)
  const b = concept('b', 7)
  const c = concept('c', 5)

  it('orders by fewest visits, importance breaking ties', () => {
    const visits = new Map([['a', 3], ['b', 1], ['c', 1]])
    expect(pickLeastVisited([a, b, c], visits, 3).map((x) => x.name)).toEqual(['b', 'c', 'a'])
  })

  it('treats a concept with no recorded visits as zero', () => {
    const visits = new Map([['a', 1], ['b', 1]])
    expect(pickLeastVisited([a, b, c], visits, 1).map((x) => x.name)).toEqual(['c'])
  })

  it('cycles the sorted order when asked for more than exist', () => {
    const visits = new Map([['a', 2]])
    expect(pickLeastVisited([a, b], visits, 3).map((x) => x.name)).toEqual(['b', 'a', 'b'])
  })

  it('returns empty for an empty concept list or non-positive take', () => {
    expect(pickLeastVisited([], new Map(), 2)).toEqual([])
    expect(pickLeastVisited([a], new Map(), 0)).toEqual([])
  })
})
