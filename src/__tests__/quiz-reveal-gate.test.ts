// canRevealQuizAnswers is the ONE predicate both student-facing review surfaces
// apply — the human review (getUnifiedResult → canReveal) and Athena's
// get_my_quiz_review. Extracted from an inline expression in getUnifiedResult so
// the two can't drift; that extraction is only safe if the boundary cases it used
// to carry are pinned here. The transitive tests (student-tutor-tools) exercise
// the three timings against a real due date; these pin the ones a mocked DB
// wouldn't reach: the null-due-date leak and the exact <= boundary.
import { describe, it, expect } from 'vitest'
import { canRevealQuizAnswers } from '@/lib/validations/quiz'

describe('canRevealQuizAnswers', () => {
  const NOW = new Date('2026-06-01T12:00:00Z')

  it('after_submission (and the null/undefined default) reveals immediately', () => {
    expect(canRevealQuizAnswers('after_submission', null, NOW)).toBe(true)
    // An absent setting must default to reveal — matches the schema default and
    // the `?? 'after_submission'` both callers apply.
    expect(canRevealQuizAnswers(null, null, NOW)).toBe(true)
    expect(canRevealQuizAnswers(undefined, '2020-01-01T00:00:00Z', NOW)).toBe(true)
  })

  it('never withholds under "never", even after the due date has long passed', () => {
    expect(canRevealQuizAnswers('never', '2020-01-01T00:00:00Z', NOW)).toBe(false)
  })

  it('after_due_date with NO due date stays closed — the guard the extraction carried', () => {
    // The inline version guarded this with `!!quizRow.due_date`. Drop that and a
    // quiz set to reveal "after the due date" but with no due date set would leak
    // the key from the moment it is submitted.
    expect(canRevealQuizAnswers('after_due_date', null, NOW)).toBe(false)
    expect(canRevealQuizAnswers('after_due_date', undefined, NOW)).toBe(false)
  })

  it('after_due_date reveals only once the deadline is strictly behind now', () => {
    const before = '2026-06-01T12:00:01Z' // one second in the future
    const at = '2026-06-01T12:00:00Z' // exactly the deadline
    const after = '2026-06-01T11:59:59Z' // one second past
    expect(canRevealQuizAnswers('after_due_date', before, NOW)).toBe(false)
    // Exactly-at-the-deadline is NOT yet revealed. This was `<=` (inclusive) when
    // the predicate did its own date math; it now defers to isPastDue, which the
    // server's late check also uses — and that check treats the deadline instant
    // as still ON TIME. The two must tie-break the same way, or there is a window
    // where the answer key is public while a submission is still accepted (#311).
    expect(canRevealQuizAnswers('after_due_date', at, NOW)).toBe(false)
    expect(canRevealQuizAnswers('after_due_date', after, NOW)).toBe(true)
  })

  it('holds a date-only due date closed for the whole of its last day', () => {
    // The bug that forced this predicate onto the shared helper: a due date picked
    // as `2026-06-01` is stored at UTC midnight, so the old `new Date(dueDate) <=
    // now` comparison revealed the key at 00:00 on the due date — while students
    // still had the entire day to submit. Both surfaces leaked it: the review page
    // and Athena's get_my_quiz_review tool.
    const dateOnly = '2026-06-01T00:00:00.000Z'
    expect(canRevealQuizAnswers('after_due_date', dateOnly, NOW)).toBe(false)
    expect(
      canRevealQuizAnswers('after_due_date', dateOnly, new Date('2026-06-01T23:59:59.999Z')),
    ).toBe(false)
    expect(
      canRevealQuizAnswers('after_due_date', dateOnly, new Date('2026-06-02T00:00:00.001Z')),
    ).toBe(true)
  })
})
