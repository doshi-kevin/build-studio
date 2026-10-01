// Answers must survive leaving the page mid-debounce (#311).
//
// QuizPlayerProvider debounces answer saves by 1.5s and clears the pending timer on
// unmount. A student who picked an option and immediately navigated away — or hit
// reload — lost that answer outright: the timer never fired and only TIME was
// flushed. The fix mirrors flushTime with a flushAnswers that writes whatever the
// debounce had not yet committed.
import { useEffect } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { QuizPlayerProvider, useQuizPlayer } from '@/components/shared/quiz/quiz-context/QuizPlayerContext'
import { buildQuiz, buildQuestion, buildQuizAttempt } from './helpers/test-data-builders'

const mockSaveAnswer = vi.fn()
const mockUpdateAttemptTime = vi.fn()

vi.mock('@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions', () => ({
  saveAnswer: (...args: unknown[]) => mockSaveAnswer(...args),
  updateAttemptTime: (...args: unknown[]) => mockUpdateAttemptTime(...args),
  saveProctoringBatch: vi.fn(),
  saveProctoringSnapshot: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const QUESTIONS = [buildQuestion({ id: 'q-1' }), buildQuestion({ id: 'q-2' })]
const QUIZ = buildQuiz({ id: 'quiz-1', timeLimitMinutes: null, proctoringEnabled: false })
const ATTEMPT = buildQuizAttempt({ id: 'attempt-1', quizId: 'quiz-1', status: 'in_progress' })

/** Exposes dispatch so a test can answer a question the way the player does. */
let answerQuestion: (choiceId: string, questionId?: string) => void

function Harness() {
  const { dispatch } = useQuizPlayer()
  // Published from an effect, not during render — reassigning an outer variable
  // mid-render is a side effect (react-hooks/globals). RTL flushes effects inside
  // render()'s act(), so this is set before any test touches it.
  useEffect(() => {
    answerQuestion = (choiceId: string, questionId = 'q-1') =>
      dispatch({
        type: 'SET_ANSWER',
        payload: { questionId, answer: { selectedChoiceIds: [choiceId] } },
      })
  }, [dispatch])
  return null
}

function renderPlayer() {
  return render(
    <QuizPlayerProvider quiz={QUIZ} questions={QUESTIONS} attempt={ATTEMPT}>
      <Harness />
    </QuizPlayerProvider>,
  )
}

/** questionIds passed to saveAnswer, in call order. */
const savedQuestionIds = () => mockSaveAnswer.mock.calls.map((c) => c[1])

describe('QuizPlayerProvider answer flush (#311)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Cleared HERE, not in afterEach: RTL's auto-cleanup unmounts leftover trees
    // after this file's afterEach runs, and that unmount is itself a flush — so a
    // clear in afterEach lands too early and the stray call leaks into the next
    // test. (These mocks only ever resolve; see the CLAUDE.md note about touching
    // THROWING mocks in beforeEach.)
    mockSaveAnswer.mockClear()
    mockUpdateAttemptTime.mockClear()
    mockSaveAnswer.mockResolvedValue({ success: true })
    mockUpdateAttemptTime.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes a pending answer when the player unmounts inside the debounce window', async () => {
    const { unmount } = renderPlayer()

    act(() => answerQuestion('c-2'))
    // Deliberately do NOT advance past the 1500ms debounce — this is the exact
    // window in which the answer used to vanish.
    act(() => { vi.advanceTimersByTime(200) })
    expect(mockSaveAnswer).not.toHaveBeenCalled()

    act(() => { unmount() })

    expect(mockSaveAnswer).toHaveBeenCalledTimes(1)
    const [attemptId, questionId, payload] = mockSaveAnswer.mock.calls[0]
    expect(attemptId).toBe('attempt-1')
    expect(questionId).toBe('q-1')
    expect(payload.selectedChoiceIds).toEqual(['c-2'])
  })

  it('flushes on beforeunload — the reload case', async () => {
    renderPlayer()

    act(() => answerQuestion('c-3'))
    act(() => { vi.advanceTimersByTime(200) })

    act(() => { window.dispatchEvent(new Event('beforeunload')) })

    expect(mockSaveAnswer).toHaveBeenCalledTimes(1)
    expect(mockSaveAnswer.mock.calls[0][2].selectedChoiceIds).toEqual(['c-3'])
  })

  it('does not flush on every keystroke — only when the player goes away', async () => {
    // The flush effect reads its data from a ref precisely so it can have an empty
    // dependency list. If it ever depends on the answer state, React tears down and
    // re-runs the cleanup on EVERY answer change, double-writing each one.
    renderPlayer()

    act(() => answerQuestion('c-1'))
    act(() => answerQuestion('c-2'))
    act(() => answerQuestion('c-3'))
    act(() => { vi.advanceTimersByTime(200) })

    expect(mockSaveAnswer).not.toHaveBeenCalled()
  })

  it('writes nothing when there is no unsaved answer', async () => {
    const { unmount } = renderPlayer()

    act(() => { unmount() })

    expect(mockSaveAnswer).not.toHaveBeenCalled()
  })

  it('flushes only the answer the debounce had not saved yet', async () => {
    const { unmount } = renderPlayer()

    // q-1 is answered and allowed to save normally...
    act(() => answerQuestion('c-2', 'q-1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(savedQuestionIds()).toEqual(['q-1'])

    // ...then q-2 is answered and the student leaves inside the debounce window.
    act(() => answerQuestion('c-1', 'q-2'))
    act(() => { vi.advanceTimersByTime(200) })
    act(() => { unmount() })

    // Exactly one more write, for q-2 only. A flush that walked all answers
    // instead of the dirty set would re-write q-1 on every navigation — extra
    // writes per student per page change, and a stale answer overwriting a newer
    // one if the two requests land out of order.
    expect(savedQuestionIds()).toEqual(['q-1', 'q-2'])
  })
})
