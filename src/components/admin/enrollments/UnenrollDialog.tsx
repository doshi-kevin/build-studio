/**
 * UnenrollDialog -- confirmation dialog for removing a student from a course section.
 *
 * Uses AlertDialog (destructive action semantics). Calls the unenrollStudent
 * server action and shows success/error toast.
 *
 * Type: Client Component (needs submit state + toast)
 */
'use client'

import { useState } from 'react'
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
import { unenrollStudent } from '@/app/(dashboard)/admin/students/enrollment-actions'

interface UnenrollDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  enrollment: {
    id: string
    studentId: string
    studentName: string
    courseName: string
  } | null
}

export function UnenrollDialog({
  open,
  onOpenChange,
  enrollment,
}: UnenrollDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)

  const handleUnenroll = async () => {
    if (!enrollment) return

    setIsDeleting(true)
    try {
      const result = await unenrollStudent(enrollment.id, enrollment.studentId)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success(`Removed ${enrollment.studentName} from ${enrollment.courseName}`)
      onOpenChange(false)
    } catch {
      toast.error('Failed to unenroll student')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unenroll Student</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              Remove <strong>{enrollment?.studentName}</strong> from{' '}
              <strong>{enrollment?.courseName}</strong>?
            </span>
            <span className="block">This action cannot be undone.</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleUnenroll}
            disabled={isDeleting}
            variant="destructive"
          >
            {isDeleting ? 'Removing...' : 'Unenroll'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
