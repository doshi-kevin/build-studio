/**
 * StudentGradePanel — grade block shown in the sticky rail once grades are released.
 *
 * Contains the score, feedback, rubric breakdown dialog, open/resolved regrade cards,
 * and the whole-submission regrade dialog. Moved verbatim from StudentAssignmentWorkspace's
 * graded branch so the detail page can render it in the right-column rail.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ListChecks, MessageSquarePlus } from 'lucide-react'
import { StudentRubricBreakdown } from './StudentRubricBreakdown'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  type AssignmentRubric,
  type RegradeRequestRow,
  type SubmissionCommentRow,
} from '@/lib/validations/assignment'
import {
  requestRegrade,
  withdrawRegradeRequest,
} from '@/app/(dashboard)/student/courses/[sectionId]/assignments/actions'
import { RubricLossChart } from './RubricLossChart'

export interface StudentGradePanelProps {
  sectionId: string
  assignmentId: string
  points: number
  score: number | null
  feedback: string
  rubric: AssignmentRubric | null
  rubricScores: string[]
  regradeRequests: RegradeRequestRow[]
  comments: SubmissionCommentRow[]
  /** Inline instructor comments per question index, saved at grading time. */
  rubricComments?: Record<string, string> | null
}

export function StudentGradePanel({
  sectionId,
  assignmentId,
  points,
  score,
  feedback,
  rubric,
  rubricScores,
  regradeRequests,
  comments,
  rubricComments,
}: StudentGradePanelProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [rubricOpen, setRubricOpen] = useState(false)
  const [regradeOpen, setRegradeOpen] = useState(false)
  const [reason, setReason] = useState('')

  const openRequest = regradeRequests.find((r) => r.status === 'open') ?? null
  const lastResolved = regradeRequests.find((r) => r.status === 'resolved') ?? null
  const hasRubric = !!rubric && rubric.questions.length > 0

  function submitRegrade() {
    const trimmed = reason.trim()
    if (!trimmed) {
      toast.error('Add a reason for your regrade request.')
      return
    }
    startTransition(async () => {
      const result = await requestRegrade(sectionId, assignmentId, {
        questionIndexes: [],
        reason: trimmed,
      })
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success('Regrade requested')
      setRegradeOpen(false)
      setReason('')
      router.refresh()
    })
  }

  function withdraw() {
    if (!openRequest) return
    startTransition(async () => {
      const result = await withdrawRegradeRequest(sectionId, openRequest.id)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success('Request withdrawn')
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {/* Grade block */}
      <div className="rounded-2xl border border-primary/20 bg-primary/5 p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Graded</p>
        {score !== null && points > 0 ? (
          <div className="mt-2">
            <RubricLossChart rubric={rubric} rubricScores={rubricScores} score={score} points={points} />
          </div>
        ) : (
          <p className="mt-1 text-3xl font-bold tabular-nums text-foreground">
            {score ?? '—'}
            <span className="text-lg font-medium text-muted-foreground"> / {points}</span>
          </p>
        )}
        {feedback && (
          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Feedback
            </p>
            <p className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap text-sm text-foreground">{feedback}</p>
          </div>
        )}
        {hasRubric && (
          <Button
            variant="outline"
            size="sm"
            className="mt-4 w-full"
            onClick={() => setRubricOpen(true)}
          >
            <ListChecks className="h-4 w-4" />
            View rubric breakdown
          </Button>
        )}
      </div>

      {/* Open regrade card */}
      {openRequest && (
        <div className="rounded-2xl border border-border bg-muted/40 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Regrade requested</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {openRequest.questions.length > 0
                  ? `Questions: ${openRequest.questions.map((q) => q.label).join(', ')}`
                  : 'Whole submission'}
              </p>
              <p className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap text-sm text-foreground">{openRequest.reason}</p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="shrink-0" disabled={isPending}>
                  Withdraw
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Withdraw this regrade request?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Your instructor will no longer see this request. You can send a new one later.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isPending}>Keep it</AlertDialogCancel>
                  <AlertDialogAction onClick={withdraw} disabled={isPending}>
                    Withdraw
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}

      {/* Resolved regrade card */}
      {!openRequest && lastResolved && (
        <div className="rounded-2xl border border-border bg-muted/40 p-4">
          <p className="text-sm font-medium text-foreground">Regrade reviewed</p>
          {lastResolved.resolution_note && (
            <p className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap text-sm text-foreground">
              {lastResolved.resolution_note}
            </p>
          )}
          {lastResolved.new_score != null &&
            lastResolved.old_score != null &&
            lastResolved.new_score !== lastResolved.old_score && (
              <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                Score updated: {lastResolved.old_score} to {lastResolved.new_score}
              </p>
            )}
        </div>
      )}

      {/* Whole-submission regrade button (rubric-less assignments only) */}
      {!hasRubric && !openRequest && (
        <Button variant="outline" size="sm" onClick={() => setRegradeOpen(true)}>
          <MessageSquarePlus className="h-4 w-4" />
          Request a regrade
        </Button>
      )}

      {/* Rubric breakdown dialog */}
      {hasRubric && (
        <Dialog open={rubricOpen} onOpenChange={setRubricOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Rubric breakdown</DialogTitle>
            </DialogHeader>
            <StudentRubricBreakdown
              rubric={rubric!}
              rubricScores={rubricScores}
              totalScore={score ?? 0}
              points={points}
              comments={comments}
              rubricComments={rubricComments}
              requestedIndexes={openRequest?.questions.map((q) => q.index) ?? []}
              onRequestRegrade={async (questionIndex, regradeReason) => {
                const r = await requestRegrade(sectionId, assignmentId, {
                  questionIndexes: [questionIndex],
                  reason: regradeReason,
                })
                return 'error' in r ? { error: r.error } : {}
              }}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Whole-submission regrade dialog */}
      <Dialog open={regradeOpen} onOpenChange={setRegradeOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Request a regrade</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Describe what you would like your instructor to re-check.
            </p>
            <div className="space-y-2">
              <Label htmlFor="regrade-reason">Reason</Label>
              <Textarea
                id="regrade-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                maxLength={5000}
                placeholder="Explain why you think this should be re-checked..."
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRegradeOpen(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button onClick={submitRegrade} disabled={isPending}>
                Send request
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
