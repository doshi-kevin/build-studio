// The "Missed" state on the student quiz card: an unattempted quiz whose due
// date has passed shows as missed instead of offering a Start button that the
// server would only reject.
//
// The whole risk in this state is WHICH INSTANT counts as "passed". A quiz due
// date is picked with a `type="date"` input, so it is stored date-only / at UTC
// midnight and carries no time (see quiz-due-date-boundary.test.ts, #311).
// Comparing that stored instant directly — `new Date(dueDate) < Date.now()` —
// marks the quiz missed from the FIRST moment of its own due day, i.e. 7pm
// Eastern the evening BEFORE, while the server's checkDueDate() goes through
// `dueDeadlineMs()` and keeps accepting attempts until the end of that day.
// That gap silently deletes the last day of every quiz, and it is invisible in
// any fixture whose due date is a round number of days away — which is why the
// due-day cases below pin specific instants rather than `Date.now() ± 1 day`.
//
// Scoped to the state machine, not the layout: the card's responsive behaviour
// is container-query driven and jsdom cannot evaluate it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StudentQuizCard } from '@/components/student/quizzes/StudentQuizCard'
import { buildQuiz, buildQuizAttempt } from './helpers/test-data-builders'

/** Stored form of a due date picked as "Dec 31 2026" in the professor's UI. */
const DUE_DEC_31 = '2026-12-31T00:00:00.000Z'

const noop = () => {}

function renderCard(quiz: ReturnType<typeof buildQuiz>, attempts = [] as ReturnType<typeof buildQuizAttempt>[]) {
  return render(
    <StudentQuizCard quiz={quiz} attempts={attempts} onStart={noop} onResume={noop} onViewResults={noop} />,
  )
}

/** The status word rendered next to the quiz title. */
const startButton = () => screen.queryByRole('button', { name: /start/i })

afterEach(() => {
  vi.useRealTimers()
})

describe('StudentQuizCard — missed state and the due-day boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('does NOT mark a quiz missed during its own due day', () => {
    // Midday on the stated due date. The server is still accepting attempts here,
    // so the card must still offer Start.
    vi.setSystemTime(new Date('2026-12-31T12:00:00.000Z'))
    renderCard(buildQuiz({ dueDate: DUE_DEC_31 }))

    expect(screen.queryByText('Missed')).toBeNull()
    expect(screen.getByText('Not Started')).toBeTruthy()
    expect(startButton()).toBeTruthy()
  })

  it('does not contradict its own due-date badge', () => {
    // The sharpest form of the bug: one second past UTC midnight the card said
    // "Due Dec 31, 2026" and "Missed" side by side, on Dec 31.
    vi.setSystemTime(new Date('2026-12-31T00:00:01.000Z'))
    renderCard(buildQuiz({ dueDate: DUE_DEC_31 }))

    expect(screen.getByText(/Due Dec 31, 2026/)).toBeTruthy()
    expect(screen.queryByText('Missed')).toBeNull()
    expect(startButton()).toBeTruthy()
  })

  it('marks it missed once the due day is actually over', () => {
    vi.setSystemTime(new Date('2027-01-01T00:00:01.000Z'))
    renderCard(buildQuiz({ dueDate: DUE_DEC_31 }))

    expect(screen.getByText('Missed')).toBeTruthy()
    // The point of the state: no Start button that would only error server-side.
    expect(startButton()).toBeNull()
  })

  it('never marks a quiz with no due date as missed', () => {
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    renderCard(buildQuiz({ dueDate: null }))

    expect(screen.queryByText('Missed')).toBeNull()
    expect(startButton()).toBeTruthy()
  })

  it('lets a submitted attempt win over missed', () => {
    // A student who sat the quiz and then let the deadline pass has completed it,
    // not missed it — the new branch must stay below the attempt checks.
    vi.setSystemTime(new Date('2027-01-01T00:00:01.000Z'))
    renderCard(
      buildQuiz({ dueDate: DUE_DEC_31, maxAttempts: null }),
      [buildQuizAttempt({ status: 'submitted', score: 88, submittedAt: '2026-12-30T10:00:00Z' })],
    )

    expect(screen.queryByText('Missed')).toBeNull()
    expect(screen.getByText('Completed')).toBeTruthy()
  })

  it('lets an in-progress attempt win over missed', () => {
    // An attempt already open when the deadline passed must still be resumable —
    // the server finishes it via the late path rather than refusing it.
    vi.setSystemTime(new Date('2027-01-01T00:00:01.000Z'))
    renderCard(
      buildQuiz({ dueDate: DUE_DEC_31 }),
      [buildQuizAttempt({ status: 'in_progress' })],
    )

    expect(screen.queryByText('Missed')).toBeNull()
    expect(screen.getByText('In Progress')).toBeTruthy()
    expect(screen.getByRole('button', { name: /resume/i })).toBeTruthy()
  })
})
