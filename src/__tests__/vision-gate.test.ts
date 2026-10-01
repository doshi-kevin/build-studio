// @vitest-environment node
//
// The VLM cost gate (docs/designs §4 "the hard part") — shouldCallVision decides
// whether a page costs $0 (Tier 0) or burns a Gemini call, and isLikelyScannedPdf
// routes whole scanned docs. These are pure functions and the single most
// cost-sensitive logic in the feature, so they get exhaustive coverage here.
import { describe, it, expect } from 'vitest'
import { shouldCallVision, isLikelyScannedPdf } from '@/lib/document-parser/vision'

const sig = (text: string, fontSizeBuckets?: number) => ({ pageNumber: 1, text, fontSizeBuckets })

describe('shouldCallVision — does this page need the VLM?', () => {
  it('does NOT fire on plain prose (the common, must-stay-$0 case)', () => {
    const r = shouldCallVision(sig('This is a normal lecture slide about the history of computing and its impact on society.'))
    expect(r.callVision).toBe(false)
    expect(r.reasons).toEqual([]) // no math/greek/noise signals matched
  })

  it('does NOT fire on a near-blank page (too sparse, skip unconditionally)', () => {
    const r = shouldCallVision(sig('Title'))
    expect(r.callVision).toBe(false)
    expect(r.reasons).toContain('page too sparse')
  })

  it('fires on mathematical alphanumeric symbols (PPT equation glyphs 𝐰 𝜕)', () => {
    const r = shouldCallVision(sig('The gradient \u{1D6C1}L with respect to \u{1D430} updates the weights each step.'))
    expect(r.callVision).toBe(true)
    expect(r.reasons.some((x) => x.startsWith('math-alpha='))).toBe(true)
  })

  it('fires on math operators (∑ ∫ √ ≤ ∂)', () => {
    expect(shouldCallVision(sig('We minimize the loss ∑ over all training examples in the batch.')).callVision).toBe(true)
    expect(shouldCallVision(sig('The integral ∫ f(x) dx is approximated numerically across the interval.')).callVision).toBe(true)
  })

  it('fires on TWO+ greek letters but NOT on a single one', () => {
    expect(shouldCallVision(sig('Parameters α and β control the learning-rate schedule across epochs.')).callVision).toBe(true)
    // a lone greek letter in prose is not enough to spend a call
    expect(shouldCallVision(sig('The angle α is measured in radians for this rotation example here.')).callVision).toBe(false)
  })

  it('fires on dense PPT equation-editor noise (["!#$%&] cluster), not sparse punctuation', () => {
    // high-density placeholder glyphs left when PPT flattens an equation
    expect(shouldCallVision(sig('ab!#$%&!#$%&cd')).callVision).toBe(true)
    // ordinary sentence punctuation must NOT trip the noise trigger
    expect(shouldCallVision(sig('Hello! This is a normal sentence, with ordinary punctuation and nothing else.')).callVision).toBe(false)
  })

  it('does NOT fire on font-size variety alone (buckets add a reason, not a trigger)', () => {
    const r = shouldCallVision(sig('A slide with several heading sizes but no math content whatsoever in the body.', 6))
    expect(r.callVision).toBe(false)
    expect(r.reasons.some((x) => x.startsWith('font-sizes='))).toBe(true)
  })

  it('surfaces the matched signals in reasons (observability)', () => {
    const r = shouldCallVision(sig('Loss ∑ with α, β terms summed across the dataset for each gradient step.'))
    expect(r.callVision).toBe(true)
    expect(r.reasons.some((x) => x.startsWith('math-ops='))).toBe(true)
    expect(r.reasons.some((x) => x.startsWith('greek='))).toBe(true)
  })
})

describe('isLikelyScannedPdf — whole-doc routing for image-only PDFs', () => {
  it('flags a doc with pages but almost no extractable text', () => {
    expect(isLikelyScannedPdf({ pageCount: 12, wordCount: 0 })).toBe(true)
    expect(isLikelyScannedPdf({ pageCount: 1, wordCount: 9 })).toBe(true)
  })

  it('does NOT flag a normal text PDF', () => {
    expect(isLikelyScannedPdf({ pageCount: 12, wordCount: 4000 })).toBe(false)
    expect(isLikelyScannedPdf({ pageCount: 1, wordCount: 10 })).toBe(false) // boundary: 10 is enough
  })

  it('does NOT flag an empty/zero-page doc (nothing to scan)', () => {
    expect(isLikelyScannedPdf({ pageCount: 0, wordCount: 0 })).toBe(false)
  })
})
