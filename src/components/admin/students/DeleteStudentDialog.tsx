/**
 * DeleteStudentDialog — confirmation dialog for deleting a student.
 *
 * Uses AlertDialog (destructive action semantics) and fetches cascade counts
 * on open to warn the admin about affected enrollments.
 * Enrollments cascade-delete automatically (ON DELETE CASCADE on student_id FK).
 *
 * Type: Client Component (needs useEffect for cascade count fetch + delete state)
 */
'use client'

import { useState, useEffect } from 'react'
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
import { deleteStudent, getStudentCascadeCounts } from '@/app/(dashboard)/admin/students/actions'

interface DeleteStudentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  student: { id: string; name: string; email: string } | null
}

export function DeleteStudentDialog({ open, onOpenChange, student }: DeleteStudentDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const [counts, setCounts] = useState<{ enrollments: number } | null>(null)

  /* Fetch cascade counts when dialog opens */
  useEffect(() => {
    if (open && student) {
      setCounts(null)
      getStudentCascadeCounts(student.id).then(setCounts)
    }
  }, [open, student])

  const handleDelete = async () => {
    if (!student) return
    setIsDeleting(true)
    try {
      const result = await deleteStudent(student.id)
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success(`Student "${student.name}" deleted`)
      onOpenChange(false)
    } catch {
      toast.error('Failed to delete student')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Student</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              Are you sure you want to delete <strong>{student?.name}</strong> ({student?.email})?
            </span>
            {counts && counts.enrollments > 0 && (
              <span className="block text-warning-muted-foreground font-medium">
                This will also remove {counts.enrollments} course enrollment{counts.enrollments !== 1 ? 's' : ''}.
              </span>
            )}
            <span className="block">This action cannot be undone.</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={isDeleting}
            variant="destructive"
          >
            {isDeleting ? 'Deleting...' : 'Delete Student'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
