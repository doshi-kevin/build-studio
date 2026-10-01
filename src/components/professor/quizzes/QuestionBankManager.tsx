// QuestionBankManager — manages the professor's reusable question bank.
// Supports create, edit, delete, search, and filter of quiz questions for a section.

'use client'

import { useState, useEffect, useMemo, useCallback, useTransition } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { QuestionBankProvider, useQuestionBank } from '@/components/shared/quiz/quiz-context'
import { QuestionBankToolbar } from './QuestionBankToolbar'
import { QuestionList } from './QuestionList'
import { QuestionFormDialog } from './QuestionFormDialog'
import { blankPlaceholderText } from '@/lib/quiz/fill-in-blank'
import { DeleteQuestionDialog } from './DeleteQuestionDialog'
import {
  getQuestions,
  createQuestion,
  updateQuestion,
  deleteQuestion,
} from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'
import type { Question } from '@/lib/validations/quiz'

// ── Inner Component (uses context) ──────────────────────────

function QuestionBankInner({ sectionId }: { sectionId: string }) {
  const { state, dispatch } = useQuestionBank()
  const [formOpen, setFormOpen] = useState(false)
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null)
  const [deletingQuestion, setDeletingQuestion] = useState<Question | null>(null)
  const [, startTransition] = useTransition()

  // Collect all unique tags
  const allTags = useMemo(() => {
    const tagSet = new Set<string>()
    for (const q of Object.values(state.questions)) {
      for (const t of q.tags) tagSet.add(t)
    }
    return Array.from(tagSet).sort()
  }, [state.questions])

  const handleSaveQuestion = useCallback(
    (question: Question) => {
      const existing = state.questions[question.id]
      startTransition(async () => {
        if (existing) {
          // Update existing question
          const result = await updateQuestion(sectionId, question.id, {
            questionText: question.questionText,
            content: question.content,
            difficulty: question.difficulty,
            bloomsLevel: question.bloomsLevel,
            tags: question.tags,
            points: question.points,
            explanation: question.explanation,
            isBonus: question.isBonus,
            isExtraCredit: question.isExtraCredit,
            imageUrl: question.imageUrl,
            imagePath: question.imagePath ?? null,
            codeSnippet: question.codeSnippet ?? null,
            eloRating: question.eloRating ?? 1200,
            expectedTimeSeconds: question.expectedTimeSeconds ?? null,
          })
          if (result.error) {
            toast.error(result.error)
            return
          }
          if (result.data) {
            dispatch({ type: 'UPDATE_QUESTION', payload: { questionId: result.data.id, changes: result.data } })
            toast.success('Question updated')
          }
        } else {
          // Create new question
          const result = await createQuestion(sectionId, {
            questionText: question.questionText,
            content: question.content,
            difficulty: question.difficulty,
            bloomsLevel: question.bloomsLevel,
            tags: question.tags,
            points: question.points,
            explanation: question.explanation,
            isBonus: question.isBonus,
            isExtraCredit: question.isExtraCredit,
            imageUrl: question.imageUrl,
            imagePath: question.imagePath ?? null,
            codeSnippet: question.codeSnippet ?? null,
            eloRating: question.eloRating ?? 1200,
            expectedTimeSeconds: question.expectedTimeSeconds ?? null,
            irtA: question.irtA ?? null,
            irtB: question.irtB ?? null,
            irtC: question.irtC ?? null,
            rubric: question.rubric ?? null,
          })
          if (result.error) {
            toast.error(result.error)
            return
          }
          if (result.data) {
            dispatch({ type: 'ADD_QUESTION', payload: { question: result.data } })
            toast.success('Question created')
          }
        }
      })
    },
    [state.questions, dispatch, sectionId],
  )

  const handleDeleteQuestion = useCallback(() => {
    if (!deletingQuestion) return
    startTransition(async () => {
      const result = await deleteQuestion(sectionId, deletingQuestion.id)
      if (result.error) {
        toast.error(result.error)
        return
      }
      dispatch({ type: 'REMOVE_QUESTION', payload: { questionId: deletingQuestion.id } })
      toast.success('Question deleted')
      setDeletingQuestion(null)
    })
  }, [deletingQuestion, sectionId, dispatch])

  const handleEdit = useCallback((question: Question) => {
    setEditingQuestion(question)
    setFormOpen(true)
  }, [])

  const handleCreate = useCallback(() => {
    setEditingQuestion(null)
    setFormOpen(true)
  }, [])

  return (
    <div className="space-y-4">
      <QuestionBankToolbar
        searchQuery={state.searchQuery}
        onSearchChange={(query) => dispatch({ type: 'SET_SEARCH', payload: { query } })}
        filterType={state.filterType}
        onFilterTypeChange={(type) => dispatch({ type: 'SET_FILTER_TYPE', payload: { type } })}
        filterDifficulty={state.filterDifficulty}
        onFilterDifficultyChange={(difficulty) =>
          dispatch({ type: 'SET_FILTER_DIFFICULTY', payload: { difficulty } })
        }
        allTags={allTags}
        filterTag={state.filterTag}
        onFilterTagChange={(tag) => dispatch({ type: 'SET_FILTER_TAG', payload: { tag } })}
        onCreateQuestion={handleCreate}
      />

      <QuestionList onEdit={handleEdit} onDelete={setDeletingQuestion} />

      <QuestionFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        question={editingQuestion}
        sectionId={sectionId}
        onSave={handleSaveQuestion}
      />

      <DeleteQuestionDialog
        open={!!deletingQuestion}
        onOpenChange={(open) => { if (!open) setDeletingQuestion(null) }}
        questionTitle={blankPlaceholderText(deletingQuestion?.questionText ?? '').slice(0, 80)}
        onConfirm={handleDeleteQuestion}
      />
    </div>
  )
}

// ── Outer Component (provides context) ──────────────────────

interface QuestionBankManagerProps {
  sectionId: string
}

export function QuestionBankManager({ sectionId }: QuestionBankManagerProps) {
  const [initialQuestions, setInitialQuestions] = useState<Question[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    async function load() {
      const result = await getQuestions(sectionId)
      if (result.error) {
        toast.error(result.error)
      }
      setInitialQuestions(result.data || [])
      setLoaded(true)
    }
    load()
  }, [sectionId])

  if (!loaded) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <QuestionBankProvider initialQuestions={initialQuestions}>
      <QuestionBankInner sectionId={sectionId} />
    </QuestionBankProvider>
  )
}
