// Phantom-visual cleanup in materializeVisualsForBatch (benchmark 2026-07-18):
// a question that ends up WITHOUT a rendered visual must not say "the table
// shown" — the student sees no table. Two pure pieces: normalizeAssetId
// recovers model-mangled ids ("31" → "a31") so the visual materializes at all,
// and scrubPhantomVisualRefs rewrites the promise when it can't.
import { describe, it, expect } from 'vitest'
import { normalizeAssetId, scrubPhantomVisualRefs, type AssetRegistry } from '@/lib/quiz/ai-generation'

const registry: AssetRegistry = new Map([
  ['a31', { filePath: 'f.pdf', page: 3 }],
])

describe('normalizeAssetId', () => {
  it('returns a registered id unchanged', () => {
    expect(normalizeAssetId('a31', registry)).toBe('a31')
  })

  it('recovers a bare-numeric id the model mangled (benchmark fixed-s100 Q53)', () => {
    expect(normalizeAssetId('31', registry)).toBe('a31')
  })

  it('leaves an unrecoverable id unchanged (stays unregistered → text-only)', () => {
    expect(normalizeAssetId('99', registry)).toBe('99')
    expect(normalizeAssetId('bogus', registry)).toBe('bogus')
  })
})

describe('scrubPhantomVisualRefs', () => {
  it('rewrites "the <noun> shown" phrasing', () => {
    expect(scrubPhantomVisualRefs('Based on the diagram shown, what is the role of C?')).toBe(
      'Based on the diagram described in the material, what is the role of C?',
    )
  })

  it('handles plural nouns and other verbs', () => {
    expect(scrubPhantomVisualRefs('Based on the loss landscape visualizations shown, what changes?')).toBe(
      'Based on the loss landscape visualizations described in the material, what changes?',
    )
    expect(scrubPhantomVisualRefs('Read the value from the chart below.')).toBe(
      'Read the value from the chart described in the material.',
    )
  })

  it('rewrites "shown in the provided figure" phrasing', () => {
    expect(scrubPhantomVisualRefs('Based on the formula shown in the provided figure, compute P.')).toBe(
      'Based on the formula described in the material, compute P.',
    )
  })

  it('leaves text without visual promises untouched', () => {
    const s = 'According to the fuel-savings comparison in the lecture, which option wins?'
    expect(scrubPhantomVisualRefs(s)).toBe(s)
    const s2 = 'The study has shown that attention helps.'
    expect(scrubPhantomVisualRefs(s2)).toBe(s2)
  })

  it('does not rewrite "provided by/in ..." prose — only a bare trailing "provided"', () => {
    const s = 'Use the chart provided by the vendor to answer.'
    expect(scrubPhantomVisualRefs(s)).toBe(s)
    expect(scrubPhantomVisualRefs('Analyze the table provided.')).toBe(
      'Analyze the table described in the material.',
    )
  })
})
