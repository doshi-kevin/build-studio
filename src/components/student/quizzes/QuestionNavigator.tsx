// Question navigator sidebar — grid of numbered buttons showing question status.
// Shows a subtle cloud-check icon on the current question after auto-save.
'use client'

import { useState, useEffect } from 'react'
import { CircleCheck, CloudOff } from 'lucide-react'
import type { Answer, QuizItemType } from '@/lib/validations/quiz'

const TYPE_ABBREV: Record<QuizItemType, string> = {
  multiple_choice: 'MC',
  true_false: 'TF',
  short_answer: 'SA',
  fill_in_blank: 'FB',
  explanation: 'EX',
  walkthrough: 'WK',
}

interface QuestionNavigatorProps {
  totalQuestions: number
  currentIndex: number
  answers: Record<string, Answer>
  questionIds: string[]
  /** Question types in order, for showing type abbreviations */
  questionTypes?: QuizItemType[]
  onGoTo: (index: number) => void
  /** Timestamp (ms) of the last successful auto-save. 0 if never saved. */
  lastSavedAt?: number
  /** True if the most recent auto-save failed. */
  saveFailed?: boolean
}

function getQuestionStatus(
  questionId: string,
  answers: Record<string, Answer>,
): 'current' | 'answered' | 'flagged' | 'unanswered' {
  const answer = answers[questionId]
  if (!answer) return 'unanswered'
  if (answer.isFlagged) return 'flagged'
  // Check if actually answered
  const hasAnswer =
    (answer.selectedChoiceIds && answer.selectedChoiceIds.length > 0) ||
    answer.booleanAnswer !== undefined ||
    (answer.textAnswer && answer.textAnswer.trim()) ||
    (answer.blankAnswers && Object.values(answer.blankAnswers).some((v) => v.trim()))
  return hasAnswer ? 'answered' : 'unanswered'
}

const STATUS_STYLES: Record<string, string> = {
  current: 'bg-primary text-primary-foreground ring-2 ring-primary/30',
  answered: 'bg-success-muted text-success-muted-foreground border-success/30',
  flagged: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  unanswered: 'bg-muted text-muted-foreground border-border',
}

export function QuestionNavigator({
  totalQuestions,
  currentIndex,
  answers,
  questionIds,
  questionTypes,
  onGoTo,
  lastSavedAt = 0,
  saveFailed = false,
}: QuestionNavigatorProps) {
  // Show save icon briefly (2s) after each auto-save
  const [showSaved, setShowSaved] = useState(false)

  useEffect(() => {
    if (lastSavedAt === 0) return
    setShowSaved(true) // eslint-disable-line react-hooks/set-state-in-effect
    const timer = setTimeout(() => setShowSaved(false), 2000)
    return () => clearTimeout(timer)
  }, [lastSavedAt])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <p className="text-xs text-muted-foreground font-medium">Questions</p>
        {saveFailed ? (
          <span className="flex items-center gap-1 text-destructive" title="Auto-save failed — your answers may not be saved">
            <CloudOff className="h-3 w-3" />
            <span className="text-[10px] font-medium">Save failed</span>
          </span>
        ) : showSaved ? (
          <CircleCheck className="h-3 w-3 text-success-muted-foreground animate-in fade-in duration-200" />
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: totalQuestions }, (_, i) => {
          const questionId = questionIds[i]
          const status = i === currentIndex ? 'current' : getQuestionStatus(questionId, answers)
          return (
            <button
              key={i}
              onClick={() => onGoTo(i)}
              aria-label={`Question ${i + 1}, ${status}`}
              className={`flex h-8 w-8 flex-col items-center justify-center rounded-xl border text-xs font-medium leading-none tabular-nums transition-colors ${STATUS_STYLES[status]}`}
              title={`Q${i + 1}: ${status}${questionTypes?.[i] ? ` (${TYPE_ABBREV[questionTypes[i]]})` : ''}`}
            >
              <span>{i + 1}</span>
              {questionTypes?.[i] && (
                <span className="text-[7px] opacity-60 -mt-0.5">{TYPE_ABBREV[questionTypes[i]]}</span>
              )}
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded-full border border-success/30 bg-success-muted" />
          Answered
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded-full border border-warning/30 bg-warning-muted" />
          Bookmarked
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded-full border border-border bg-muted" />
          Unanswered
        </span>
      </div>
    </div>
  )
}
