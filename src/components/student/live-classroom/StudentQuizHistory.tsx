// After-class "Past quizzes" section for the student's Live Classroom landing
// page. Thin client island over StudentQuizReviewList — maps the server
// history entries into review items. Renders nothing when there's no history.

'use client'

import { History } from 'lucide-react'
import { StudentQuizReviewList, type StudentQuizReviewItem } from './StudentQuizReviewList'
import type { QuizHistoryEntry } from '@/lib/live-classroom/history/actions'

export function StudentQuizHistory({ entries }: { entries: QuizHistoryEntry[] }) {
  if (entries.length === 0) return null

  const quizzes: StudentQuizReviewItem[] = entries.map((e) => ({
    id: e.interactionId,
    title: e.title,
    closedAt: e.closedAt,
    payload: { title: e.title, questions: e.questions },
    answers: e.myAnswers,
  }))

  return (
    <div className="mt-10">
      <p className="flex items-center gap-1.5 mb-4 text-xs uppercase tracking-widest font-semibold text-muted-foreground">
        <History className="h-3.5 w-3.5" aria-hidden />
        Past quizzes
      </p>
      <StudentQuizReviewList quizzes={quizzes} />
    </div>
  )
}
