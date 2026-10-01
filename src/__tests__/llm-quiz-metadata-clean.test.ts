// cleanAiQuizMetadataField (src/lib/ai/llm-client.ts) — the deterministic guard
// between a model-supplied quiz title/description and the professor's studio form
// (#102). The reported failure was NOT a bespoke title parser: Gemini closed the
// title string with the wrong quote, structured output failed, and the jsonrepair
// salvage path recovered a title carrying the whole rest of the object inside it.
// The first test reproduces that end to end, so the root cause stays pinned.
import { describe, it, expect } from 'vitest'
import { salvageRawQuestions, cleanAiQuizMetadataField } from '@/lib/ai/llm-client'

// Shape of the real reported output: `"title": "…Quiz'` (opened with a double
// quote, closed with a single one), so the next `"` jsonrepair finds is the one
// before `questions`.
const MISMATCHED_QUOTE_OUTPUT = `{"title": "ECE-322 Lesson 0: Course Syllabus and Introduction Quiz', 'description': 'This quiz covers the fundamental course requirements, grading policy and schedule.', "questions": [{"questionType":"true_false","questionText":"The syllabus lists office hours.","correctAnswer":true,"difficulty":"easy"}]}`

describe('AI quiz title recovery (#102)', () => {
  it('cleans the swallowed-sibling-key title the salvage path recovers', () => {
    const salvaged = salvageRawQuestions(MISMATCHED_QUOTE_OUTPUT)
    // The questions survive the repair — that is why the salvage path exists.
    expect(salvaged?.questions).toHaveLength(1)
    // …but the recovered title has eaten the description key. This is the bug.
    expect(salvaged?.title).toContain(`', 'description':`)

    expect(cleanAiQuizMetadataField(salvaged?.title, 200)).toBe(
      'ECE-322 Lesson 0: Course Syllabus and Introduction Quiz',
    )
  })

  it('clamps an over-long title to the 200-char cap the quiz form enforces', () => {
    const long = `${'Thermodynamics '.repeat(30)}Quiz`
    const cleaned = cleanAiQuizMetadataField(long, 200)!
    expect(cleaned.length).toBeLessThanOrEqual(200)
    // Clamped on a word boundary, so it never ends mid-word.
    expect(cleaned).toMatch(/Thermodynamics$/)
  })

  it('hard-cuts a long value with no word boundary near the cap', () => {
    // The other arm of the clamp: `lastSpace > maxLength * 0.6` is false, so
    // there is no boundary worth clamping to and the value is cut flat. Without
    // this the word-boundary branch is the only one the suite ever runs.
    const cleaned = cleanAiQuizMetadataField(`Quiz ${'z'.repeat(400)}`, 200)!
    expect(cleaned).toHaveLength(200)
    expect(cleaned.endsWith('z')).toBe(true)
  })

  it('keeps only the first line, dropping trailing model commentary', () => {
    // A newline means the model kept talking after the value it was asked for;
    // whitespace collapsing alone would fold that commentary INTO the title.
    expect(
      cleanAiQuizMetadataField('Cell Division Quiz\n\nThis quiz covers mitosis and meiosis.', 200),
    ).toBe('Cell Division Quiz')
  })

  it('strips a label prefix and matched wrapping quotes but keeps inner quotes', () => {
    expect(cleanAiQuizMetadataField('**Title:** "Cell Division Quiz"', 200)).toBe('Cell Division Quiz')
    expect(cleanAiQuizMetadataField('"Hamlet" Analysis Quiz', 200)).toBe('"Hamlet" Analysis Quiz')
    // Opens AND closes on a quote, so the greedy unwrap would eat the title's
    // own quotes. The delimiter recurring inside is what rules the unwrap out.
    expect(cleanAiQuizMetadataField('"Hamlet" vs "Macbeth"', 200)).toBe('"Hamlet" vs "Macbeth"')
  })

  it('leaves prose that merely mentions a key name intact', () => {
    // A 2000-char description is free prose. The swallowed-key cut requires the
    // quotes jsonrepair always copies, so unquoted prose is not a match.
    const prose = 'Covers the record fields: name, description: and how each is indexed.'
    expect(cleanAiQuizMetadataField(prose, 2000)).toBe(prose)
  })

  it('returns undefined for anything unusable, so the caller can fall back', () => {
    expect(cleanAiQuizMetadataField(undefined, 200)).toBeUndefined()
    expect(cleanAiQuizMetadataField('   ', 200)).toBeUndefined()
    expect(cleanAiQuizMetadataField(42, 200)).toBeUndefined()
    // Nothing precedes the swallowed key — there is no real title to keep.
    expect(cleanAiQuizMetadataField(`', 'description': 'Covers arrays.'`, 200)).toBeUndefined()
  })
})
