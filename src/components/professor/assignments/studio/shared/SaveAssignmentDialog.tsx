/**
 * SaveAssignmentDialog — shared save/exit confirmation dialog used across all studios.
 *
 * Two modes:
 *  - Save mode (no onDiscard): a simple "name then save" dialog.
 *  - Exit-guard mode (onDiscard present): shows a destructive "Discard" button that permanently
 *    deletes the autosaved draft, alongside "Save assignment". Work autosaves as you go, so the
 *    only two honest choices on exit are keep-it (Save) or throw-it-away (Discard).
 *
 * Type: Client Component (shadcn Dialog primitives)
 */
'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultTitle: string
  onSave: (title: string) => void
  /**
   * When provided, the dialog is in exit-guard mode. Shows a destructive "Discard" button that
   * permanently deletes the autosaved draft assignment, then leaves.
   */
  onDiscard?: () => void
  saving?: boolean
}

export function SaveAssignmentDialog({ open, onOpenChange, defaultTitle, onSave, onDiscard, saving }: Props) {
  const [titleInput, setTitleInput] = useState(defaultTitle)
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false)

  // Re-seed the input from defaultTitle each time the dialog opens (e.g. an inline rename happened
  // since last open). Done via the "adjust state during render" pattern — no effect, so it can't
  // trigger cascading re-renders.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setTitleInput(defaultTitle)
  }

  const isExitMode = typeof onDiscard === 'function'

  function handleSave() {
    const next = titleInput.trim()
    if (!next) return
    onSave(next)
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save assignment</DialogTitle>
          <DialogDescription>
            {isExitMode
              ? 'Your work autosaves as you go. Save it to keep it, or discard it to delete it permanently.'
              : 'Name this assignment before saving.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="save-dialog-title">Title</Label>
          <Input
            id="save-dialog-title"
            value={titleInput}
            autoFocus
            onChange={(e) => setTitleInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && titleInput.trim()) handleSave() }}
            placeholder="Assignment title"
          />
        </div>
        <DialogFooter className={isExitMode ? 'flex-col-reverse gap-2 sm:flex-row sm:justify-between' : undefined}>
          {isExitMode && (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDiscardConfirmOpen(true)}
              disabled={saving}
            >
              Discard
            </Button>
          )}
          <Button onClick={handleSave} disabled={!titleInput.trim() || saving}>
            {saving ? 'Saving…' : 'Save assignment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog open={discardConfirmOpen} onOpenChange={setDiscardConfirmOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this draft permanently?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the draft and everything in it. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDiscardConfirmOpen(false)}>Keep editing</AlertDialogCancel>
          <AlertDialogAction
          variant="destructive"
            onClick={() => {
              setDiscardConfirmOpen(false)
              onDiscard?.()
            }}
          >
            Delete draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
