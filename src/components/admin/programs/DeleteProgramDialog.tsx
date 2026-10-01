/**
 * DeleteProgramDialog — confirmation dialog for deleting a program.
 *
 * Uses AlertDialog (destructive action semantics).
 * No cascade warning needed — nothing references programs.id as a FK.
 *
 * Type: Client Component (needs delete state)
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
import { deleteProgram } from '@/app/(dashboard)/admin/programs/actions'

interface DeleteProgramDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  program: { id: string; name: string; code: string } | null
}

export function DeleteProgramDialog({ open, onOpenChange, program }: DeleteProgramDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDelete = async () => {
    if (!program) return
    setIsDeleting(true)
    try {
      const result = await deleteProgram(program.id)
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success(`Program "${program.name}" deleted`)
      onOpenChange(false)
    } catch {
      toast.error('Failed to delete program')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Program</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              Are you sure you want to delete <strong>{program?.name}</strong> ({program?.code})?
            </span>
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
            {isDeleting ? 'Deleting...' : 'Delete Program'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
