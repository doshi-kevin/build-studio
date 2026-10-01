// C10 sends a student to a booking page with a note addressed to their
// professor. The date has to be a day the professor is actually there, and the
// note has to be true — those are the two ways this can embarrass someone.

import { describe, it, expect } from 'vitest'
import { draftBookingNote, nextOfficeHoursDate } from '@/lib/ai/student-tutor/booking-note'

// 2026-07-31 is a Friday.
const FRIDAY = '2026-07-31T09:00:00.000Z'

describe('nextOfficeHoursDate', () => {
  it('takes today when the professor holds hours today — a later slot is still bookable', () => {
    expect(nextOfficeHoursDate(['friday'], FRIDAY)).toBe('2026-07-31')
  })

  it('wraps into next week rather than giving up', () => {
    expect(nextOfficeHoursDate(['thursday'], FRIDAY)).toBe('2026-08-06')
  })

  it('picks the soonest of several days', () => {
    expect(nextOfficeHoursDate(['wednesday', 'monday', 'saturday'], FRIDAY)).toBe('2026-08-01')
  })

  it('returns null when there are no office hours to book, rather than a plausible date', () => {
    expect(nextOfficeHoursDate([], FRIDAY)).toBeNull()
    expect(nextOfficeHoursDate(['someday'], FRIDAY)).toBeNull()
  })

  it('returns null on an unparseable clock instead of an Invalid Date string', () => {
    expect(nextOfficeHoursDate(['friday'], 'not-a-date')).toBeNull()
  })
})

const MISS = {
  quiz: 'Transformers Quiz 2',
  question: 'Which paper title?',
  yourAnswer: 'Speed',
  correctAnswer: 'Need',
}

describe('draftBookingNote', () => {
  it('leads with the topics, then the evidence', () => {
    const note = draftBookingNote(['Attention', 'Beam Search'], MISS)
    expect(note).toContain('Attention and Beam Search')
    expect(note).toContain('Transformers Quiz 2')
    expect(note).toContain('Which paper title?')
    // Private note to the professor, so unlike the class question it DOES quote
    // what they answered — that's what makes the meeting useful.
    expect(note).toContain('Speed')
    expect(note).toContain('Need')
  })

  it('names at most three topics, so the note stays a note', () => {
    const note = draftBookingNote(['A', 'B', 'C', 'D', 'E'], null)
    expect(note).toContain('A, B and C')
    expect(note).not.toContain('D')
  })

  it('still writes a usable note when there is nothing specific to point at', () => {
    expect(draftBookingNote([], null)).toBe("Hi — I'd like some help with the course material.")
  })

  it('reads correctly with exactly one topic', () => {
    expect(draftBookingNote(['Attention'], null)).toBe("Hi — I'd like some help with Attention.")
  })
})
