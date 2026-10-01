/**
 * Quiz Player reducer — manages student quiz-taking state.
 * Handles answers, flagging, navigation, timer, and submission.
 */

import type { Quiz, Question, QuizAttempt, Answer } from '@/lib/validations/quiz'

// ── State ────────────────────────────────────────────────────

export interface QuizPlayerState {
  quiz: Quiz
  questions: Question[]
  attempt: QuizAttempt
  currentQuestionIndex: number
  timeRemainingSeconds: number | null // null = untimed
  isDirty: boolean
  /** IDs of questions whose answers changed since last successful save. */
  dirtyQuestionIds: Set<string>
}

// ── Actions ──────────────────────────────────────────────────

export type QuizPlayerAction =
  | { type: 'SET_ANSWER'; payload: { questionId: string; answer: Partial<Answer> } }
  | { type: 'TOGGLE_FLAG'; payload: { questionId: string } }
  | { type: 'GO_TO_QUESTION'; payload: { index: number } }
  | { type: 'NEXT_QUESTION' }
  | { type: 'PREV_QUESTION' }
  | { type: 'TICK_TIMER'; payload?: { deadlineMs: number } }
  | { type: 'SUBMIT'; payload: { submittedAt: string } }
  | { type: 'MARK_SAVED' }

// ── Reducer ──────────────────────────────────────────────────

export function quizPlayerReducer(
  state: QuizPlayerState,
  action: QuizPlayerAction,
): QuizPlayerState {
  switch (action.type) {
    case 'SET_ANSWER': {
      const { questionId, answer } = action.payload
      const existing = state.attempt.answers[questionId] ?? {
        questionId,
        isFlagged: false,
        timeSpentSeconds: 0,
      }
      const nextDirty = new Set(state.dirtyQuestionIds)
      nextDirty.add(questionId)
      return {
        ...state,
        attempt: {
          ...state.attempt,
          answers: {
            ...state.attempt.answers,
            [questionId]: { ...existing, ...answer },
          },
        },
        isDirty: true,
        dirtyQuestionIds: nextDirty,
      }
    }

    case 'TOGGLE_FLAG': {
      const { questionId } = action.payload
      const existing = state.attempt.answers[questionId] ?? {
        questionId,
        isFlagged: false,
        timeSpentSeconds: 0,
      }
      const nextDirty = new Set(state.dirtyQuestionIds)
      nextDirty.add(questionId)
      return {
        ...state,
        attempt: {
          ...state.attempt,
          answers: {
            ...state.attempt.answers,
            [questionId]: { ...existing, isFlagged: !existing.isFlagged },
          },
        },
        isDirty: true,
        dirtyQuestionIds: nextDirty,
      }
    }

    case 'GO_TO_QUESTION': {
      const { index } = action.payload
      if (index < 0 || index >= state.questions.length) return state
      return { ...state, currentQuestionIndex: index }
    }

    case 'NEXT_QUESTION':
      if (state.currentQuestionIndex >= state.questions.length - 1) return state
      return { ...state, currentQuestionIndex: state.currentQuestionIndex + 1 }

    case 'PREV_QUESTION':
      if (state.currentQuestionIndex <= 0) return state
      return { ...state, currentQuestionIndex: state.currentQuestionIndex - 1 }

    case 'TICK_TIMER': {
      if (state.timeRemainingSeconds === null) return state
      // Recalculate from wall-clock deadline for accuracy (no drift)
      const next = action.payload?.deadlineMs
        ? Math.max(0, Math.floor((action.payload.deadlineMs - Date.now()) / 1000))
        : Math.max(0, state.timeRemainingSeconds - 1)
      return {
        ...state,
        timeRemainingSeconds: next,
        attempt: {
          ...state.attempt,
          timeSpentSeconds: state.attempt.timeSpentSeconds + 1,
        },
      }
    }

    case 'SUBMIT': {
      return {
        ...state,
        attempt: {
          ...state.attempt,
          status: 'submitted',
          submittedAt: action.payload.submittedAt,
        },
        isDirty: true,
      }
    }

    case 'MARK_SAVED':
      return { ...state, isDirty: false, dirtyQuestionIds: new Set<string>() }

    default:
      return state
  }
}
