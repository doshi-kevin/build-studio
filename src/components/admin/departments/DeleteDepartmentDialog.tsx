/**
 * DeleteDepartmentDialog — confirmation dialog before deleting a department.
 *
 * Fetches cascade counts when opened to warn the admin about what will be permanently
 * removed. A department is the top-level entity, so this has the largest blast radius in
 * the product: it reaches programs, courses, the sections under those courses, and every
 * student enrolled in them.
 *
 * The counts are three-state on purpose — not-checked-yet, could-not-check, checked. The
 * middle state used to collapse into zeros, and the zero branch renders as "nothing will
 * be affected", so a failed lookup actively reassured the admin right before an
 * unrecoverable delete (#715). Mirrors DeleteSectionDialog, which was fixed first.
 *
 * Type: Client Component (manages loading state + calls server actions)
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
import { deleteDepartment, getDepartmentCascadeCounts } from '@/app/(dashboard)/admin/departments/actions'

interface DeleteDepartmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  department: { id: string; name: string; code: string } | null
}

interface Counts {
  programs: number
  courses: number
  faculty: number
  sections: number
  enrollments: number
}

export function DeleteDepartmentDialog({ open, onOpenChange, department }: DeleteDepartmentDialogProps) {
  const [counts, setCounts] = useState<Counts | 'failed' | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const loadCounts = useCallback(() => {
    if (!department) return
    setCounts(null)
    getDepartmentCascadeCounts(department.id)
      .then((c) => setCounts(c ?? 'failed'))
      /* A rejected action (network drop) would otherwise leave "Checking…" up forever,
         which is a silent failure in front of a destructive confirm. */
      .catch(() => setCounts('failed'))
  }, [department])

  /** Fetch cascade counts when dialog opens */
  useEffect(() => {
    if (open && department) loadCounts()
  }, [open, department, loadCounts])

  const handleDelete = async () => {
    if (!department) return
    setIsDeleting(true)
    try {
      const result = await deleteDepartment(department.id)
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success(`Department "${department.name}" deleted`)
      onOpenChange(false)
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsDeleting(false)
    }
  }

  /* Only the lines worth reading — a row of zeroes is noise on an empty department.
     Enrolled students lead: they are the consequence an admin most needs to see, and the
     one the dialog never used to mention. Plurals are spelled out rather than suffixed
     with 's' so "1 enrolled student" reads correctly. */
  const lines = counts && counts !== 'failed'
    ? ([
        [counts.enrollments, 'enrolled student', 'enrolled students'],
        [counts.sections, 'course section', 'course sections'],
        [counts.programs, 'program', 'programs'],
        [counts.courses, 'course', 'courses'],
        [counts.faculty, 'faculty assignment', 'faculty assignments'],
      ] as const).filter(([n]) => n > 0)
    : []

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &ldquo;{department?.name}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>This action cannot be undone.</p>
              {counts === null ? (
                <p className="text-sm text-muted-foreground">Checking what this would delete…</p>
              ) : counts === 'failed' ? (
                /* Never the reassuring line here: we don't know, and saying "nothing will
                   be affected" on a failed lookup is how a populated department gets
                   deleted. */
                <p className="text-sm font-medium text-destructive">
                  Couldn&apos;t check what this department contains. Deleting it may destroy
                  course sections, enrollments and student work.{' '}
                  <button
                    type="button"
                    onClick={loadCounts}
                    className="underline underline-offset-4 hover:no-underline"
                  >
                    Try again
                  </button>
                </p>
              ) : lines.length > 0 ? (
                <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-3 text-sm text-destructive">
                  <p className="font-medium mb-1">This will permanently delete:</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {lines.map(([n, one, many]) => (
                      <li key={one}>{n} {n === 1 ? one : many}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing else is attached to this department.</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          {/* Inert while the counts are still loading: an admin who clicks fast would
              otherwise confirm before seeing what they are destroying. A 'failed' lookup
              does NOT disable it — blocking the delete outright on a transient read error
              would strand a legitimate cleanup, so the warning carries that decision. */}
          <AlertDialogAction
            onClick={handleDelete}
            disabled={isDeleting || counts === null}
            variant="destructive"
          >
            {isDeleting ? 'Deleting...' : 'Delete Department'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
