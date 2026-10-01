/**
 * DeleteModuleDialog — confirmation dialog before deleting a module.
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
import { deleteModule } from '@/app/(dashboard)/professor/courses/[sectionId]/modules/actions'
import type { Module } from '@/lib/supabase/types'

interface DeleteModuleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  module: Module | null
  itemCount: number
}

export function DeleteModuleDialog({
  open,
  onOpenChange,
  sectionId,
  module,
  itemCount,
}: DeleteModuleDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDelete = async () => {
    if (!module) return
    setIsDeleting(true)
    try {
      const result = await deleteModule(module.id, sectionId)
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Module deleted')
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
          <AlertDialogTitle>Delete module?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                This will permanently delete &ldquo;{module?.title}&rdquo; and cannot be undone.
              </p>
              {itemCount > 0 && (
                <div className="bg-destructive-muted border border-destructive/30 rounded-xl p-3 text-sm text-destructive-muted-foreground">
                  This module contains {itemCount} {itemCount === 1 ? 'item' : 'items'} that will also be deleted.
                </div>
              )}
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
            {isDeleting ? 'Deleting…' : 'Delete Module'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
