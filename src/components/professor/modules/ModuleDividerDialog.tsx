/**
 * ModuleDividerDialog — label prompt for a module-level divider (create/rename).
 * One field, so it skips react-hook-form; the server action validates.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  createModuleDivider,
  updateModuleDivider,
} from '@/app/(dashboard)/professor/courses/[sectionId]/modules/actions'
import type { ModuleDivider } from '@/components/shared/modules/module-rows'

interface ModuleDividerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  /** Present = rename that divider; absent = add a new one. */
  divider?: ModuleDivider | null
  /** The new divider's id — the list scrolls to it, since it appends at the end. */
  onCreated?: (dividerId: string) => void
}

export function ModuleDividerDialog({ open, onOpenChange, sectionId, divider, onCreated }: ModuleDividerDialogProps) {
  const isEditMode = !!divider
  const [title, setTitle] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submittingRef = useRef(false)

  // The dialog stays mounted between opens, so seed the field each time it opens.
  useEffect(() => {
    if (open) setTitle(divider?.title ?? '')
  }, [open, divider])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Synchronous guard — `disabled={isSubmitting}` only takes effect a render later,
    // so without this a fast second submit creates a second divider. See CreateModuleDialog.
    if (submittingRef.current) return
    submittingRef.current = true
    setIsSubmitting(true)
    try {
      // Split rather than shared: only the create path returns an id, and the
      // caller needs it to scroll the new row into view.
      if (isEditMode) {
        const result = await updateModuleDivider(divider!.id, sectionId, { title })
        if (result.error) {
          toast.error(result.error)
          return
        }
        toast.success('Divider renamed')
      } else {
        const result = await createModuleDivider(sectionId, { title })
        if (result.error || !result.dividerId) {
          toast.error(result.error ?? 'Failed to add divider')
          return
        }
        toast.success('Divider added')
        onCreated?.(result.dividerId)
      }
      onOpenChange(false)
    } catch {
      toast.error('Something went wrong')
    } finally {
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Rename divider' : 'Add divider'}</DialogTitle>
          <DialogDescription>
            A labelled break between modules. It also appears on the course
            roadmap — students see it there too.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="divider-label">Label</Label>
            <Input
              id="divider-label"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Midterm"
              maxLength={40}
              autoFocus
            />
            {/* Name the number: the input stops at 40 and silently truncates a
                paste, so the limit has to be visible before they hit it. */}
            <p className="text-xs text-muted-foreground">
              Up to 40 characters — short labels read best on the roadmap.
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !title.trim()}>
              {isSubmitting ? (isEditMode ? 'Saving…' : 'Adding…') : isEditMode ? 'Save' : 'Add divider'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
