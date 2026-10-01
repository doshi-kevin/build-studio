/**
 * DeleteAnnouncementDialog — confirmation dialog before deleting an announcement.
 *
 * Type: Client Component
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
import { deleteAnnouncement } from '@/app/(dashboard)/professor/courses/[sectionId]/announcements/actions'

interface DeleteAnnouncementDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  announcement: { id: string; title: string } | null
}

export function DeleteAnnouncementDialog({
  open,
  onOpenChange,
  sectionId,
  announcement,
}: DeleteAnnouncementDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDelete = async () => {
    if (!announcement) return
    setIsDeleting(true)
    try {
      const result = await deleteAnnouncement(announcement.id, sectionId)
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Announcement deleted')
      onOpenChange(false)
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
          <AlertDialogTitle>Delete announcement?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete &ldquo;{announcement?.title}&rdquo;.
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={isDeleting}
            variant="destructive"
          >
            {isDeleting ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
