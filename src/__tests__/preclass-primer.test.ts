// Tests for the pure Pre-Class Primer helpers: source assembly + freshness hash
// (content.ts) and script formatting for TTS (script.ts). These are the parts
// with real branching logic — the DB reads and LLM/TTS calls are integration
// concerns exercised at runtime.

import { describe, it, expect } from 'vitest'
import { assemblePrimerContent, type PrimerRawInputs } from '@/lib/preclass-audio/content'
import { countWords, estimateDurationSeconds, truncateScriptForTts } from '@/lib/preclass-audio/script'
import { PRECLASS_PRIMER_MAX_CONTEXT_CHARS, PRECLASS_PRIMER_WPM } from '@/lib/ai/config'

function baseInputs(overrides: Partial<PrimerRawInputs> = {}): PrimerRawInputs {
  return {
    moduleTitle: 'Thermodynamics',
    moduleDescription: 'Energy and entropy',
    lectureTitle: 'The Second Law',
    lectureDescription: 'Entropy always increases',
    instructorNote: 'Focus on Carnot cycles',
    lectureText: 'Slide 1: entropy. Slide 2: heat engines.',
    previousLectureTitle: 'The First Law',
    previousLectureDescription: 'Conservation of energy',
    ...overrides,
  }
}

describe('assemblePrimerContent', () => {
  it('produces a deterministic hash for identical inputs', () => {
    const a = assemblePrimerContent(baseInputs())
    const b = assemblePrimerContent(baseInputs())
    expect(a.sourceHash).toBe(b.sourceHash)
    expect(a.sourceHash).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
  })

  it('changes the hash when any source field changes', () => {
    const base = assemblePrimerContent(baseInputs())
    const changedTitle = assemblePrimerContent(baseInputs({ lectureTitle: 'The Third Law' }))
    const changedText = assemblePrimerContent(baseInputs({ lectureText: 'different slides' }))
    const changedPrev = assemblePrimerContent(baseInputs({ previousLectureTitle: 'Something else' }))
    expect(changedTitle.sourceHash).not.toBe(base.sourceHash)
    expect(changedText.sourceHash).not.toBe(base.sourceHash)
    expect(changedPrev.sourceHash).not.toBe(base.sourceHash)
  })

  it('includes the previous lecture only when one is provided', () => {
    const withPrev = assemblePrimerContent(baseInputs())
    const withoutPrev = assemblePrimerContent(
      baseInputs({ previousLectureTitle: null, previousLectureDescription: null }),
    )
    expect(withPrev.userContent).toContain('Previous lecture')
    expect(withoutPrev.userContent).not.toContain('Previous lecture')
    expect(withPrev.sourceHash).not.toBe(withoutPrev.sourceHash)
  })

  it('flags hasMaterial=false only when title-only (no description/note/text)', () => {
    const empty = assemblePrimerContent(
      baseInputs({
        moduleDescription: '',
        lectureDescription: '',
        instructorNote: '',
        lectureText: '',
        previousLectureTitle: null,
        previousLectureDescription: null,
      }),
    )
    expect(empty.hasMaterial).toBe(false)
    // Any one substantive field flips it back on.
    expect(assemblePrimerContent(baseInputs({ lectureText: 'x', moduleDescription: '', lectureDescription: '', instructorNote: '' })).hasMaterial).toBe(true)
    expect(assemblePrimerContent(baseInputs()).hasMaterial).toBe(true)
  })

  it('caps lecture text at the context budget', () => {
    const huge = 'Z'.repeat(PRECLASS_PRIMER_MAX_CONTEXT_CHARS + 5000)
    const out = assemblePrimerContent(baseInputs({ lectureText: huge }))
    // 'Z' appears in no other field, so counting them measures exactly how much
    // lecture text survived the cap.
    const zCount = (out.userContent.match(/Z/g) ?? []).length
    expect(zCount).toBe(PRECLASS_PRIMER_MAX_CONTEXT_CHARS)
  })
})

describe('script helpers', () => {
  it('counts words and estimates duration at the primer WPM', () => {
    const words = Array.from({ length: PRECLASS_PRIMER_WPM }, () => 'word').join(' ')
    expect(countWords(words)).toBe(PRECLASS_PRIMER_WPM)
    // Exactly WPM words → ~60 seconds.
    expect(estimateDurationSeconds(words)).toBe(60)
    expect(countWords('')).toBe(0)
  })

  it('leaves a script under the cap untouched', () => {
    const s = 'Short primer. Nothing to trim here.'
    expect(truncateScriptForTts(s, 1000)).toBe(s)
  })

  it('truncates at the last sentence boundary before the cap', () => {
    const s = 'One sentence here. Two sentence here. Three sentence here that overflows the cap.'
    const out = truncateScriptForTts(s, 40)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.endsWith('.')).toBe(true)
    expect(out).toBe('One sentence here. Two sentence here.')
  })

  it('hard-slices at the cap when there is no usable sentence break (pathological input)', () => {
    // No sentence boundary at all in the first maxChars → must still bound the
    // spend by cutting at the cap rather than returning the whole string.
    const unpunctuated = 'word '.repeat(50).trim() // 249 chars, no '. '
    const out = truncateScriptForTts(unpunctuated, 40)
    expect(out.length).toBeLessThanOrEqual(40)

    // A break that lands in the first half (<= maxChars * 0.5) is too early to
    // be worth keeping, so it's ignored and we hard-slice instead of cutting to
    // the tiny prefix.
    const earlyBreak = 'Hi. ' + 'x'.repeat(200)
    const out2 = truncateScriptForTts(earlyBreak, 40)
    expect(out2.length).toBe(40)
    expect(out2).not.toBe('Hi.')
  })
})
