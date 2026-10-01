// Tests for quizPlayerReducer — student quiz-taking state machine.
// Covers answer setting, flagging, navigation, timer, submission, and save state.

import { describe, it, expect, vi } from 'vitest'
import {
  quizPlayerReducer,
  type QuizPlayerState,
} from '@/components/shared/quiz/quiz-context/use-quiz-player-reducer'
import { buildQuestion, buildQuiz, buildQuizAttempt } from './helpers/test-data-builders'

// ── Helpers ──────────────────────────────────────────────────

function buildState(overrides: Partial<QuizPlayerState> = {}): QuizPlayerState {
  return {
    quiz: buildQuiz(),
    questions: [
      buildQuestion({ id: 'q-1' }),
      buildQuestion({ id: 'q-2' }),
      buildQuestion({ id: 'q-3' }),
    ],
    attempt: buildQuizAttempt({ answers: {} }),
    currentQuestionIndex: 0,
    timeRemainingSeconds: 600,
    isDirty: false,
    dirtyQuestionIds: new Set<string>(),
    ...overrides,
  }
}

// ── SET_ANSWER ───────────────────────────────────────────────

describe('SET_ANSWER', () => {
  it('creates a new answer for a question with no prior answer', () => {
    const state = buildState()
    const result = quizPlayerReducer(state, {
      type: 'SET_ANSWER',
      payload: { questionId: 'q-1', answer: { selectedChoiceIds: ['c-2'] } },
    })
    expect(result.attempt.answers['q-1']).toMatchObject({
      questionId: 'q-1',
      selectedChoiceIds: ['c-2'],
      isFlagged: false,
    })
    expect(result.isDirty).toBe(true)
    expect(result.dirtyQuestionIds.has('q-1')).toBe(true)
  })

  it('merges into an existing answer', () => {
    const state = buildState({
      attempt: buildQuizAttempt({
        answers: {
          'q-1': {
            questionId: 'q-1',
            selectedChoiceIds: ['c-1'],
            isFlagged: true,
            timeSpentSeconds: 10,
            isCorrect: null,
            earnedPoints: null,
            optionChanges: 0,
            tabSwitches: 0,
            copyAttempts: 0,
          },
        },
      }),
    })
    const result = quizPlayerReducer(state, {
      type: 'SET_ANSWER',
      payload: { questionId: 'q-1', answer: { selectedChoiceIds: ['c-2'] } },
    })
    expect(result.attempt.answers['q-1'].selectedChoiceIds).toEqual(['c-2'])
    expect(result.attempt.answers['q-1'].isFlagged).toBe(true) // preserved
  })

  it('accumulates multiple dirty question IDs', () => {
    let state = buildState()
    state = quizPlayerReducer(state, {
      type: 'SET_ANSWER',
      payload: { questionId: 'q-1', answer: { selectedChoiceIds: ['c-1'] } },
    })
    state = quizPlayerReducer(state, {
      type: 'SET_ANSWER',
      payload: { questionId: 'q-2', answer: { selectedChoiceIds: ['c-2'] } },
    })
    expect(state.dirtyQuestionIds.size).toBe(2)
    expect(state.dirtyQuestionIds.has('q-1')).toBe(true)
    expect(state.dirtyQuestionIds.has('q-2')).toBe(true)
  })

  it('does not duplicate an already-dirty question ID', () => {
    let state = buildState()
    state = quizPlayerReducer(state, {
      type: 'SET_ANSWER',
      payload: { questionId: 'q-1', answer: { selectedChoiceIds: ['c-1'] } },
    })
    state = quizPlayerReducer(state, {
      type: 'SET_ANSWER',
      payload: { questionId: 'q-1', answer: { selectedChoiceIds: ['c-2'] } },
    })
    expect(state.dirtyQuestionIds.size).toBe(1)
  })
})

// ── TOGGLE_FLAG ──────────────────────────────────────────────

