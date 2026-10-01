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
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { OfficeHoursForm } from './OfficeHoursForm'
import { CalendarEventForm } from './CalendarEventForm'
import {
  BLOCK_REASONS,
  BLOCK_REASON_LABELS,
  type BlockReason,
  type BlockedTime,
  type OfficeHours,
} from '@/lib/validations/calendar'

interface Course {
  id: string
  name: string
  code: string | null
}

/** Office hours (bookable) or a one-off/recurring event (lecture, exam, block…). */
type CalendarEntryType = 'office_hours' | BlockReason

/**
 * One "Add to calendar" dialog for everything a professor schedules. A Type selector at the
 * top swaps between the office-hours form (bookable slots → office_hours table) and the event
 * form (lectures/exams/blocks → blocked_times). Office hours and events genuinely differ
 * downstream (bookable vs not), so they keep separate tables + forms behind this one entry point.
 */
export function AddToCalendarDialog({
  open,
  onOpenChange,
  courses,
  professorId,
  professorName,
  onSaveOfficeHours,
  onSaveEvent,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  courses: Course[]
  professorId: string
  professorName: string
  onSaveOfficeHours: (officeHours: OfficeHours) => void
  onSaveEvent: (blockedTime: BlockedTime) => void
}) {
  const [type, setType] = useState<CalendarEntryType>('office_hours')

  // Reset to Office hours on close so each open starts fresh on the default type (done here
  // rather than in an open effect to avoid a cascading-render setState-in-effect).
  const handleOpenChange = (next: boolean) => {
    if (!next) setType('office_hours')
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle>Add to calendar</DialogTitle>
          <DialogDescription>
            Add office hours students can book, or a lecture, exam, meeting, or personal block.
          </DialogDescription>
        </DialogHeader>

        {/* Type — pinned above the scroll region so switching is always reachable, even with
            the taller office-hours form. */}
        <div className="space-y-2 px-6 pt-4">
          <Label htmlFor="calendar-entry-type">Type</Label>
          <Select value={type} onValueChange={(v) => setType(v as CalendarEntryType)}>
            <SelectTrigger id="calendar-entry-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="office_hours">Office hours</SelectItem>
              <SelectSeparator />
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
            {type === 'office_hours' ? (
              <OfficeHoursForm
                open={open}
                courses={courses}
                professorId={professorId}
                professorName={professorName}
                onSave={onSaveOfficeHours}
                onCancel={() => handleOpenChange(false)}
              />
            ) : (
              <CalendarEventForm
                open={open}
                reason={type}
                courses={courses}
                professorId={professorId}
                onSave={onSaveEvent}
                onCancel={() => handleOpenChange(false)}
              />
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
