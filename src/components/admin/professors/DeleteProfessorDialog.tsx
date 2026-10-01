/**
 * DeleteProfessorDialog — confirmation dialog for deleting a professor.
 *
 * Uses AlertDialog (destructive action semantics) and fetches cascade counts
 * on open to warn the admin about affected records. Blocks deletion if
 * the professor has active course section assignments (ON DELETE RESTRICT).
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
import { deleteProfessor, getProfessorCascadeCounts } from '@/app/(dashboard)/admin/professors/actions'

interface DeleteProfessorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  professor: { id: string; name: string; email: string } | null
}

export function DeleteProfessorDialog({ open, onOpenChange, professor }: DeleteProfessorDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const [counts, setCounts] = useState<{ departments: number; sections: number } | null>(null)

  useEffect(() => {
    if (open && professor) {
      setCounts(null)
      getProfessorCascadeCounts(professor.id).then(setCounts)
    }
  }, [open, professor])

  const handleDelete = async () => {
    if (!professor) return
    setIsDeleting(true)
    try {
      const result = await deleteProfessor(professor.id)
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success(`Professor "${professor.name}" deleted`)
      onOpenChange(false)
    } catch {
      toast.error('Failed to delete professor')
    } finally {
      setIsDeleting(false)
    }
  }

  const hasSections = counts && counts.sections > 0

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Professor</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              Are you sure you want to delete <strong>{professor?.name}</strong> ({professor?.email})?
            </span>
            {counts && counts.departments > 0 && (
              <span className="block text-warning-muted-foreground font-medium">
                This professor is assigned to {counts.departments} department{counts.departments !== 1 ? 's' : ''}.
              </span>
            )}
            {hasSections && (
              <span className="block text-destructive font-medium">
                Cannot delete: professor is assigned to {counts.sections} course section{counts.sections !== 1 ? 's' : ''}. Remove all course assignments first.
              </span>
            )}
            {!hasSections && (
              <span className="block">This action cannot be undone.</span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={isDeleting || !!hasSections}
            variant="destructive"
          >
            {isDeleting ? 'Deleting...' : 'Delete Professor'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
