'use client'

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

interface DeleteQuizDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  quizTitle: string
  onConfirm: () => void
}

export function DeleteQuizDialog({
  open,
  onOpenChange,
  quizTitle,
  onConfirm,
}: DeleteQuizDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Quiz</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete &quot;{quizTitle}&quot;? All student attempts for
            this quiz will also be deleted. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            variant="destructive"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
