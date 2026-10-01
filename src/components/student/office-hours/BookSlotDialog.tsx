'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Clock, User } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  BOOKING_MEETING_TYPES,
  MEETING_TYPE_LABELS,
  MEETING_PURPOSES,
  MEETING_PURPOSE_LABELS,
  createBookingFormSchema,
  type CreateBookingFormValues,
  type Booking,
  type Slot,
  type OfficeHours,
  type BookingMeetingType,
  type MeetingPurpose,
} from '@/lib/validations/calendar'
import { formatTimeDisplay } from '@/lib/calendar/utils'
import { generateId, nowISO } from '@/lib/quiz/utils'
import { useAthenaPrefill } from '@/lib/hooks/use-athena-prefill'

interface Course {
  id: string
  name: string
  code: string | null
}

interface BookSlotDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  slot: Slot | null
  officeHours: OfficeHours | null
  courses: Course[]
  studentId: string
  studentName: string
  studentEmail: string
  onBook: (booking: Booking) => void
}

export function BookSlotDialog({
  open,
  onOpenChange,
  slot,
  officeHours: oh,
  courses,
  studentId,
  studentName,
  studentEmail,
  onBook,
}: BookSlotDialogProps) {
  const form = useForm<CreateBookingFormValues>({
    resolver: zodResolver(createBookingFormSchema) as Resolver<CreateBookingFormValues>,
    defaultValues: {
      title: '',
      courseId: oh?.courseId ?? null,
      meetingType: oh && oh.meetingType !== 'hybrid' ? oh.meetingType : 'in_person',
      purpose: 'general_question',
      studentNote: '',
    },
  })

  /* C10 — a note Athena drafted from this student's own weak topics and a
     question they got wrong (design doc §14). Taken on mount, because this
     dialog is already mounted when she drives (`open` just toggles) — so the read is
     gated on `open` and the TTL is evaluated when the student actually sees the draft,
     then held until they pick a slot.

     It is a plain string in a controlled textarea, never markup, and nothing is
     sent until they press Book. They can rewrite or clear it first — which is
     the entire point of pre-filling the real form rather than posting on their
     behalf. */
  /* Read on OPEN, not on mount. This dialog is always mounted (`open` just toggles), so
     taking the draft at mount evaluated the 120s TTL once at page load — a student who
     waited 130s before opening the dialog still saw the draft verbatim, because the
     expiry had already been checked and passed (#664). */
  const draft = useAthenaPrefill('booking_note', open)
  const [pendingNote, setPendingNote] = useState<string | null>(null)
  const [takenDraft, setTakenDraft] = useState<string | null>(null)
  if (draft && draft !== takenDraft) {
    setTakenDraft(draft)
    setPendingNote(draft)
  }
  /* Placed once. The draft must not re-land after the first frame — see the
     placement effect below for why it's split out of the slot re-sync. */
  const placedRef = useRef(false)

  // The dialog stays mounted (open just toggles), so react-hook-form defaultValues are
  // captured once — at first mount `oh` is null, defaulting the mode to In Person. Re-sync
  // the form to the selected office hour whenever the dialog opens, so a Zoom slot shows
  // Zoom (not the stale first value). Also re-syncs the course default.
  //
  // Deliberately NOT keyed on `pendingNote`: a draft landing while the dialog is
  // open (Athena driving to the page the student is already on) must not reset the
  // title / mode / purpose they've already typed. The note it carries is placed by
  // the setValue effect below instead, which touches only `studentNote`. The note
  // itself is preserved across a re-sync (picking a second slot changes `oh`).
  useEffect(() => {
    if (!open || !oh) return
    form.reset({
      title: '',
      courseId: oh.courseId ?? null,
      meetingType: oh.meetingType !== 'hybrid' ? oh.meetingType : 'in_person',
      purpose: 'general_question',
      studentNote: form.getValues('studentNote') ?? '',
    })
  }, [open, oh, form])

  // Athena's drafted note, placed ONCE via setValue so it fills only the note
  // field and leaves everything the student has typed untouched.
  useEffect(() => {
    if (!open || !pendingNote || placedRef.current) return
    placedRef.current = true
    form.setValue('studentNote', pendingNote)
  }, [open, pendingNote, form])

  const onSubmit = useCallback(
    (data: CreateBookingFormValues) => {
      if (!slot || !oh) return
      const course = courses.find((c) => c.id === data.courseId)
      const now = nowISO()

      // Hybrid office hours let the student pick a concrete mode; a fixed mode is inherited
      // (they can't override it). Carry only the relevant detail — location vs Zoom link.
      const meetingType: BookingMeetingType =
        oh.meetingType === 'hybrid' ? data.meetingType : oh.meetingType

      const booking: Booking = {
        id: generateId(),
        slotId: slot.id,
        officeHoursId: oh.id,
        professorId: oh.professorId,
        professorName: oh.professorName,
        studentId,
        studentName,
        studentEmail,
        date: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        title: data.title,
        courseId: data.courseId,
        courseName: course?.name ?? null,
        courseCode: course?.code ?? null,
        meetingType,
        purpose: data.purpose,
        studentNote: data.studentNote,
        professorNote: '',
        location: meetingType === 'zoom' ? '' : oh.location,
        zoomLink: meetingType === 'in_person' ? '' : oh.zoomLink,
        status: 'booked',
        cancelledBy: null,
        cancellationReason: '',
        createdAt: now,
        updatedAt: now,
      }

      onBook(booking)
      form.reset()
      onOpenChange(false)
    },
    [onBook, form, onOpenChange, slot, oh, courses, studentId, studentName, studentEmail],
  )

  if (!slot || !oh) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Book Office Hours</DialogTitle>
          <DialogDescription>
            Confirm your booking details.
          </DialogDescription>
        </DialogHeader>

        {/* Slot info */}
        <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/50 border border-border">
          <User className="h-5 w-5 text-muted-foreground shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{oh.professorName}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
              <Clock className="h-3 w-3" />
              {slot.date} · {formatTimeDisplay(slot.startTime)} – {formatTimeDisplay(slot.endTime)}
            </div>
          </div>
          {oh.courseCode && (
            <Badge variant="secondary" className="text-xs shrink-0">
              {oh.courseCode}
            </Badge>
          )}
        </div>

        <Separator />

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Meeting Title *</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Doubt in Linear Regression" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="meetingType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type{oh.meetingType !== 'hybrid' ? ' (set by professor)' : ''}</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(v) => field.onChange(v as BookingMeetingType)}
                      disabled={oh.meetingType !== 'hybrid'}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {BOOKING_MEETING_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {MEETING_TYPE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="purpose"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Purpose *</FormLabel>
                    <Select value={field.value} onValueChange={(v) => field.onChange(v as MeetingPurpose)}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {MEETING_PURPOSES.map((p) => (
                          <SelectItem key={p} value={p}>
                            {MEETING_PURPOSE_LABELS[p]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="courseId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Course (optional)</FormLabel>
                  <Select
                    value={field.value ?? 'none'}
                    onValueChange={(v) => field.onChange(v === 'none' ? null : v)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {courses.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.code ? `${c.code} — ${c.name}` : c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="studentNote"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Any details for the professor..."
                      rows={2}
                      className="resize-none"
                      {...field}
                    />
                  </FormControl>
                  {/* Said once, while the words are still hers: the student is
                      about to send this under their own name, so they need to
                      know they didn't write it. Disappears the moment they edit
                      it, because from then on they did. */}
                  {pendingNote && field.value === pendingNote && (
                    <p className="text-xs text-muted-foreground">
                      Athena drafted this from your weak topics — edit it before you book, your
                      professor reads it.
                    </p>
                  )}
                    <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit">Confirm Booking</Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
