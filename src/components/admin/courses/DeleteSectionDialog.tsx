/**
 * DeleteSectionDialog — confirmation for permanently deleting a course section.
 *
 * Deleting a section is the most destructive action in the admin console: 57 tables
 * cascade off `course_sections`, so it takes every enrollment, submission, quiz attempt,
 * grade and certificate in that section with it, with no soft-delete and no recovery
 * short of a database restore. This previously fired straight from a dropdown item with
 * no confirmation at all, one menu row below the harmless "Set Inactive".
 *
 * Two interlocks, because a plain "are you sure" is not proportionate to that:
 *   1. the real counts of what will be destroyed, fetched on open
 *   2. the section code must be typed before the confirm button enables — a mis-click,
 *      or a click on the wrong table row, cannot get through it
 *
 * Type: Client Component (cascade fetch + typed confirmation state)
 */
'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  removeAssignment,
  getSectionCascadeCounts,
} from '@/app/(dashboard)/admin/courses/actions'

interface SectionSummary {
  id: string
  section_code: string
}

interface DeleteSectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  section: SectionSummary | null
}

type Counts = Awaited<ReturnType<typeof getSectionCascadeCounts>>

export function DeleteSectionDialog({ open, onOpenChange, section }: DeleteSectionDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  /* Three states, deliberately not two: not-checked-yet, could-not-check, and checked.
     Collapsing the middle one into "zero" is what would tell an admin a full section is
     empty when the count simply failed. */
  const [counts, setCounts] = useState<Counts | 'failed' | null>(null)
  const [typed, setTyped] = useState('')

  const loadCounts = useCallback(() => {
    if (!section) return
    setCounts(null)
    getSectionCascadeCounts(section.id)
      .then((c) => setCounts(c ?? 'failed'))
      // A rejected action (network drop) would otherwise leave "Checking…" up forever,
      // which is a silent failure in front of a destructive confirm.
      .catch(() => setCounts('failed'))
  }, [section])

  useEffect(() => {
    if (open && section) {
      setTyped('')
      loadCounts()
    }
  }, [open, section, loadCounts])

  const confirmed = !!section && typed.trim() === section.section_code

  const handleDelete = async () => {
    if (!section || !confirmed) return
    setIsDeleting(true)
    try {
      const result = await removeAssignment(section.id)
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success(`Section ${section.section_code} deleted`)
      onOpenChange(false)
    } catch {
      toast.error('Failed to delete section')
    } finally {
      setIsDeleting(false)
    }
  }

  /* Only the lines worth reading — a row of zeroes is noise on an empty section.
     Plurals are spelled out rather than suffixed with 's': "quiz" would read "10 quizs". */
  const lines = counts && counts !== 'failed'
    ? ([
        [counts.students, 'enrolled student', 'enrolled students'],
        [counts.submissions, 'assignment submission', 'assignment submissions'],
        [counts.quizAttempts, 'quiz attempt', 'quiz attempts'],
        [counts.assignments, 'assignment', 'assignments'],
        [counts.quizzes, 'quiz', 'quizzes'],
        [counts.modules, 'module', 'modules'],
      ] as const).filter(([n]) => n > 0)
    : []

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* AlertDialogContent carries no max-height of its own, and this is the tallest
          alert dialog in the app — six bullet lines plus the input plus the footer clears
          a 390x667 viewport, and Radix locks background scroll, so the buttons would sit
          below the fold. Same fix as DialogContent, applied at the call site. */}
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete section permanently</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <span className="block">
                This deletes section <strong>{section?.section_code}</strong> and everything
                inside it. It cannot be undone.
              </span>

              {counts === null ? (
                <span className="block text-muted-foreground">Checking what this would delete…</span>
              ) : counts === 'failed' ? (
                /* Never the reassuring line here: we don't know, and saying "nothing to lose"
                   on a failed lookup is how a full section gets deleted. */
                <span className="block font-medium text-destructive">
                  Couldn&apos;t check what this section contains. Deleting it may destroy
                  enrollments, submissions and grades.{' '}
                  {/* Offer the recovery rather than describing it — "reload the page" is a
                      heavy instruction for a lookup that can just be retried in place. */}
                  <button
                    type="button"
                    onClick={loadCounts}
                    className="underline underline-offset-4 hover:no-underline"
                  >
                    Try again
                  </button>
                </span>
              ) : lines.length > 0 ? (
                <span className="block">
                  <span className="mb-1 block font-medium text-destructive">
                    This will permanently destroy:
                  </span>
                  <ul className="list-inside list-disc text-destructive">
                    {lines.map(([n, one, many]) => (
                      <li key={one}>
                        {n} {n === 1 ? one : many}
                      </li>
                    ))}
                  </ul>
                </span>
              ) : (
                <span className="block text-muted-foreground">
                  This section has no enrollments or student work.
                </span>
              )}

              <span className="block text-muted-foreground">
                To keep the section and its data but take it out of use, cancel and choose
                <strong> Set Inactive</strong> instead.
              </span>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="confirm-section-code">
            Type <strong>{section?.section_code}</strong> to confirm
          </Label>
          <Input
            id="confirm-section-code"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={section?.section_code}
            autoComplete="off"
            /* The field is the only thing the admin opened this dialog to do, and confirm
               stays disabled until it matches — so focusing it costs no safety. */
            autoFocus
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            /* preventDefault or Radix closes the dialog on click — which would make the
               "Deleting…" label and the disabled guard below unreachable, and leave the
               admin staring at nothing while a 57-table cascade runs. Same shape as
               AssignmentsManager's delete. */
            onClick={(e) => {
              e.preventDefault()
              void handleDelete()
            }}
            /* Inert until the counts settle: an admin who types the code fast could
               otherwise confirm before the numbers arrive, defeating the very interlock
               this dialog exists for. */
            disabled={isDeleting || !confirmed || counts === null}
            className="bg-destructive hover:bg-destructive/90 focus:ring-destructive"
          >
            {isDeleting ? 'Deleting…' : 'Delete section'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
