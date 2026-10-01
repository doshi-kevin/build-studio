// Tests for buildLectureContext — the shared "lecture so far" AI context
// assembly. Pins the 0-indexed-transcription ↔ 1-indexed-extraction-page
// mapping (a silent-mismatch class of bug) and the model-budget truncation.

import { describe, it, expect } from 'vitest'
import { buildLectureContext } from '@/lib/live-classroom/lecture-context'
import { LIVE_QUIZ_MAX_CONTEXT_CHARS } from '@/lib/ai/config'

const HALF_LIMIT = Math.floor(LIVE_QUIZ_MAX_CONTEXT_CHARS / 2)

function page(pageNumber: number, text: string) {
  return { pageNumber, text, headings: [] }
}

describe('buildLectureContext', () => {
  it('pairs each 0-indexed transcription with its 1-indexed extraction page', () => {
    const result = buildLectureContext(
      { pages: [page(1, 'SLIDE-ONE-TEXT'), page(2, 'SLIDE-TWO-TEXT')] },
      [
        { page_number: 0, text: 'spoken on first slide' },
        { page_number: 1, text: 'spoken on second slide' },
      ],
    )

    expect(result.slidesCovered).toBe(2)
    // Slide 1 section carries page 1's text, slide 2 carries page 2's —
    // an off-by-one would cross-wire every slide with the wrong transcript.
    expect(result.slideContent).toContain('--- Slide 1 ---\nSLIDE-ONE-TEXT')
    expect(result.slideContent).toContain('--- Slide 2 ---\nSLIDE-TWO-TEXT')
    expect(result.transcriptionContent).toContain('--- Slide 1 (spoken) ---\nspoken on first slide')
    expect(result.transcriptionContent).toContain('--- Slide 2 (spoken) ---\nspoken on second slide')
  })

  it('keeps the transcription when no extraction page matches', () => {
    const result = buildLectureContext({ pages: [page(1, 'ONLY-PAGE-ONE')] }, [
      { page_number: 0, text: 'covered' },
      { page_number: 5, text: 'spoken on a page with no extraction' },
    ])

    expect(result.slideContent).not.toContain('Slide 6 ---')
    expect(result.transcriptionContent).toContain('--- Slide 6 (spoken) ---')
    expect(result.slidesCovered).toBe(2)
  })

  it('handles a null deck extraction (no deck uploaded)', () => {
    const result = buildLectureContext(null, [{ page_number: 0, text: 'just speech' }])

    expect(result.slideContent).toBe('')
    expect(result.transcriptionContent).toContain('just speech')
  })

  it('truncates each half at the model budget and marks the cut', () => {
    const huge = 'x'.repeat(HALF_LIMIT + 1000)
    const result = buildLectureContext({ pages: [page(1, huge)] }, [
      { page_number: 0, text: huge },
    ])

    expect(result.slideContent.length).toBeLessThanOrEqual(HALF_LIMIT + 20)
    expect(result.slideContent.endsWith('[...truncated]')).toBe(true)
    expect(result.transcriptionContent.length).toBeLessThanOrEqual(HALF_LIMIT + 20)
    expect(result.transcriptionContent.endsWith('[...truncated]')).toBe(true)
  })

  it('passes under-budget content through untouched', () => {
    const result = buildLectureContext({ pages: [page(1, 'short')] }, [
      { page_number: 0, text: 'short speech' },
    ])
    expect(result.slideContent).not.toContain('[...truncated]')
    expect(result.transcriptionContent).not.toContain('[...truncated]')
  })
})
