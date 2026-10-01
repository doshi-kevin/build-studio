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

interface SubmitConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  flaggedCount: number
  unansweredCount: number
  totalQuestions: number
  onConfirm: () => void
}

export function SubmitConfirmDialog({
  open,
  onOpenChange,
  flaggedCount,
  unansweredCount,
  totalQuestions,
  onConfirm,
}: SubmitConfirmDialogProps) {
  const answeredCount = totalQuestions - unansweredCount
  const warnings: string[] = []
  if (flaggedCount > 0) {
    warnings.push(`${flaggedCount} bookmarked question${flaggedCount !== 1 ? 's' : ''}`)
  }
  if (unansweredCount > 0) {
    warnings.push(`${unansweredCount} unanswered question${unansweredCount !== 1 ? 's' : ''}`)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Submit Quiz?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block mb-1 text-foreground font-medium">
              {answeredCount} of {totalQuestions} questions answered.
            </span>
            {warnings.length > 0 ? (
              <>
                You have {warnings.join(' and ')}. Once submitted, you cannot change
                your answers. Are you sure you want to submit?
              </>
            ) : (
              <>Once submitted, you cannot change your answers. Are you sure?</>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Review Answers</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Submit Quiz</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
