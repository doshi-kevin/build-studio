// After-class "Past quizzes" section for the professor's Live Classroom
// landing page. Lists every closed quiz in the section; clicking one opens
// its stored results report (QuizConceptAnalytics), falling back to a
// question/answer-key view for quizzes closed without a report.

'use client'

import { useState } from 'react'
import { History } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { QuizHistoryList, type QuizHistoryListItem } from '@/components/live-classroom/shared/QuizHistoryList'
import { QuizReview } from '@/components/live-classroom/shared/QuizReview'
import { QuizConceptAnalytics } from './QuizConceptAnalytics'
import type { QuizHistoryEntry } from '@/lib/live-classroom/history/actions'

export function ProfessorQuizHistory({ entries }: { entries: QuizHistoryEntry[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (entries.length === 0) return null

  const selected = entries.find((e) => e.interactionId === selectedId) ?? null

  const items: QuizHistoryListItem[] = entries.map((e) => ({
    id: e.interactionId,
    title: e.title,
    closedAt: e.closedAt,
    rightLabel: e.report ? `${e.report.overallAccuracy}%` : undefined,
    rightTone: e.report
      ? e.report.overallAccuracy >= 80
        ? 'good'
        : e.report.overallAccuracy >= 50
          ? 'neutral'
          : 'bad'
      : undefined,
  }))

  return (
    <div className="mt-10">
      <p className="flex items-center gap-1.5 mb-4 text-xs uppercase tracking-widest font-semibold text-muted-foreground">
        <History className="h-3.5 w-3.5" aria-hidden />
        Past quizzes
      </p>
      <QuizHistoryList items={items} onSelect={setSelectedId} />

      {/* Prefer the stored class report; fall back to an answer-key view. */}
      {selected?.report && (
        <QuizConceptAnalytics report={selected.report} onClose={() => setSelectedId(null)} />
      )}
      <Dialog
        open={selected !== null && !selected.report}
        onOpenChange={(open) => !open && setSelectedId(null)}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto rounded-3xl">
          {selected && !selected.report && (
            <>
              <DialogHeader>
                <DialogTitle className="text-base">{selected.title}</DialogTitle>
                <DialogDescription>
                  No saved results report for this quiz — showing the questions and correct answers.
                </DialogDescription>
              </DialogHeader>
              <QuizReview
                payload={{ title: selected.title, questions: selected.questions }}
                studentAnswers={null}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
