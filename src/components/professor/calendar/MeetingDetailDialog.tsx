'use client'

import { useState, useMemo } from 'react'
import {
  Calendar,
  Clock,
  MapPin,
  Video,
  User,
  Mail,
  BookOpen,
  Pencil,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { formatTimeDisplay } from '@/lib/calendar/utils'
import { STATUS_BADGE } from './event-colors'
import {
  MEETING_TYPE_LABELS,
  MEETING_PURPOSE_LABELS,
  SLOT_STATUS_LABELS,
} from '@/lib/validations/calendar'
import type { Booking } from '@/lib/validations/calendar'

interface MeetingDetailDialogProps {
  booking: Booking | null
  open: boolean
  onOpenChange: (open: boolean) => void
  allBookings: Booking[]
  onUpdateNote: (bookingId: string, note: string) => void
  onMarkCompleted: (bookingId: string) => void
  onMarkNoShow: (bookingId: string) => void
  onCancel: (booking: Booking) => void
}

export function MeetingDetailDialog({
  booking,
  open,
  onOpenChange,
  allBookings,
  onUpdateNote,
  onMarkCompleted,
  onMarkNoShow,
  onCancel,
}: MeetingDetailDialogProps) {
  const [editingNote, setEditingNote] = useState(false)
  const [noteText, setNoteText] = useState('')

  // Student history — previous meetings with the same student
  const studentHistory = useMemo(() => {
    if (!booking) return []
    return allBookings
      .filter(
        (b) =>
          b.studentId === booking.studentId &&
          b.id !== booking.id,
      )
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [booking, allBookings])

  if (!booking) return null

  const isActive = booking.status === 'booked'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle className="flex items-center gap-3">
            <div className="p-2.5 rounded-full bg-muted">
              <User className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-base">{booking.studentName}</p>
              <DialogDescription className="mt-0.5 flex items-center gap-1.5">
                <Mail className="h-3 w-3" />
                {booking.studentEmail}
              </DialogDescription>
            </div>
            <Badge variant="outline" className={`ml-auto shrink-0 ${STATUS_BADGE[booking.status]}`}>
              {SLOT_STATUS_LABELS[booking.status]}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(85vh-7rem)]">
          <div className="px-6 pb-6 space-y-5">
            {/* Meeting title */}
            <div>
              <h3 className="font-semibold text-base">{booking.title}</h3>
              <Badge variant="secondary" className="mt-1 text-xs">
                {MEETING_PURPOSE_LABELS[booking.purpose]}
              </Badge>
            </div>

            <Separator />

            {/* Info grid */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Date</p>
                  <p className="font-medium">{booking.date}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Time</p>
                  <p className="font-medium tabular-nums">
                    {formatTimeDisplay(booking.startTime)} – {formatTimeDisplay(booking.endTime)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {booking.meetingType === 'zoom' ? (
                  <Video className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <div>
                  <p className="text-xs text-muted-foreground">
                    {MEETING_TYPE_LABELS[booking.meetingType]}
                  </p>
                  {booking.zoomLink ? (
                    <a
                      href={booking.zoomLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all font-medium text-primary underline underline-offset-2 hover:no-underline"
                    >
                      Join Zoom
                    </a>
                  ) : (
                    <p className="font-medium">{booking.location || '—'}</p>
                  )}
                </div>
              </div>
              {booking.courseCode && (
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Course</p>
                    <p className="font-medium">
                      {booking.courseCode}{booking.courseName ? ` — ${booking.courseName}` : ''}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Student's note */}
            {booking.studentNote && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Student&apos;s Note</p>
                  <div className="bg-muted/50 p-3 rounded-xl border border-border text-sm">
                    {booking.studentNote}
                  </div>
                </div>
              </>
            )}

            {/* Professor's private note */}
            <Separator />
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium">Private Note</p>
                {!editingNote && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setNoteText(booking.professorNote)
                      setEditingNote(true)
                    }}
                  >
                    <Pencil className="h-3 w-3 mr-1" />
                    {booking.professorNote ? 'Edit' : 'Add Note'}
                  </Button>
                )}
              </div>
              {editingNote ? (
                <div className="space-y-2">
                  <Textarea
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="Private note (only you can see this)..."
                    rows={3}
                    className="resize-none"
                    maxLength={2000}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditingNote(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        onUpdateNote(booking.id, noteText)
                        setEditingNote(false)
                      }}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : booking.professorNote ? (
                <div className="bg-warning-muted p-3 rounded-xl border border-warning/30 text-warning-muted-foreground text-sm">
                  {booking.professorNote}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No private note yet.
                </p>
              )}
            </div>

            {/* Actions */}
            {isActive && (
              <>
                <Separator />
                <div className="flex gap-2 flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-success-muted-foreground border-success/30 hover:bg-success-muted"
                    onClick={() => onMarkCompleted(booking.id)}
                  >
                    <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
                    Mark Completed
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-warning-muted-foreground border-warning/30 hover:bg-warning-muted"
                    onClick={() => onMarkNoShow(booking.id)}
                  >
                    <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
                    Mark No-Show
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    onClick={() => onCancel(booking)}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1.5" />
                    Cancel
                  </Button>
                </div>
              </>
            )}

            {/* Student History */}
            {studentHistory.length > 0 && (
              <>
                <Separator />
                <div>
                  <p className="text-sm font-medium mb-2">
                    Previous Meetings with {booking.studentName}
                  </p>
                  <div className="space-y-1.5">
                    {studentHistory.map((h) => (
                      <div
                        key={h.id}
                        className="flex items-center justify-between text-sm p-2 rounded-xl bg-muted/50"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">{h.title}</p>
                          <p className="text-xs text-muted-foreground tabular-nums">
                            {h.date} · {formatTimeDisplay(h.startTime)}
                          </p>
                        </div>
                        <Badge variant="outline" className={`shrink-0 text-xs ${STATUS_BADGE[h.status]}`}>
                          {SLOT_STATUS_LABELS[h.status]}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
