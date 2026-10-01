/**
 * StudentRubricBreakdown — read-only view of how a graded submission scored against the rubric,
 * so the student can see exactly where they earned and lost points. Mirrors the professor's
 * RubricGrader visual, but nothing is clickable and no answer key is ever shown.
 *
 * Each subquestion also carries a "Request regrade" control (files a regrade targeting that one
 * question) and, read-only, any replies the professor left on that question. Shown in a popup off
 * the grade block, only once the professor has published grades.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SubquestionCommentThread } from '@/components/assignments/SubquestionCommentThread'
import type { AssignmentRubric, SubmissionCommentRow } from '@/lib/validations/assignment'

interface Props {
  rubric: AssignmentRubric
  /** Ticked criterion keys ("<qIdx>:<cIdx>") the student earned. */
  rubricScores: string[]
  totalScore: number
  points: number
  /** Per-subquestion comments (read-only for the student — staff replies show here). */
  comments?: SubmissionCommentRow[]
  /** Inline instructor comments keyed by question index (stringified). Gated by gradesPublished. */
  rubricComments?: Record<string, string> | null
  /** Rubric indexes already covered by an open regrade request (control → "Regrade requested"). */
  requestedIndexes?: number[]
  /** Files a regrade for one subquestion. When omitted, the per-question control is hidden. */
  onRequestRegrade?: (questionIndex: number, reason: string) => Promise<{ error?: string }>
}

export function StudentRubricBreakdown({
  rubric,
  rubricScores,
  totalScore,
  points,
  comments = [],
  rubricComments,
  requestedIndexes = [],
  onRequestRegrade,
}: Props) {
  const earned = new Set(rubricScores)
  const requested = new Set(requestedIndexes)
  const threadsByQuestion = new Map<number, SubmissionCommentRow[]>()
  for (const c of comments) {
    const list = threadsByQuestion.get(c.question_index) ?? []
    list.push(c)
    threadsByQuestion.set(c.question_index, list)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Score
        </p>
        <p className="text-sm font-semibold tabular-nums text-foreground">
          {totalScore} / {points}
        </p>
      </div>

      {/* Bounded, self-scrolling block so a long rubric never balloons the dialog. Inline
          maxHeight guarantees the cap even if a JIT/arbitrary class doesn't recompile. */}
      <div className="space-y-3 overflow-y-auto pr-1" style={{ maxHeight: '60vh' }}>
        {rubric.questions.map((q, qi) => {
          const qEarned = q.criteria.reduce(
            (sum, c, ci) => (earned.has(`${qi}:${ci}`) ? sum + c.points : sum),
            0,
          )
          const thread = threadsByQuestion.get(qi) ?? []
          return (
            <div key={qi} className="rounded-xl border border-border p-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-foreground">{q.label || `Question ${qi + 1}`}</p>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {qEarned} / {q.points} pts
                </span>
              </div>
              <ul className="mt-2 space-y-1">
                {q.criteria.map((c, ci) => {
                  const on = earned.has(`${qi}:${ci}`)
                  return (
                    <li
                      key={ci}
                      className={cn(
                        'flex items-start gap-2 rounded-xl p-2 text-xs',
                        on ? 'bg-primary/5' : 'bg-muted/40',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                          on ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground/20 text-muted-foreground',
                        )}
                      >
                        {on ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      </span>
                      <span className={cn('flex-1', on ? 'text-foreground' : 'text-muted-foreground')}>
                        {c.description}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 tabular-nums',
                          on ? 'font-semibold text-primary' : 'text-muted-foreground line-through',
                        )}
                      >
                        {c.points >= 0 ? `+${c.points}` : c.points}
                      </span>
                    </li>
                  )
                })}
              </ul>

              {/* Inline instructor comment saved with the grade — XSS-safe (text only). */}
              {rubricComments?.[String(qi)]?.trim() && (
                <div className="mt-2 rounded-xl border border-border bg-muted/40 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Instructor comment
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                    {rubricComments[String(qi)]}
                  </p>
                </div>
              )}

              {/* Legacy per-question comment threads — read-only for the student. */}
              {thread.length > 0 && (
                <SubquestionCommentThread comments={thread} canComment={false} onPost={async () => ({ success: true })} />
              )}

              {/* Per-question regrade request. */}
              {onRequestRegrade &&
                (requested.has(qi) ? (
                  <p className="mt-2 text-xs font-medium text-muted-foreground">Regrade requested</p>
                ) : (
                  <RegradeQuestionControl questionIndex={qi} onSubmit={onRequestRegrade} />
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Inline "Request regrade" affordance for one subquestion: a button that reveals a reason box. */
function RegradeQuestionControl({
  questionIndex,
  onSubmit,
}: {
  questionIndex: number
  onSubmit: (questionIndex: number, reason: string) => Promise<{ error?: string }>
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [isPending, startTransition] = useTransition()

  function submit() {
    const trimmed = reason.trim()
    if (!trimmed) return
    startTransition(async () => {
      const result = await onSubmit(questionIndex, trimmed)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Regrade requested')
      setOpen(false)
      setReason('')
      router.refresh()
    })
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-xs font-medium text-primary hover:underline"
      >
        Request regrade
      </button>
    )
  }

  return (
    <div className="mt-2 space-y-2">
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={5000}
        placeholder="Why should this question be re-checked?"
        className="text-sm"
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false)
            setReason('')
          }}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={isPending || reason.trim().length === 0}>
          Request regrade
        </Button>
      </div>
    </div>
  )
}
