// A student's past-quiz list + review dialog. Given closed quizzes the student
// answered (their questions + their picks), shows the score-tagged list and,
// on click, the full per-question review. Reused for both the in-session
// reveal (Live tab) and the after-class history (landing page).

'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { QuizHistoryList, type QuizHistoryListItem } from '@/components/live-classroom/shared/QuizHistoryList'
import { QuizReview } from '@/components/live-classroom/shared/QuizReview'
import { buildQuizReview, type QuizReviewPayload } from '@/lib/live-classroom/quiz-review'

export interface StudentQuizReviewItem {
  id: string
  title: string
  closedAt: string | null
  payload: QuizReviewPayload
  answers: Record<string, string> | null
}

interface Props {
  quizzes: StudentQuizReviewItem[]
}

export function StudentQuizReviewList({ quizzes }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = quizzes.find((q) => q.id === selectedId) ?? null

  const items: QuizHistoryListItem[] = quizzes.map((qz) => {
    const { scorePct } = buildQuizReview(qz.payload, qz.answers)
    return {
      id: qz.id,
      title: qz.title,
      closedAt: qz.closedAt,
      rightLabel: `${scorePct}%`,
      rightTone: scorePct >= 80 ? 'good' : scorePct >= 50 ? 'neutral' : 'bad',
    }
  })

  return (
    <>
      <QuizHistoryList items={items} onSelect={setSelectedId} />

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto rounded-3xl">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="text-base">{selected.title}</DialogTitle>
                <DialogDescription>Your answers and the correct ones, with explanations.</DialogDescription>
              </DialogHeader>
              <QuizReview payload={selected.payload} studentAnswers={selected.answers} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