describe('TOGGLE_FLAG', () => {
  it('flags an unflagged question', () => {
    const state = buildState({
      attempt: buildQuizAttempt({
        answers: {
          'q-1': {
            questionId: 'q-1',
            selectedChoiceIds: ['c-1'],
            isFlagged: false,
            timeSpentSeconds: 0,
            isCorrect: null,
            earnedPoints: null,
            optionChanges: 0,
            tabSwitches: 0,
            copyAttempts: 0,
          },
        },
      }),
    })
    const result = quizPlayerReducer(state, {
      type: 'TOGGLE_FLAG',
      payload: { questionId: 'q-1' },
    })
    expect(result.attempt.answers['q-1'].isFlagged).toBe(true)
    expect(result.isDirty).toBe(true)
  })

  it('unflags a flagged question', () => {
    const state = buildState({
      attempt: buildQuizAttempt({
        answers: {
          'q-1': {
            questionId: 'q-1',
            selectedChoiceIds: [],
            isFlagged: true,
            timeSpentSeconds: 0,
            isCorrect: null,
            earnedPoints: null,
            optionChanges: 0,
            tabSwitches: 0,
            copyAttempts: 0,
          },
        },
      }),
    })
    const result = quizPlayerReducer(state, {
      type: 'TOGGLE_FLAG',
      payload: { questionId: 'q-1' },
    })
    expect(result.attempt.answers['q-1'].isFlagged).toBe(false)
  })

  it('creates an answer entry when flagging a question with no prior answer', () => {
    const state = buildState()
    const result = quizPlayerReducer(state, {
      type: 'TOGGLE_FLAG',
      payload: { questionId: 'q-1' },
    })
    expect(result.attempt.answers['q-1']).toBeDefined()
    expect(result.attempt.answers['q-1'].isFlagged).toBe(true)
    expect(result.attempt.answers['q-1'].questionId).toBe('q-1')
  })

  it('adds the question to dirtyQuestionIds', () => {
    const state = buildState()
    const result = quizPlayerReducer(state, {
      type: 'TOGGLE_FLAG',
      payload: { questionId: 'q-2' },
    })
    expect(result.dirtyQuestionIds.has('q-2')).toBe(true)
  })
})

// ── GO_TO_QUESTION ───────────────────────────────────────────

describe('GO_TO_QUESTION', () => {
  it('navigates to a valid index', () => {
    const state = buildState({ currentQuestionIndex: 0 })
    const result = quizPlayerReducer(state, {
      type: 'GO_TO_QUESTION',
      payload: { index: 2 },
    })
    expect(result.currentQuestionIndex).toBe(2)
  })

  it('ignores negative index', () => {
    const state = buildState({ currentQuestionIndex: 1 })
    const result = quizPlayerReducer(state, {
      type: 'GO_TO_QUESTION',
      payload: { index: -1 },
    })
    expect(result.currentQuestionIndex).toBe(1)
  })

  it('ignores index beyond question count', () => {
    const state = buildState({ currentQuestionIndex: 0 })
    const result = quizPlayerReducer(state, {
      type: 'GO_TO_QUESTION',
      payload: { index: 3 }, // 3 questions → max valid is 2
    })
    expect(result.currentQuestionIndex).toBe(0)
  })

  it('allows index at last position', () => {
    const state = buildState({ currentQuestionIndex: 0 })
    const result = quizPlayerReducer(state, {
      type: 'GO_TO_QUESTION',
      payload: { index: 2 },
    })
    expect(result.currentQuestionIndex).toBe(2)
  })
})

// ── NEXT_QUESTION / PREV_QUESTION ────────────────────────────

describe('NEXT_QUESTION', () => {
  it('advances to the next question', () => {
    const state = buildState({ currentQuestionIndex: 0 })
    const result = quizPlayerReducer(state, { type: 'NEXT_QUESTION' })
    expect(result.currentQuestionIndex).toBe(1)
  })

  it('does not advance past the last question', () => {
    const state = buildState({ currentQuestionIndex: 2 })
    const result = quizPlayerReducer(state, { type: 'NEXT_QUESTION' })
    expect(result.currentQuestionIndex).toBe(2)
  })
})

describe('PREV_QUESTION', () => {
  it('goes to the previous question', () => {
    const state = buildState({ currentQuestionIndex: 2 })
    const result = quizPlayerReducer(state, { type: 'PREV_QUESTION' })
    expect(result.currentQuestionIndex).toBe(1)
  })

  it('does not go before the first question', () => {
    const state = buildState({ currentQuestionIndex: 0 })
    const result = quizPlayerReducer(state, { type: 'PREV_QUESTION' })
    expect(result.currentQuestionIndex).toBe(0)
  })
})

