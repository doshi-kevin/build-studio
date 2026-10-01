// stripAssetTags (src/lib/ai/llm-client.ts) — scrubs leaked internal
// "[ASSET <id>]" reference tags from student-visible AI question text.
// The prompt forbids the tag, but Gemini occasionally parrots it; a leak is a
// student-visibility bug, so this transform is the last line of defense.
import { describe, it, expect } from 'vitest'
import { stripAssetTags } from '@/lib/ai/llm-client'

describe('stripAssetTags', () => {
  it('removes a parroted tag and collapses the doubled space it leaves behind', () => {
    expect(stripAssetTags('Based on Table [ASSET a1], what is the trend?')).toBe(
      'Based on Table, what is the trend?',
    )
  })

  it('strips multiple tags in one string', () => {
    expect(stripAssetTags('Compare [ASSET a1] and [ASSET b2] values.')).toBe('Compare and values.')
  })

  it('is case-insensitive on the ASSET keyword', () => {
    expect(stripAssetTags('See [asset a1] and [Asset b2].')).toBe('See and.')
  })

  it('leaves a normal [Title, page N] citation untouched', () => {
    const s = 'Attention sums to one [Transformers, page 14].'
    expect(stripAssetTags(s)).toBe(s)
  })

  it('leaves bracketed text that is not an ASSET tag untouched', () => {
    const s = 'Choose option [A] over [B].'
    expect(stripAssetTags(s)).toBe(s)
  })

  it('trims surrounding whitespace from the result', () => {
    expect(stripAssetTags('  [ASSET a1] leading tag  ')).toBe('leading tag')
  })

  it('returns an empty string when the input is only a tag', () => {
    expect(stripAssetTags('[ASSET a1]')).toBe('')
  })

  it('does NOT strip a runaway tag longer than the 80-char id bound (avoids eating real prose)', () => {
    // A pathological "[ASSET <very long>]" exceeds the {1,80} bound, so the regex
    // does not match and the text is left intact rather than swallowing prose.
    const long = '[ASSET ' + 'x'.repeat(120) + ']'
    expect(stripAssetTags(long + ' tail')).toBe(long + ' tail')
  })

  it('handles an empty string', () => {
    expect(stripAssetTags('')).toBe('')
  })

  // Bare paraphrased form: Gemini sometimes drops the brackets and writes the
  // id as prose — "As shown in Asset a37, ..." (benchmark 2026-07-18,
  // fixed-s30 Q17). The id is replaced with a neutral reference so the
  // sentence still reads instead of leaving a hole.
  it('replaces a bare "Asset a<n>" reference with a neutral phrase', () => {
    expect(stripAssetTags('As shown in Asset a37, the process starts with a raw string.')).toBe(
      'As shown in the source material, the process starts with a raw string.',
    )
  })

  it('is case-insensitive on the bare form', () => {
    expect(stripAssetTags('Based on asset A3, which value is highest?')).toBe(
      'Based on the source material, which value is highest?',
    )
  })

  it('leaves ordinary uses of the word "asset" untouched', () => {
    const s = 'Depreciation spreads an asset a portion at a time across its life.'
    expect(stripAssetTags(s)).toBe(s)
    const s2 = 'Which asset class appreciated most?'
    expect(stripAssetTags(s2)).toBe(s2)
  })
})
