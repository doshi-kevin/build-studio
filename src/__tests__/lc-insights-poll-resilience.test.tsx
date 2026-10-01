/**
 * Both post-class surfaces poll a server action every few seconds while the report
 * generates. The action call was unguarded, so ONE rejected fetch escaped the async
 * callback, the re-arming setTimeout never ran, and the poll was dead — leaving the
 * spinner up forever. A dead poll looks exactly like "still generating", so nobody
 * knew to reload.
 *
 * The oracle is whether the poll RECOVERS: a call that rejects must be followed by
 * another call. Asserting "a try/catch exists" or "no crash occurred" would pass
 * against the broken version too, since the throw was already swallowed by the
 * unhandled-rejection handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const getStudentClassInsights = vi.fn()

vi.mock('@/lib/live-classroom/insights/student-actions', () => ({
  getStudentClassInsights: (...args: unknown[]) => getStudentClassInsights(...args),
}))
// Children of the ready state pull in heavy deps we don't exercise here.
vi.mock('./../components/student/live-classroom/FlashcardDeck', () => ({ FlashcardDeck: () => null }))
vi.mock('./../components/student/live-classroom/PracticeQuizPlayer', () => ({ PracticeQuizPlayer: () => null }))
vi.mock('@/components/live-classroom/shared/RecordingPlayer', () => ({ RecordingSection: () => null }))
vi.mock('./../components/student/live-classroom/LiveNotesEditor', () => ({ LiveNotesEditor: () => null }))
vi.mock('@/lib/live-classroom/notes/use-notes', () => ({
  useLiveNotes: () => ({ notes: '', setNotes: vi.fn(), saving: false, savedAt: null }),
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { StudentInsightsView } from '@/components/student/live-classroom/StudentInsightsView'

const GENERATING = { status: 'generating' as const }

function readyPack(extrasPending: boolean) {
  return {
    status: 'ready' as const,
    myQuizzes: [],
    content: {
      version: 1 as const,
      empty: false,
      extrasPending,
      noMaterials: false,
      meta: { durationMinutes: 42, slideCount: 3, slidesWithTranscript: 3, deckCount: 1 },
      quizzes: [],
      concepts: [],
      summary: extrasPending ? null : 'A summary.',
      summaryFailed: false,
      flashcards: null,
      flashcardsFailed: false,
      practiceQuiz: null,
      practiceQuizFailed: false,
    },
  }
}

describe('student study pack — poll survives a failed fetch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getStudentClassInsights.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps polling after one rejected fetch and still reaches the ready state', async () => {
    getStudentClassInsights
      .mockResolvedValueOnce(GENERATING)
      // The blip that used to kill the loop permanently.
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(readyPack(false))

    render(<StudentInsightsView roomId="room-1" />)

    // First poll → still generating.
    await waitFor(() => expect(getStudentClassInsights).toHaveBeenCalledTimes(1))

    // Second poll rejects. If the loop is dead this is the last call ever made.
    await vi.advanceTimersByTimeAsync(3000)
    await waitFor(() => expect(getStudentClassInsights).toHaveBeenCalledTimes(2))

    // The proof: a THIRD call happens despite the rejection.
    await vi.advanceTimersByTimeAsync(3000)
    await waitFor(() => expect(getStudentClassInsights).toHaveBeenCalledTimes(3))

    // And the surface actually resolves rather than spinning.
    expect(await screen.findByText('A summary.')).toBeInTheDocument()
  })

  it('surfaces the retryable error state when it fails before anything is rendered', async () => {
    getStudentClassInsights.mockRejectedValue(new TypeError('Failed to fetch'))

    render(<StudentInsightsView roomId="room-1" />)

    // Exhaust the tolerated blips (3 consecutive failures).
    await waitFor(() => expect(getStudentClassInsights).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(3000)

    // Not a spinner: the error state, with a way out.
    expect(await screen.findByText(/couldn't load your study pack/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('does NOT discard already-rendered content when the extras poll later fails', async () => {
    // Deterministic content is ready and readable; only the LLM extras are pending.
    getStudentClassInsights
      .mockResolvedValueOnce(readyPack(true))
      .mockRejectedValue(new TypeError('Failed to fetch'))

    render(<StudentInsightsView roomId="room-1" />)
    await waitFor(() => expect(getStudentClassInsights).toHaveBeenCalledTimes(1))

    // Burn through every tolerated failure.
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(3000)

    // The student keeps their study pack — wiping it to an error page would be a
    // worse outcome than the bug being fixed.
    await waitFor(() =>
      expect(screen.queryByText(/couldn't load your study pack/i)).not.toBeInTheDocument(),
    )
    // "Your notes" renders only in the ready branch, never in the error branch.
    expect(screen.getByText(/your notes/i)).toBeInTheDocument()
  })
})
