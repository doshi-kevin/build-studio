/**
 * Question Bank reducer — manages professor's question bank state.
 * Follows the exact same pattern as use-roadmap-reducer.ts.
 */

import type { Question, QuestionType, DifficultyLevel } from '@/lib/validations/quiz'

// ── State ────────────────────────────────────────────────────

export interface QuestionBankState {
  questions: Record<string, Question>
  selectedQuestionId: string | null
  filterTag: string | null
  filterDifficulty: DifficultyLevel | null
  filterType: QuestionType | null
  searchQuery: string
  isDirty: boolean
}

// ── Actions ──────────────────────────────────────────────────

export type QuestionBankAction =
  | { type: 'ADD_QUESTION'; payload: { question: Question } }
  | { type: 'UPDATE_QUESTION'; payload: { questionId: string; changes: Partial<Question> } }
  | { type: 'REMOVE_QUESTION'; payload: { questionId: string } }
  | { type: 'SELECT_QUESTION'; payload: { questionId: string | null } }
  | { type: 'SET_FILTER_TAG'; payload: { tag: string | null } }
  | { type: 'SET_FILTER_DIFFICULTY'; payload: { difficulty: DifficultyLevel | null } }
  | { type: 'SET_FILTER_TYPE'; payload: { type: QuestionType | null } }
  | { type: 'SET_SEARCH'; payload: { query: string } }
  | { type: 'SET_QUESTIONS'; payload: { questions: Record<string, Question> } }
  | { type: 'MARK_SAVED' }

// ── Reducer ──────────────────────────────────────────────────

export function questionBankReducer(
  state: QuestionBankState,
  action: QuestionBankAction,
): QuestionBankState {
  switch (action.type) {
    case 'ADD_QUESTION': {
      const { question } = action.payload
      return {
        ...state,
        questions: { ...state.questions, [question.id]: question },
        isDirty: true,
      }
    }

    case 'UPDATE_QUESTION': {
      const { questionId, changes } = action.payload
      const existing = state.questions[questionId]
      if (!existing) return state
      return {
        ...state,
        questions: {
          ...state.questions,
          [questionId]: { ...existing, ...changes },
        },
        isDirty: true,
      }
    }

    case 'REMOVE_QUESTION': {
      const { questionId } = action.payload
      const rest = Object.fromEntries(
        Object.entries(state.questions).filter(([key]) => key !== questionId)
      )
      return {
        ...state,
        questions: rest as Record<string, Question>,
        selectedQuestionId:
          state.selectedQuestionId === questionId ? null : state.selectedQuestionId,
        isDirty: true,
      }
    }

    case 'SELECT_QUESTION':
      return { ...state, selectedQuestionId: action.payload.questionId }

    case 'SET_FILTER_TAG':
      return { ...state, filterTag: action.payload.tag }

    case 'SET_FILTER_DIFFICULTY':
      return { ...state, filterDifficulty: action.payload.difficulty }

    case 'SET_FILTER_TYPE':
      return { ...state, filterType: action.payload.type }

    case 'SET_SEARCH':
      return { ...state, searchQuery: action.payload.query }

    case 'SET_QUESTIONS':
      return { ...state, questions: action.payload.questions }

    case 'MARK_SAVED':
      return { ...state, isDirty: false }

    default:
      return state
  }
}
