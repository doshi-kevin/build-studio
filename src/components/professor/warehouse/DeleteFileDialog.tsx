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
import type { WarehouseFile } from '@/lib/validations/warehouse'

interface DeleteFileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: WarehouseFile | null
  onConfirm: () => void
}

export function DeleteFileDialog({
  open,
  onOpenChange,
  file,
  onConfirm,
}: DeleteFileDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete File?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete &ldquo;{file?.name}&rdquo;. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
