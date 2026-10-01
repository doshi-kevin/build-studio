/**
 * DeleteProjectDialog — Confirmation dialog for permanently deleting a project.
 *
 * Shows a warning about permanent data loss and a destructive delete button.
 * Calls deleteProject server action and navigates back to the projects list.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { deleteProject } from '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'

interface DeleteProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  projectId: string
  projectTitle: string
}

export function DeleteProjectDialog({
  open,
  onOpenChange,
  sectionId,
  projectId,
  projectTitle,
}: DeleteProjectDialogProps) {
  const router = useRouter()
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      const result = await deleteProject(projectId, sectionId)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Project deleted')
      onOpenChange(false)
      router.push(`/professor/courses/${sectionId}/projects`)
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete project?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                This will permanently delete &ldquo;{projectTitle}&rdquo; and
                cannot be undone.
              </p>
              <div className="bg-destructive/5 border border-destructive/30 rounded-xl p-3 text-sm text-destructive">
                This will permanently delete the project assignment and all its data,
                including all student teams, their phases, videos, grades, and showcase settings.
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={isDeleting}
            variant="destructive"
          >
            {isDeleting ? 'Deleting…' : 'Delete Project'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
