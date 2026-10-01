// Post-quiz report modal for AI-generated live quizzes. Shows the
// professor a simple concept-level breakdown: which topics landed
// and which need revisiting. Accepts a pre-computed QuizReport
// (stored in the interaction payload for persistence).

'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { X, AlertTriangle, CheckCircle2, BarChart3, ChevronDown, UserX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import type {
  QuizReport,
  ConceptAnalysis,
  QuizQuestionSummary,
} from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
import { SPRING_SNAPPY } from '@/lib/motion'

interface QuizConceptAnalyticsProps {
  report: QuizReport
  onClose: () => void
}

export function QuizConceptAnalytics({ report, onClose }: QuizConceptAnalyticsProps) {
  const [showQuestions, setShowQuestions] = useState(false)
  const [showNonResponders, setShowNonResponders] = useState(false)

  const { overallAccuracy, concepts, questions, totalStudents } = report
  // nonResponders is absent on quizzes closed before #87 shipped — default to [].
  const nonResponders = report.nonResponders ?? []
  const totalAnswers = concepts.reduce((s, c) => s + c.totalCount, 0)
  const totalCorrect = concepts.reduce((s, c) => s + c.correctCount, 0)
  const needsRevisit = concepts.filter((c) => c.correctRate < 50)
  const solid = concepts.filter((c) => c.correctRate >= 50)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        showCloseButton={false}
        className="p-0 gap-0 max-h-[80vh] flex flex-col overflow-hidden rounded-3xl"
      >
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-5 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-muted/40 border border-border p-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold">Quiz Results</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                {totalStudents} {totalStudents === 1 ? 'student' : 'students'} responded
              </DialogDescription>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 hover:bg-muted transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-6">
            {/* Overall accuracy */}
            <div className="text-center pb-2">
              <span className="text-5xl font-semibold leading-none tabular-nums">
                {overallAccuracy}%
              </span>
              <p className="text-xs text-muted-foreground mt-1.5">
                class accuracy — {totalCorrect} of {totalAnswers} answers correct
              </p>
            </div>

            {/* Needs revisiting */}
            {needsRevisit.length > 0 && (
              <div className="space-y-2.5">
                <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
                  Consider revisiting
                </p>
                {needsRevisit.map((concept, i) => (
                  <ConceptRow key={concept.concept} concept={concept} index={i} highlight />
                ))}
              </div>
            )}

            {/* Understood */}
            {solid.length > 0 && (
              <div className="space-y-2.5">
                <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
                  {needsRevisit.length > 0 ? 'Well understood' : 'Concept breakdown'}
                </p>
                {solid.map((concept, i) => (
                  <ConceptRow key={concept.concept} concept={concept} index={i} />
                ))}
              </div>
            )}

            {/* Questions asked */}
            {questions.length > 0 && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowQuestions((s) => !s)}
                  className="flex items-center gap-1.5 text-xs uppercase tracking-widest font-semibold text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronDown className={`h-3 w-3 transition-transform ${showQuestions ? '' : '-rotate-90'}`} />
                  Questions ({questions.length})
                </button>
                {showQuestions && (
                  <div className="space-y-2">
                    {questions.map((q, idx) => (
                      <QuestionRow key={q.id} question={q} index={idx} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* #87 — enrolled students who didn't answer */}
            {nonResponders.length > 0 && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowNonResponders((s) => !s)}
                  className="flex items-center gap-1.5 text-xs uppercase tracking-widest font-semibold text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronDown className={`h-3 w-3 transition-transform ${showNonResponders ? '' : '-rotate-90'}`} />
                  <UserX className="h-3 w-3 shrink-0" aria-hidden />
                  Didn&apos;t answer ({nonResponders.length})
                </button>
                {showNonResponders && (
                  <div className="flex flex-wrap gap-1">
                    {nonResponders.map((s) => (
                      <span
                        key={s.id}
                        title={s.name}
                        className="inline-flex max-w-[16ch] items-center truncate rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {s.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {concepts.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8 italic">
                No responses yet
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <footer className="shrink-0 border-t border-border px-6 py-4">
          <Button onClick={onClose} className="w-full rounded-full h-11 font-semibold">
            Got it
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function describeAccuracy(correct: number, total: number): string {
  if (total === 0) return 'No responses yet'
  if (correct === 0) return 'No students got this right'
  if (correct === total) return total === 1 ? '1 student got this right' : `All ${total} got this right`
  return `${correct} of ${total} got this right`
}

function ConceptRow({
  concept,
  index,
  highlight = false,
}: {
  concept: ConceptAnalysis
  index: number
  highlight?: boolean
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ ...SPRING_SNAPPY, delay: index * 0.04 }}
      className={`flex items-center gap-3 rounded-2xl border p-3.5 ${
        highlight
          ? 'border-foreground/20 bg-foreground/3'
          : 'border-border bg-background'
      }`}
    >
      <div className="shrink-0">
        {highlight ? (
          <AlertTriangle className="h-4 w-4 text-foreground/50" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-foreground/30" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm leading-tight ${highlight ? 'font-semibold' : 'font-medium text-foreground/70'}`}>
          {concept.concept}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {describeAccuracy(concept.correctCount, concept.totalCount)}
        </p>
      </div>
    </motion.div>
  )
}

function QuestionRow({
  question,
  index,
}: {
  question: QuizQuestionSummary
  index: number
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <p className="text-xs leading-snug">
        <span className="text-muted-foreground font-semibold mr-1.5">{index + 1}.</span>
        {question.prompt}
      </p>
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        <span className="text-xs text-muted-foreground bg-muted/50 rounded-full px-2 py-0.5">
          {question.concept}
        </span>
        <span className="text-xs text-muted-foreground">
          {question.correctRate}% correct
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        Answer: {question.correctAnswer}
      </p>
    </div>
  )
}
