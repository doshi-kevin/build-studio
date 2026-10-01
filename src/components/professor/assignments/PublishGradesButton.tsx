/**
 * PublishGradesButton — releases graded-but-unpublished submissions to students.
 *
 * Grading is private until the professor publishes: this is the single control that reveals
 * scores, feedback, and the rubric breakdown to students for an assignment.
 *
 * It used to publish on one unguarded click, with no mention of who was still ungraded and
 * no way back — so a misclick, the wrong assignment, or a half-finished pile released real
 * grades permanently. Now it confirms first (naming the students who would be left out) and
 * offers a withdraw afterwards.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckCircle2, Send, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  publishGrades,
  unpublishGrades,
} from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'

interface Props {
  sectionId: string
  assignmentId: string
  /** Graded submissions not yet visible to students. */
  unreleased: number
  /** Graded submissions already visible to students. */
  released: number
  /** Students with no grade yet — they'd be left out of this publish. */
  ungraded?: number
}

export function PublishGradesButton({
  sectionId,
  assignmentId,
  unreleased,
  released,
  ungraded = 0,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)

  // Nothing graded yet — nothing to publish.
  if (unreleased === 0 && released === 0) return null

  function publish() {
    startTransition(async () => {
      const result = await publishGrades(sectionId, assignmentId)
      if ('error' in result) toast.error(result.error)
      else {
        toast.success(
          result.released > 0
            ? `Published ${result.released} grade${result.released === 1 ? '' : 's'}`
            : 'No new grades to publish',
        )
        setConfirmPublish(false)
        router.refresh()
      }
    })
  }

  function withdraw() {
    startTransition(async () => {
      const result = await unpublishGrades(sectionId, assignmentId)
      if ('error' in result) toast.error(result.error)
      else {
        toast.success('Grades hidden from students')
        setConfirmWithdraw(false)
        router.refresh()
      }
    })
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
      <div className="min-w-0">
        {unreleased > 0 ? (
          <>
            <p className="text-sm font-medium text-foreground">
              {unreleased} grade{unreleased === 1 ? '' : 's'} ready to publish
            </p>
            <p className="text-xs text-muted-foreground">
              Students can&apos;t see their score, feedback, or rubric until you publish.
            </p>
          </>
        ) : (
          <p className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            All grades published
          </p>
        )}
      </div>

      {unreleased > 0 ? (
        <Button size="sm" onClick={() => setConfirmPublish(true)} loading={isPending}>
          {/* The leading icon steps aside for the spinner rather than sitting
              beside it — two glyphs on one button reads as a rendering bug. */}
          {!isPending && <Send className="h-4 w-4" />}
          Publish grades
        </Button>
      ) : (
        /* Only offered once something is actually released — the way back from a misclick. */
        released > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmWithdraw(true)}
            disabled={isPending}
          >
            <EyeOff className="h-4 w-4" />
            Hide from students
          </Button>
        )
      )}

      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish grades to students?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <span className="block">
                  {unreleased} student{unreleased === 1 ? '' : 's'} will immediately see their
                  score, feedback and rubric breakdown, and will be notified.
                </span>
                {ungraded > 0 && (
                  <span className="block font-medium text-warning-muted-foreground">
                    {ungraded} student{ungraded === 1 ? ' has' : 's have'} no grade yet and
                    will be left out of this release.
                  </span>
                )}
                <span className="block text-muted-foreground">
                  You can hide them again afterwards, but anyone who has already looked will
                  have seen their grade.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            {/* preventDefault: Radix closes on click otherwise, so "Publishing…" never renders. */}
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); publish() }}
              disabled={isPending}
            >
              {isPending ? 'Publishing…' : 'Publish grades'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmWithdraw} onOpenChange={setConfirmWithdraw}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hide these grades from students?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <span className="block">
                  Scores, feedback and rubric breakdowns go back to being private, so you can
                  correct them before releasing again.
                </span>
                <span className="block text-muted-foreground">
                  This is not a full undo: students were already notified, and anyone who has
                  opened the assignment has seen their grade.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); withdraw() }}
              disabled={isPending}
            >
              {isPending ? 'Hiding…' : 'Hide from students'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
