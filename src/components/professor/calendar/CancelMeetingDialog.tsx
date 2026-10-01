'use client'

import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Textarea } from '@/components/ui/textarea'
import type { Booking } from '@/lib/validations/calendar'

interface CancelMeetingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  booking: Booking | null
  onConfirm: (reason: string) => void
}

export function CancelMeetingDialog({
  open,
  onOpenChange,
  booking,
  onConfirm,
}: CancelMeetingDialogProps) {
  const [reason, setReason] = useState('')

  if (!booking) return null

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel Meeting</AlertDialogTitle>
          <AlertDialogDescription>
            Cancel the meeting &quot;{booking.title}&quot; with {booking.studentName}?
            The student will be notified and the slot will become available again.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Cancellation reason (optional)..."
          rows={2}
          className="resize-none"
        />

        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setReason('')}>Keep Meeting</AlertDialogCancel>
          <AlertDialogAction
          variant="destructive"
            onClick={() => {
              onConfirm(reason)
              setReason('')
            }}
          >
            Cancel Meeting
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
