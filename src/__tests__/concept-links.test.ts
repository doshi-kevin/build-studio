// Guards the ConceptDetail "Assessed by" routing contract: quizzes/exams
// deep-link to the specific activity (/quizzes/[id]), NOT the quizzes list — the
// exact regression reported on PR #360. Assignments deep-link to their page.

import { describe, it, expect } from 'vitest'
import { conceptSourceHref } from '@/lib/roadmap/concept-links'

const SECTION = 'sec-1'

describe('conceptSourceHref', () => {
  it('deep-links a quiz to the specific quiz page (not the list)', () => {
    const href = conceptSourceHref(SECTION, { type: 'quiz', id: 'Q1' })
    expect(href).toBe('/professor/courses/sec-1/quizzes/Q1')
    expect(href).not.toBe('/professor/courses/sec-1/quizzes') // the old bug
  })

  it('deep-links an exam to the quizzes route (exams share /quizzes/[id])', () => {
    expect(conceptSourceHref(SECTION, { type: 'exam', id: 'E1' })).toBe('/professor/courses/sec-1/quizzes/E1')
  })

  it('deep-links an assignment to its own page', () => {
    expect(conceptSourceHref(SECTION, { type: 'assignment', id: 'A1' })).toBe('/professor/courses/sec-1/assignments/A1')
  })

  it('deep-links a live quiz to the live-classroom hub (no per-interaction page)', () => {
    expect(conceptSourceHref(SECTION, { type: 'live_quiz', id: 'LQ1' })).toBe('/professor/courses/sec-1/live-classroom')
  })
})
