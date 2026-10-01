/**
 * DeleteCourseDialog — confirmation dialog for deleting a course.
 *
 * Uses AlertDialog (destructive action semantics) and fetches cascade counts on open to
 * show the admin what will be deleted. The copy used to promise "and all associated
 * enrollments" without ever counting them, so the number the admin most needed was the
 * one number missing (#715).
 *
 * Counts are three-state — loading, could-not-check, checked. `null` alone can't carry
 * that, because the action now returns null for a FAILED read, which must never render as
 * the silent no-warning path.
 *
 * Type: Client Component (needs useEffect for cascade count fetch + delete state)
 */
'use client'

import { useState, useEffect, useCallback } from 'react'
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
import { deleteCourse, getCourseCascadeCounts } from '@/app/(dashboard)/admin/departments/course-actions'

interface DeleteCourseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  course: { id: string; code: string; title: string; departmentId: string } | null
}

interface Counts {
  sections: number
  enrollments: number
}

export function DeleteCourseDialog({ open, onOpenChange, course }: DeleteCourseDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const [cascadeCounts, setCascadeCounts] = useState<Counts | 'failed' | null>(null)

  const loadCounts = useCallback(() => {
    if (!course) return
    setCascadeCounts(null)
    getCourseCascadeCounts(course.id)
      .then((c) => setCascadeCounts(c ?? 'failed'))
      .catch(() => setCascadeCounts('failed'))
  }, [course])

  /** Fetch cascade counts when the dialog opens */
  useEffect(() => {
    if (open && course) loadCounts()
  }, [open, course, loadCounts])

  const handleDelete = async () => {
    if (!course) return
    setIsDeleting(true)
    try {
      const result = await deleteCourse(course.id, course.departmentId)
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success(`Course "${course.code}" deleted`)
      onOpenChange(false)
    } catch {
      toast.error('Failed to delete course')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Course</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              Are you sure you want to delete <strong>{course?.code}</strong> — {course?.title}?
            </span>
            {cascadeCounts === null ? (
              <span className="block text-muted-foreground">Checking what this would delete…</span>
            ) : cascadeCounts === 'failed' ? (
              <span className="block text-destructive font-medium">
                Couldn&apos;t check what this course contains. Deleting it may destroy
                sections, enrollments and student work.{' '}
                <button
                  type="button"
                  onClick={loadCounts}
                  className="underline underline-offset-4 hover:no-underline"
                >
                  Try again
                </button>
              </span>
            ) : cascadeCounts.sections > 0 ? (
              /* Name the enrolled students, not just the section count. "All associated
                 enrollments" was true and useless — the admin could not tell one empty
                 section from a full semester. */
              <span className="block text-destructive font-medium">
                This will permanently delete {cascadeCounts.sections} section{cascadeCounts.sections !== 1 ? 's' : ''}
                {cascadeCounts.enrollments > 0
                  ? ` and ${cascadeCounts.enrollments} student enrollment${cascadeCounts.enrollments !== 1 ? 's' : ''}`
                  : ' (no students are enrolled)'}
                .
              </span>
            ) : null}
            <span className="block">This action cannot be undone.</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          {/* Inert until the counts settle, so a fast click can't confirm before the
              warning renders. */}
          <AlertDialogAction
            onClick={handleDelete}
            disabled={isDeleting || cascadeCounts === null}
            variant="destructive"
          >
            {isDeleting ? 'Deleting...' : 'Delete Course'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
