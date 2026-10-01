'use client'

import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { WarehouseCourse } from '@/lib/validations/warehouse'

export type ShelfDeleteMode = 'clear' | 'remove'

interface DeleteShelfDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  course: WarehouseCourse | null
  fileCount: number
  isRealCourse: boolean // linked to a real course section — can't fully remove
  onConfirm: (mode: ShelfDeleteMode) => void
}

export function DeleteShelfDialog({
  open,
  onOpenChange,
  course,
  fileCount,
  isRealCourse,
  onConfirm,
}: DeleteShelfDialogProps) {
  const [mode, setMode] = useState<ShelfDeleteMode>('clear')
  const shelfName = course ? `${course.code ? `${course.code} — ` : ''}${course.name}` : 'Unsorted Files'

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {mode === 'clear' ? 'Clear Shelf?' : 'Remove Shelf?'}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <p>
                {fileCount > 0
                  ? `"${shelfName}" contains ${fileCount} file${fileCount === 1 ? '' : 's'}. This action cannot be undone.`
                  : `"${shelfName}" has no files.`}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Mode selection */}
        <div className="space-y-2 py-1">
          <button
            type="button"
            className={`w-full text-left p-3 rounded-xl border-2 transition-colors ${
              mode === 'clear'
                ? 'border-destructive bg-destructive/5'
                : 'border-muted hover:border-muted-foreground/30'
            }`}
            onClick={() => setMode('clear')}
          >
            <span className="text-sm font-medium">Clear all files</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Delete all files in this shelf. The shelf stays.
            </p>
          </button>

          {!isRealCourse && (
            <button
              type="button"
              className={`w-full text-left p-3 rounded-xl border-2 transition-colors ${
                mode === 'remove'
                  ? 'border-destructive bg-destructive/5'
                  : 'border-muted hover:border-muted-foreground/30'
              }`}
              onClick={() => setMode('remove')}
            >
              <span className="text-sm font-medium">Remove shelf entirely</span>
              <p className="text-xs text-muted-foreground mt-0.5">
                Delete all files and remove the shelf from your library.
              </p>
            </button>
          )}
        </div>

        {isRealCourse && (
          <p className="text-xs text-muted-foreground">
            This shelf is linked to an assigned course and cannot be fully removed.
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => onConfirm(mode)}
          >
            {mode === 'clear' ? 'Clear Files' : 'Remove Shelf'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
