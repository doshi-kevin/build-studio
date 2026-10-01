/**
 * CanvasTypePickerDialog — Small modal that asks the user what kind of
 * canvas to create before calling the server action. For now only the
 * Document type is offered; additional tile types can be added here later
 * without touching the caller.
 *
 * Type: Client Component
 */
'use client'

import { FileText, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type CanvasType = 'document'

interface CanvasTypePickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (type: CanvasType) => void
  creating?: boolean
}

export function CanvasTypePickerDialog({
  open,
  onOpenChange,
  onSelect,
  creating = false,
}: CanvasTypePickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New canvas</DialogTitle>
          <DialogDescription>
            Pick the kind of canvas you want to create.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 pt-2">
          <button
            type="button"
            onClick={() => onSelect('document')}
            disabled={creating}
            className="group flex items-start gap-3 rounded-xl border border-border bg-background p-4 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/50 transition-transform group-hover:scale-105">
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground">Document</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Rich-text canvas for notes, plans, and team writing.
              </p>
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
