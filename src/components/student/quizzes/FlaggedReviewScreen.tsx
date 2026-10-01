'use client'

import { Bookmark, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { blankPlaceholderText } from '@/lib/quiz/fill-in-blank'
import type { Question, Answer } from '@/lib/validations/quiz'

// FIB stems carry {{blank:id}} tokens — collapse them to "_____" in list rows.
function stemPreview(question: Question): string {
  return question.content.questionType === 'fill_in_blank'
    ? blankPlaceholderText(question.questionText)
    : question.questionText
}

interface FlaggedReviewScreenProps {
  questions: Question[]
  answers: Record<string, Answer>
  onGoToQuestion: (index: number) => void
  onBack: () => void
  onSubmit: () => void
}

export function FlaggedReviewScreen({
  questions,
  answers,
  onGoToQuestion,
  onBack,
  onSubmit,
}: FlaggedReviewScreenProps) {
  const flaggedQuestions = questions
    .map((q, index) => ({ question: q, index, answer: answers[q.id] }))
    .filter(({ answer }) => answer?.isFlagged)

  const unansweredQuestions = questions
    .map((q, index) => ({ question: q, index, answer: answers[q.id] }))
    .filter(({ answer }) => {
      if (!answer) return true
      const hasAnswer =
        (answer.selectedChoiceIds && answer.selectedChoiceIds.length > 0) ||
        answer.booleanAnswer !== undefined ||
        (answer.textAnswer && answer.textAnswer.trim()) ||
        (answer.blankAnswers && Object.values(answer.blankAnswers).some((v) => v.trim()))
      return !hasAnswer
    })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Review Before Submitting</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Review your bookmarked and unanswered questions before final submission.
        </p>
      </div>

      {flaggedQuestions.length > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Bookmark className="h-4 w-4 text-warning-muted-foreground" />
            <h3 className="text-sm font-semibold">Bookmarked Questions ({flaggedQuestions.length})</h3>
          </div>
          <div className="space-y-2">
            {flaggedQuestions.map(({ question, index }) => (
              <button
                key={question.id}
                onClick={() => onGoToQuestion(index)}
                className="flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-muted/50 transition-colors"
              >
                <span className="text-xs text-muted-foreground w-6">#{index + 1}</span>
                <MarkdownLatex content={stemPreview(question)} variant="compact" className="text-sm flex-1 line-clamp-1" />
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            ))}
          </div>
        </Card>
      )}

      {unansweredQuestions.length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3">
            Unanswered Questions ({unansweredQuestions.length})
          </h3>
          <div className="space-y-2">
            {unansweredQuestions.map(({ question, index }) => (
              <button
                key={question.id}
                onClick={() => onGoToQuestion(index)}
                className="flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-muted/50 transition-colors"
              >
                <span className="text-xs text-muted-foreground w-6">#{index + 1}</span>
                <MarkdownLatex content={stemPreview(question)} variant="compact" className="text-sm flex-1 line-clamp-1" />
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            ))}
          </div>
        </Card>
      )}

      {flaggedQuestions.length === 0 && unansweredQuestions.length === 0 && (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted-foreground">
            All questions have been answered and none are bookmarked. You&apos;re ready to submit!
          </p>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Back to Quiz
        </Button>
        <Button onClick={onSubmit}>
          Submit Quiz
        </Button>
      </div>
    </div>
  )
}
