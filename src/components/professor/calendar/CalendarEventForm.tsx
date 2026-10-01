'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useForm, useWatch, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { format } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  MEETING_TYPES,
  MEETING_TYPE_LABELS,
  RECURRENCES,
  RECURRENCE_LABELS,
  blockTimeFormSchema,
  type BlockTimeFormValues,
  type BlockedTime,
  type BlockReason,
  type MeetingType,
  type Recurrence,
} from '@/lib/validations/calendar'
import { generateId, nowISO } from '@/lib/quiz/utils'

interface Course {
  id: string
  name: string
  code: string | null
}

const MEETING_MODE_NONE = 'none'

const defaultsFor = (reason: BlockReason): BlockTimeFormValues => ({
  date: new Date().toISOString().split('T')[0],
  startTime: '09:00',
  endTime: '10:00',
  reason,
  note: '',
  courseId: null,
  meetingType: null,
  location: '',
  zoomLink: '',
  recurrence: 'none',
  recurrenceUntil: null,
})

const valuesFrom = (bt: BlockedTime): BlockTimeFormValues => ({
  date: bt.date,
  startTime: bt.startTime,
  endTime: bt.endTime,
  reason: bt.reason,
  note: bt.note,
  courseId: bt.courseId,
  meetingType: bt.meetingType,
  location: bt.location,
  zoomLink: bt.zoomLink,
  recurrence: bt.recurrence,
  recurrenceUntil: bt.recurrenceUntil,
})

/**
 * The event create/edit form body (no dialog chrome) for lectures, exams, meetings, and
 * personal blocks — everything that saves to blocked_times. The event's TYPE is owned by the
 * parent's Type selector and passed in as `reason`; we keep it in the form (hidden) and sync
 * it live without wiping the other fields, so switching type mid-edit doesn't lose input.
 * Pass `editing` to prefill + update an existing event, and `onDelete` to offer removal.
 */
export function CalendarEventForm({
  open,
  reason,
  courses,
  professorId,
  editing,
  onSave,
  onCancel,
  onDelete,
}: {
  open: boolean
  reason: BlockReason
  courses: Course[]
  professorId: string
  editing?: BlockedTime | null
  onSave: (blockedTime: BlockedTime) => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const form = useForm<BlockTimeFormValues>({
    resolver: zodResolver(blockTimeFormSchema) as Resolver<BlockTimeFormValues>,
    defaultValues: editing ? valuesFrom(editing) : defaultsFor(reason),
  })

  // Re-seed only on the closed→open transition, so changing the Type (reason) mid-edit does
  // NOT wipe what's already entered. Seeds from the edited event when editing.
  const prevOpen = useRef(false)
  useEffect(() => {
    if (open && !prevOpen.current) form.reset(editing ? valuesFrom(editing) : defaultsFor(reason))
    prevOpen.current = open
  }, [open, reason, editing, form])

  // Keep the hidden reason in sync with the parent's Type selector, without a full reset.
  useEffect(() => {
    form.setValue('reason', reason)
  }, [reason, form])

  const recurrence = useWatch({ control: form.control, name: 'recurrence' })
  const meetingType = useWatch({ control: form.control, name: 'meetingType' })
  const date = useWatch({ control: form.control, name: 'date' })
  const weekday = date ? format(new Date(date + 'T12:00:00'), 'EEEE') : ''

  const onSubmit = useCallback(
    (data: BlockTimeFormValues) => {
      const course = courses.find((c) => c.id === data.courseId)
      const bt: BlockedTime = {
        id: editing?.id ?? generateId(),
        professorId,
        date: data.date,
        startTime: data.startTime,
        endTime: data.endTime,
        reason: data.reason,
        note: data.note,
        courseId: data.courseId,
        courseName: course?.name ?? null,
        courseCode: course?.code ?? null,
        meetingType: data.meetingType,
        // Keep only the detail relevant to the chosen mode (hybrid keeps both; no mode keeps
        // neither), so a later mode switch never leaves a stale location / zoom link.
        location: data.meetingType && data.meetingType !== 'zoom' ? data.location : '',
        zoomLink: data.meetingType && data.meetingType !== 'in_person' ? data.zoomLink : '',
        recurrence: data.recurrence,
        recurrenceUntil: data.recurrence === 'weekly' ? data.recurrenceUntil : null,
        createdAt: nowISO(),
      }
      onSave(bt)
      onCancel()
    },
    [onSave, onCancel, professorId, courses, editing],
  )

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="note"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title (optional)</FormLabel>
              <FormControl>
                <Input placeholder="e.g. CS 546 Lecture" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

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
                    <SelectValue placeholder="No course" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="none">No course</SelectItem>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.code ? `${c.code} — ${c.name}` : c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Date *</FormLabel>
              <FormControl>
                <Input type="date" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-3">
          <FormField
            control={form.control}
            name="startTime"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Start *</FormLabel>
                <FormControl>
                  <Input type="time" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="endTime"
            render={({ field }) => (
              <FormItem>
                <FormLabel>End *</FormLabel>
                <FormControl>
                  <Input type="time" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="meetingType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Meeting type (optional)</FormLabel>
              <Select
                value={field.value ?? MEETING_MODE_NONE}
                onValueChange={(v) =>
                  field.onChange(v === MEETING_MODE_NONE ? null : (v as MeetingType))
                }
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={MEETING_MODE_NONE}>None</SelectItem>
                  {MEETING_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {MEETING_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />

        {meetingType && meetingType !== 'zoom' && (
          <FormField
            control={form.control}
            name="location"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Location</FormLabel>
                <FormControl>
                  <Input placeholder="Gates Hall 402" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {meetingType && meetingType !== 'in_person' && (
          <FormField
            control={form.control}
            name="zoomLink"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Zoom link</FormLabel>
                <FormControl>
                  <Input placeholder="https://zoom.us/j/..." {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="recurrence"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Repeats</FormLabel>
              <Select value={field.value} onValueChange={(v) => field.onChange(v as Recurrence)}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {RECURRENCES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {RECURRENCE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />

        {recurrence === 'weekly' && (
          <FormField
            control={form.control}
            name="recurrenceUntil"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Repeat until (optional)</FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    value={field.value ?? ''}
                    onChange={(e) => field.onChange(e.target.value || null)}
                  />
                </FormControl>
                <FormDescription>
                  {weekday
                    ? `Repeats weekly on ${weekday}. Leave blank for no end date.`
                    : 'Repeats weekly. Leave blank for no end date.'}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          {onDelete ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onDelete}
              className="text-destructive hover:text-destructive"
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">{editing ? 'Save changes' : 'Add to calendar'}</Button>
          </div>
        </div>
      </form>
    </Form>
  )
}
