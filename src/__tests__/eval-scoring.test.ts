// The eval harnesses' pure helpers, tested where CI can reach them.
//
// Both live under eval/, which needs Pinecone, Supabase and API keys to RUN —
// but the logic under test here needs none of that, and it decides the two
// sharpest numbers either harness produces: "did the model invent this
// citation" (grounding) and "is this needle question actually paraphrased"
// (coverage). A bug in either silently reports a green eval.

import { describe, it, expect } from 'vitest'

import { parseCitations, scoreAnswer } from '../../eval/grounding/scoring'
import { leakedTerms } from '../../eval/retrieval/needles'

const ctx = [
  { material: 'Lecture 7: Pretraining and Post-training', page: 21 },
  { material: 'Lecture 7 — Attention & Transformers', page: 4 },
  { material: 'Lecture 2: Language Modeling', page: 9 },
]

describe('parseCitations', () => {
  it('reads the marker format the prompt contracts for', () => {
    const cites = parseCitations('Attention weights sum to one [Lecture 6: Transformers, page 14].')
    expect(cites).toEqual([{ material: 'Lecture 6: Transformers', page: 14 }])
  })

  it('keeps a spoken citation as its deck, since that is the page it opens', () => {
    expect(parseCitations('He said so [Lecture 6 (spoken), slide 3].')).toEqual([
      { material: 'Lecture 6', page: 3 },
    ])
  })

  it('unpacks a compound marker into both citations', () => {
    // Observed in a real run: the model occasionally packs two sources into one
    // bracket. Read as a single citation it names a document called
    // "Lecture 2, page 9; Lecture 7", which is nothing, and both sources are lost.
    expect(parseCitations('Both cover it [Lecture 2, page 9; Lecture 7, page 22].')).toEqual([
      { material: 'Lecture 2', page: 9 },
      { material: 'Lecture 7', page: 22 },
    ])
  })

  it('de-duplicates a page cited several times in one answer', () => {
    const cites = parseCitations('First [L6, page 2]. Second [L6, page 2]. Third [L6, page 3].')
    expect(cites).toHaveLength(2)
  })
})

describe('scoreAnswer — what counts as an invented citation', () => {
  it('accepts a shortened title, because it opens the same page', () => {
    // The regression this exists for: exact-string matching scored seven of
    // these as INVENTED in a real run, which would have made the metric a liar.
    const out = scoreAnswer('BERT masks tokens [Lecture 7, page 21].', ctx, [])
    expect(out.fabricated_citations).toEqual([])
    expect(out.citation_validity).toBe(1)
  })

  it('flags a page the model was never shown', () => {
    const out = scoreAnswer('As shown [Lecture 5: Seq2Seq and Attention, page 109].', ctx, [])
    expect(out.fabricated_citations).toHaveLength(1)
    expect(out.citation_validity).toBe(0)
  })

  it('flags a real document cited at a page that was not in context', () => {
    const out = scoreAnswer('See [Lecture 2: Language Modeling, page 40].', ctx, [])
    expect(out.fabricated_citations).toHaveLength(1)
  })

  it('refuses an ambiguous short title when two documents could match', () => {
    // This corpus really does hold "Lecture 7: Pretraining…" AND "Lecture 7 —
    // Attention & Transformers". A bare "Lecture 7" is only safe to accept when
    // exactly one of them contributed that page — here both have a page 4 in
    // context, so the citation names no single page.
    const ambiguous = [...ctx, { material: 'Lecture 7: Pretraining and Post-training', page: 4 }]
    const out = scoreAnswer('See [Lecture 7, page 4].', ambiguous, [])
    expect(out.fabricated_citations).toHaveLength(1)
  })

  it('scores citations against gold pages separately from validity', () => {
    const gold = [{ material: 'Lecture 7: Pretraining and Post-training', page: 21 }]
    const out = scoreAnswer('One [Lecture 7, page 21]. Two [Lecture 2, page 9].', ctx, gold)
    // Both citations are valid — the model was shown both pages…
    expect(out.citation_validity).toBe(1)
    // …but only one is a labelled gold page. Gold labels are not exhaustive, so
    // this is concentration, not correctness.
    expect(out.citation_correctness).toBe(0.5)
  })

  it('reports null rather than zero when there is nothing to score', () => {
    const out = scoreAnswer('No citations here at all.', ctx, [])
    expect(out.citation_validity).toBeNull()
    expect(out.citation_correctness).toBeNull()
  })
})

describe('leakedTerms — the needle set’s paraphrase rule', () => {
  it('catches a banned term reused verbatim', () => {
    expect(leakedTerms('what is scaled dot-product attention', ['scaled dot-product'])).toEqual([
      'scaled dot-product',
    ])
  })

  it('is case-insensitive', () => {
    expect(leakedTerms('Why use a KV Cache?', ['kv cache'])).toHaveLength(1)
  })

  it('does not fire on a term merely contained in a longer word', () => {
    // "bed" inside "embeddings" is not a leak; matching on substrings would
    // reject good questions and quietly shrink the set.
    expect(leakedTerms('how are word embeddings built', ['bed'])).toEqual([])
  })

  it('handles course vocabulary full of regex metacharacters', () => {
    // "O(n^2)" as a pattern is a syntax error unescaped — which would throw
    // mid-generation rather than report a leak.
    expect(leakedTerms('why is it O(n^2) in the sequence length', ['O(n^2)'])).toHaveLength(1)
    expect(leakedTerms('what does the model compute', ['P(w|c)'])).toEqual([])
  })

  it('ignores empty entries in the banned list', () => {
    expect(leakedTerms('a perfectly fine question', ['', '  '])).toEqual([])
  })
})
