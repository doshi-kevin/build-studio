/**
 * #645 part 3 — the per-student table sorted with `a.quizAccuracy ?? -1`. Because
 * the sentinel is a real number it got scaled by the direction multiplier, so
 * clicking to sort ASCENDING floated students with no quiz accuracy to the top,
 * contradicting the nulls-last behaviour that descending order showed.
 *
 * This renders the REAL table and clicks the real header. An earlier draft
 * re-implemented the comparator inside the test, which would have passed against
 * the unfixed component — a mirror of the code under test proves nothing.
 *
 * The oracle is the null row's position in BOTH directions: asserting one
 * direction passes against the old code, since descending was already correct.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const getOrGenerateSessionReport = vi.fn()

vi.mock('@/lib/live-classroom/report/actions', () => ({
  getOrGenerateSessionReport: (...a: unknown[]) => getOrGenerateSessionReport(...a),
  retrySessionNarrative: vi.fn(),
}))
vi.mock('@/components/live-classroom/shared/RecordingPlayer', () => ({ RecordingSection: () => null }))
vi.mock('@/components/shared/MarkdownLatex', () => ({ MarkdownLatex: () => null }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { SessionReportView } from '@/components/professor/live-classroom/SessionReportView'

const student = (name: string, quizAccuracy: number | null) => ({
  id: name,
  name,
  attended: true,
  lateJoin: false,
  questionsAsked: 0,
  quizzesAnswered: quizAccuracy == null ? 0 : 2,
  quizAccuracy,
})

/** One quiz present so the accuracy column (and its sort header) renders. */
const report = {
  meta: { durationMinutes: 50, slideCount: 3, slidesWithTranscript: 3, deckCount: 1 },
  empty: false,
  attendance: { tracked: true, enrolledCount: 3, attendedCount: 3, rate: 100, attendees: [], absent: [] },
  participation: { activeCount: 3, enrolledCount: 3 },
  quizzes: [
    {
      interactionId: 'q1',
      title: 'Quiz 1',
      respondentCount: 3,
      accuracy: 70,
      questions: [],
      concepts: [],
    },
  ],
  polls: [],
  students: [student('Bravo Forty', 40), student('Zulu Nodata', null), student('Alpha Ninety', 90)],
  qa: { total: 0, answeredCount: 0, unanswered: [], answered: [], top: [] },
  struggleConcepts: [],
  aiNarrative: null,
  narrativeFailed: false,
}

/** Row order of the student table, by the name cell. */
function studentOrder(): string[] {
  return screen
    .getAllByText(/Bravo Forty|Zulu Nodata|Alpha Ninety/)
    .map((el) => el.textContent?.trim() ?? '')
}

describe('#645 part 3 — student table null-accuracy sorting', () => {
  beforeEach(() => {
    getOrGenerateSessionReport.mockReset().mockResolvedValue({ report })
  })

  it('keeps the no-accuracy student last in BOTH sort directions', async () => {
    render(<SessionReportView roomId="room-1" />)

    // Wait for the report to resolve past the loading state.
    const header = await screen.findByRole('button', { name: /quiz score/i })

    // First click sorts by accuracy (descending is the table's default entry).
    fireEvent.click(header)
    await waitFor(() => expect(studentOrder().length).toBe(3))
    const firstClick = studentOrder()
    expect(firstClick[firstClick.length - 1]).toBe('Zulu Nodata')

    // Second click flips direction — this is where `?? -1` floated the null to the top.
    fireEvent.click(header)
    await waitFor(() => expect(studentOrder().length).toBe(3))
    const secondClick = studentOrder()
    expect(secondClick[secondClick.length - 1]).toBe('Zulu Nodata')

    // And the direction genuinely flipped for the rows that DO have data.
    expect(firstClick.filter((n) => n !== 'Zulu Nodata')).toEqual(
      secondClick.filter((n) => n !== 'Zulu Nodata').reverse(),
    )
  })
})
