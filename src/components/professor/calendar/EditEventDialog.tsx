'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CalendarEventForm } from './CalendarEventForm'
import {
  BLOCK_REASONS,
  BLOCK_REASON_LABELS,
  type BlockReason,
  type BlockedTime,
} from '@/lib/validations/calendar'

interface Course {
  id: string
  name: string
  code: string | null
}

/**
 * Edit an existing calendar event (lecture / exam / block …), opened by clicking it on the
 * calendar. The Type selector can change the event type (events only — office hours live in a
 * different table); Save updates, Delete removes. Mount with `key={event.id}` so the initial
 * Type re-seeds for each opened event.
 */
export function EditEventDialog({
  open,
  onOpenChange,
  event,
  courses,
  professorId,
  onSave,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  event: BlockedTime | null
  courses: Course[]
  professorId: string
  onSave: (blockedTime: BlockedTime) => void
  onDelete: () => void
}) {
  const [reason, setReason] = useState<BlockReason>(event?.reason ?? 'lecture')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle>Edit event</DialogTitle>
          <DialogDescription>Update this calendar entry, or remove it.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 px-6 pt-4">
          <Label htmlFor="edit-event-type">Type</Label>
          <Select value={reason} onValueChange={(v) => setReason(v as BlockReason)}>
            <SelectTrigger id="edit-event-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BLOCK_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {BLOCK_REASON_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <ScrollArea className="max-h-[calc(85vh-12rem)] px-6 pb-6">
          <div className="pt-4">
            {event && (
              <CalendarEventForm
                open={open}
                reason={reason}
                editing={event}
                courses={courses}
                professorId={professorId}
                onSave={onSave}
                onCancel={() => onOpenChange(false)}
                onDelete={onDelete}
              />
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
