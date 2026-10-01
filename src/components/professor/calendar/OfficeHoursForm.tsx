'use client'

import { useCallback, useEffect } from 'react'
import { useForm, useWatch, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  DAYS_OF_WEEK,
  DAY_LABELS,
  SLOT_DURATIONS,
  SLOT_DURATION_LABELS,
  MEETING_TYPES,
  MEETING_TYPE_LABELS,
  BUFFER_OPTIONS,
  createOfficeHoursFormSchema,
  type CreateOfficeHoursFormValues,
  type OfficeHours,
  type DayOfWeek,
  type MeetingType,
} from '@/lib/validations/calendar'
import { generateId, nowISO } from '@/lib/quiz/utils'

interface Course {
  id: string
  name: string
  code: string | null
}

const blankDefaults = (): CreateOfficeHoursFormValues => ({
  title: '',
  courseId: null,
  dayOfWeek: 'monday',
  startTime: '10:00',
  endTime: '12:00',
  slotDuration: 30,
  bufferMinutes: 0,
  meetingType: 'in_person',
  location: '',
  zoomLink: '',
  effectiveFrom: new Date().toISOString().split('T')[0],
  effectiveUntil: null,
})

/**
 * The office-hours create/edit form body (no dialog chrome). Shared by CreateOfficeHoursDialog
 * (edit) and AddToCalendarDialog (the "Office hours" type), so office-hours fields live in one
 * place. `open` drives the re-seed effect since RHF defaultValues are captured once.
 */
export function OfficeHoursForm({
  open,
  courses,
  professorId,
  professorName,
  onSave,
  onCancel,
  editing,
}: {
  open: boolean
  courses: Course[]
  professorId: string
  professorName: string
  onSave: (officeHours: OfficeHours) => void | Promise<void>
  onCancel: () => void
  editing?: OfficeHours | null
}) {
  const form = useForm<CreateOfficeHoursFormValues>({
    resolver: zodResolver(createOfficeHoursFormSchema) as Resolver<CreateOfficeHoursFormValues>,
    defaultValues: blankDefaults(),
  })

  // Drives which of Location / Zoom-link is shown + required.
  const meetingType = useWatch({ control: form.control, name: 'meetingType' })

  // Pre-fill when editing, blank when creating — re-applied on every open, since RHF
  // defaultValues are captured once and would otherwise go stale.
  useEffect(() => {
    if (!open) return
    form.reset(
      editing
        ? {
            title: editing.title,
            courseId: editing.courseId,
            dayOfWeek: editing.dayOfWeek,
            startTime: editing.startTime,
            endTime: editing.endTime,
            slotDuration: editing.slotDuration,
            bufferMinutes: editing.bufferMinutes,
            meetingType: editing.meetingType,
            location: editing.location,
            zoomLink: editing.zoomLink,
            effectiveFrom: editing.effectiveFrom,
            effectiveUntil: editing.effectiveUntil,
          }
        : blankDefaults(),
    )
  }, [open, editing, form])

  /* ASYNC on purpose (#713 part 5). Double-clicking "Create office hours" produced two
     identical templates: the handler was synchronous, so react-hook-form's isSubmitting
     flipped straight back and both clicks got through, each calling generateId() and
     creating a genuinely separate row. An async handler makes handleSubmit hold
     isSubmitting for the whole call and drop re-entrant submits, which is the library's own
     guard — better than a hand-rolled ref, which the lint rightly flags for being read from
     a render-time callback. */
  const onSubmit = useCallback(
    async (data: CreateOfficeHoursFormValues) => {
      const course = courses.find((c) => c.id === data.courseId)
      const now = nowISO()

      const oh: OfficeHours = {
        id: editing?.id ?? generateId(),
        professorId,
        professorName,
        title: data.title,
        courseId: data.courseId,
        courseName: course?.name ?? null,
        courseCode: course?.code ?? null,
        dayOfWeek: data.dayOfWeek,
        startTime: data.startTime,
        endTime: data.endTime,
        slotDuration: data.slotDuration,
        bufferMinutes: data.bufferMinutes,
        meetingType: data.meetingType,
        // Persist only the detail relevant to the chosen mode so switching (e.g. hybrid →
        // in-person) never leaves a stale zoom link / location on the row. Hybrid keeps both.
        location: data.meetingType === 'zoom' ? '' : data.location,
        zoomLink: data.meetingType === 'in_person' ? '' : data.zoomLink,
        isActive: true,
        effectiveFrom: data.effectiveFrom,
        effectiveUntil: data.effectiveUntil,
        createdAt: now,
        updatedAt: now,
      }

      await onSave(oh)
      onCancel()
    },
    [onSave, onCancel, courses, professorId, professorName, editing],
  )

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title *</FormLabel>
              <FormControl>
                <Input placeholder="CS 4780 Office Hours" {...field} />
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
                    <SelectValue placeholder="General" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="none">General (no course)</SelectItem>
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

        <div className="grid grid-cols-3 gap-3">
          <FormField
            control={form.control}
            name="dayOfWeek"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Day *</FormLabel>
                <Select value={field.value} onValueChange={(v) => field.onChange(v as DayOfWeek)}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {DAYS_OF_WEEK.map((d) => (
                      <SelectItem key={d} value={d}>
                        {DAY_LABELS[d]}
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

        <div className="grid grid-cols-2 gap-3">
          <FormField
            control={form.control}
            name="slotDuration"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Slot duration</FormLabel>
                <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {SLOT_DURATIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {SLOT_DURATION_LABELS[d]}
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
            name="bufferMinutes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Buffer between</FormLabel>
                <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {BUFFER_OPTIONS.map((b) => (
                      <SelectItem key={b} value={String(b)}>
                        {b === 0 ? 'No buffer' : `${b} min`}
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
          name="meetingType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Meeting type</FormLabel>
              <Select value={field.value} onValueChange={(v) => field.onChange(v as MeetingType)}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {MEETING_TYPES.map((t) => (
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

        {meetingType !== 'zoom' && (
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

        {meetingType !== 'in_person' && (
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

        <div className="grid grid-cols-2 gap-3">
          <FormField
            control={form.control}
            name="effectiveFrom"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Effective from *</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="effectiveUntil"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Until (optional)</FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    value={field.value ?? ''}
                    onChange={(e) => field.onChange(e.target.value || null)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Saving…' : editing ? 'Save changes' : 'Create office hours'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
