'use client'

import { useMemo } from 'react'
import { ClipboardCheck } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { QuestionCard } from './QuestionCard'
import { useQuestionBank } from '@/components/shared/quiz/quiz-context'
import type { Question } from '@/lib/validations/quiz'

interface QuestionListProps {
  onEdit: (question: Question) => void
  onDelete: (question: Question) => void
}

export function QuestionList({ onEdit, onDelete }: QuestionListProps) {
  const { state } = useQuestionBank()
  const { questions, searchQuery, filterType, filterDifficulty, filterTag } = state

  const filteredQuestions = useMemo(() => {
    let list = Object.values(questions)

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (question) =>
          question.questionText.toLowerCase().includes(q) ||
          question.tags.some((t) => t.toLowerCase().includes(q)),
      )
    }

    if (filterType) {
      list = list.filter((question) => question.content.questionType === filterType)
    }

    if (filterDifficulty) {
      list = list.filter((question) => question.difficulty === filterDifficulty)
    }

    if (filterTag) {
      list = list.filter((question) =>
        question.tags.some((t) => t.toLowerCase() === filterTag.toLowerCase()),
      )
    }

    // Sort by most recently updated
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    return list
  }, [questions, searchQuery, filterType, filterDifficulty, filterTag])

  if (Object.keys(questions).length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="No questions yet"
        description="Create your first question to start building quizzes."
      />
    )
  }

  if (filteredQuestions.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-muted-foreground">
          No questions match your filters. Try adjusting your search.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        {filteredQuestions.length} question{filteredQuestions.length !== 1 ? 's' : ''}
      </p>
      <AnimatedList className="grid gap-3">
        {filteredQuestions.map((question) => (
          <AnimatedItem key={question.id}>
            <QuestionCard
              question={question}
              onEdit={() => onEdit(question)}
              onDelete={() => onDelete(question)}
            />
          </AnimatedItem>
        ))}
      </AnimatedList>
    </div>
  )
}
