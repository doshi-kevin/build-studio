'use client'

import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react'
import type { Question } from '@/lib/validations/quiz'
import {
  questionBankReducer,
  type QuestionBankState,
  type QuestionBankAction,
} from './use-quiz-reducer'

// ── Context Value ────────────────────────────────────────────

interface QuestionBankContextValue {
  state: QuestionBankState
  dispatch: React.Dispatch<QuestionBankAction>
}

const QuestionBankContext = createContext<QuestionBankContextValue | null>(null)

// ── Hook ─────────────────────────────────────────────────────

export function useQuestionBank() {
  const ctx = useContext(QuestionBankContext)
  if (!ctx) throw new Error('useQuestionBank must be used within QuestionBankProvider')
  return ctx
}

// ── Provider ─────────────────────────────────────────────────

interface QuestionBankProviderProps {
  initialQuestions: Question[]
  children: ReactNode
}

export function QuestionBankProvider({
  initialQuestions,
  children,
}: QuestionBankProviderProps) {
  const questionsMap: Record<string, Question> = {}
  for (const q of initialQuestions) {
    questionsMap[q.id] = q
  }

  const [state, dispatch] = useReducer(questionBankReducer, {
    questions: questionsMap,
    selectedQuestionId: null,
    filterTag: null,
    filterDifficulty: null,
    filterType: null,
    searchQuery: '',
    isDirty: false,
  })

  const value = useMemo(() => ({ state, dispatch }), [state])

  return (
    <QuestionBankContext.Provider value={value}>
      {children}
    </QuestionBankContext.Provider>
  )
}