// ── TICK_TIMER ───────────────────────────────────────────────

describe('TICK_TIMER', () => {
  it('decrements the timer by 1 second (no deadline)', () => {
    const state = buildState({ timeRemainingSeconds: 100 })
    const result = quizPlayerReducer(state, { type: 'TICK_TIMER' })
    expect(result.timeRemainingSeconds).toBe(99)
  })

  it('increments timeSpentSeconds on the attempt', () => {
    const state = buildState({
      timeRemainingSeconds: 100,
      attempt: buildQuizAttempt({ timeSpentSeconds: 5 }),
    })
    const result = quizPlayerReducer(state, { type: 'TICK_TIMER' })
    expect(result.attempt.timeSpentSeconds).toBe(6)
  })

  it('does not go below zero', () => {
    const state = buildState({ timeRemainingSeconds: 0 })
    const result = quizPlayerReducer(state, { type: 'TICK_TIMER' })
    expect(result.timeRemainingSeconds).toBe(0)
  })

  it('uses wall-clock deadline when provided', () => {
    // Freeze the clock: the reducer FLOORS (deadlineMs - Date.now()) / 1000, so with a
    // live clock a single millisecond between building the deadline and reading it
    // yields 29 — this passed only when both Date.now() calls landed in the same ms,
    // and failed under full-suite load.
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const state = buildState({ timeRemainingSeconds: 100 })
      const result = quizPlayerReducer(state, {
        type: 'TICK_TIMER',
        payload: { deadlineMs: now + 30_000 }, // 30 seconds from now
      })
      expect(result.timeRemainingSeconds).toBe(30) // the deadline wins over the state's 100
    } finally {
      clock.mockRestore()
    }
  })

  it('clamps deadline-based calculation to zero', () => {
    const state = buildState({ timeRemainingSeconds: 100 })
    const result = quizPlayerReducer(state, {
      type: 'TICK_TIMER',
      payload: { deadlineMs: Date.now() - 5000 }, // deadline already passed
    })
    expect(result.timeRemainingSeconds).toBe(0)
  })

  it('is a no-op for untimed quizzes (null)', () => {
    const state = buildState({ timeRemainingSeconds: null })
    const result = quizPlayerReducer(state, { type: 'TICK_TIMER' })
    expect(result.timeRemainingSeconds).toBeNull()
    expect(result).toBe(state) // reference equality — same object
  })
})

// ── SUBMIT ───────────────────────────────────────────────────

describe('SUBMIT', () => {
  it('sets attempt status to submitted with timestamp', () => {
    const state = buildState()
    const result = quizPlayerReducer(state, {
      type: 'SUBMIT',
      payload: { submittedAt: '2026-01-01T12:00:00Z' },
    })
    expect(result.attempt.status).toBe('submitted')
    expect(result.attempt.submittedAt).toBe('2026-01-01T12:00:00Z')
    expect(result.isDirty).toBe(true)
  })
})

// ── MARK_SAVED ───────────────────────────────────────────────

describe('MARK_SAVED', () => {
  it('clears isDirty flag', () => {
    const state = buildState({ isDirty: true })
    const result = quizPlayerReducer(state, { type: 'MARK_SAVED' })
    expect(result.isDirty).toBe(false)
  })

  it('clears dirtyQuestionIds', () => {
    const state = buildState({
      isDirty: true,
      dirtyQuestionIds: new Set(['q-1', 'q-2']),
    })
    const result = quizPlayerReducer(state, { type: 'MARK_SAVED' })
    expect(result.dirtyQuestionIds.size).toBe(0)
  })
})

// ── Unknown action ───────────────────────────────────────────

describe('unknown action', () => {
  it('returns state unchanged', () => {
    const state = buildState()
    // @ts-expect-error — intentionally passing unknown action
    const result = quizPlayerReducer(state, { type: 'UNKNOWN' })
    expect(result).toBe(state)
  })
})
