'use client'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { OfficeHoursForm } from './OfficeHoursForm'
import type { OfficeHours } from '@/lib/validations/calendar'

interface Course {
  id: string
  name: string
  code: string | null
}

/**
 * Edit an existing office hour (opened from the calendar). Creating is handled by the unified
 * AddToCalendarDialog; this wraps the shared OfficeHoursForm in dialog chrome for the edit flow.
 */
export function CreateOfficeHoursDialog({
  open,
  onOpenChange,
  courses,
  professorId,
  professorName,
  onSave,
  editing,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  courses: Course[]
  professorId: string
  professorName: string
  onSave: (officeHours: OfficeHours) => void
  editing?: OfficeHours | null
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle>{editing ? 'Edit office hours' : 'Create office hours'}</DialogTitle>
          <DialogDescription>
            Update your recurring office hours. Slots regenerate automatically.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(85vh-8rem)] px-6 pb-6">
          <div className="pt-4">
            <OfficeHoursForm
              open={open}
              courses={courses}
              professorId={professorId}
              professorName={professorName}
              onSave={onSave}
              onCancel={() => onOpenChange(false)}
              editing={editing}
            />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
