'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { addDays, subDays, addWeeks, subWeeks, addMonths, subMonths, startOfWeek, endOfWeek } from 'date-fns'
import { toast } from 'sonner'
import { CalendarProvider, useCalendar } from './calendar-context'
import { PageHeader } from '@/components/professor/PageHeader'
import { CalendarToolbar } from './CalendarToolbar'
import { WeekView } from './WeekView'
import { DayView } from './DayView'
import { MonthView } from './MonthView'
import { CreateOfficeHoursDialog } from './CreateOfficeHoursDialog'
import { AddToCalendarDialog } from './AddToCalendarDialog'
import { EditEventDialog } from './EditEventDialog'
import { MeetingDetailDialog } from './MeetingDetailDialog'
import { CancelMeetingDialog } from './CancelMeetingDialog'
import { generateAllSlots, expandBlockedTimes, formatTimeDisplay, formatDateISO } from '@/lib/calendar/utils'
import {
  createOfficeHours,
  updateOfficeHours,
  toggleOfficeHoursActive,
  createBlockedTime,
  updateBlockedTime,
  deleteBlockedTime,
  updateProfessorNote,
  markBookingStatus,
  cancelBooking,
  getProfessorBooking,
} from '@/app/(dashboard)/professor/calendar/actions'
import { createClient } from '@/lib/supabase/client'
import type { StudentCalendarEvent } from '@/lib/calendar/student-events'
import type { OfficeHoursChip } from '@/lib/calendar/professor-events'
import { logger } from '@/lib/logger'
import { Button } from '@/components/ui/button'
import { Pencil, Trash2 } from 'lucide-react'
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
import { DAY_LABELS, MEETING_TYPE_LABELS } from '@/lib/validations/calendar'
import type { OfficeHours, Booking, BlockedTime } from '@/lib/validations/calendar'
import type { DbOfficeHours, DbBooking, DbBlockedTime } from '@/lib/supabase/types'

// ── DB → App Type Mappers ────────────────────────────────────

function mapDbOfficeHours(row: DbOfficeHours, professorName: string): OfficeHours {
  return {
    id: row.id,
    professorId: row.professor_id,
    professorName,
    title: row.title,
    courseId: row.course_id,
    courseName: row.course_name,
    courseCode: row.course_code,
    dayOfWeek: row.day_of_week as OfficeHours['dayOfWeek'],
    startTime: row.start_time,
    endTime: row.end_time,
    slotDuration: row.slot_duration,
    bufferMinutes: row.buffer_minutes,
    meetingType: row.meeting_type as OfficeHours['meetingType'],
    location: row.location,
    zoomLink: row.zoom_link,
    isActive: row.is_active,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// A bookings row may carry a joined student profile (getBookingsForProfessor selects it).
type DbBookingRow = DbBooking & {
  student?:
    | { name: string | null; email: string | null }
    | { name: string | null; email: string | null }[]
    | null
}

function mapDbBooking(row: DbBookingRow): Booking {
  const student = Array.isArray(row.student) ? row.student[0] : row.student
  return {
    id: row.id,
    slotId: '',
    officeHoursId: row.office_hours_id,
    professorId: row.professor_id,
    professorName: '',
    studentId: row.student_id,
    studentName: student?.name ?? '',
    studentEmail: student?.email ?? '',
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    title: row.title,
    courseId: row.course_id,
    courseName: row.course_name,
    courseCode: row.course_code,
    meetingType: row.meeting_type as Booking['meetingType'],
    purpose: row.purpose as Booking['purpose'],
    studentNote: row.student_note,
    professorNote: row.professor_note,
    location: row.location,
    zoomLink: row.zoom_link,
    status: row.status as Booking['status'],
    cancelledBy: row.cancelled_by as Booking['cancelledBy'],
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapDbBlockedTime(row: DbBlockedTime): BlockedTime {
  // course/meeting + recurrence columns are added by migrations not yet in the generated types.
  const r = row as DbBlockedTime & {
    course_id?: string | null
    course_name?: string | null
    course_code?: string | null
    meeting_type?: string | null
    location?: string | null
    zoom_link?: string | null
    recurrence?: string
    recurrence_until?: string | null
  }
  return {
    id: row.id,
    professorId: row.professor_id,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    reason: row.reason as BlockedTime['reason'],
    note: row.note,
    courseId: r.course_id ?? null,
    courseName: r.course_name ?? null,
    courseCode: r.course_code ?? null,
    meetingType: (r.meeting_type as BlockedTime['meetingType']) ?? null,
    location: r.location ?? '',
    zoomLink: r.zoom_link ?? '',
    recurrence: (r.recurrence as BlockedTime['recurrence']) ?? 'none',
    recurrenceUntil: r.recurrence_until ?? null,
    createdAt: row.created_at,
  }
}

// ── Props ────────────────────────────────────────────────────

interface CalendarManagerProps {
  professorId: string
  professorName: string
  courses: { id: string; name: string; code: string }[]
  initialOfficeHours: DbOfficeHours[]
  initialBookings: DbBooking[]
  initialBlockedTimes: DbBlockedTime[]
  /** Class sessions + assignment/quiz due dates — read-only, same source as the dashboard mini calendar. */
  readOnlyEvents: StudentCalendarEvent[]
  /** Expanded office-hours occurrences, for Month view only (Week/Day derive them from slots). */
  officeHoursOccurrences: OfficeHoursChip[]
}

// ── Data Loader ───────────────────────────────────────────────

function CalendarDataLoader({
  officeHours,
  bookings,
  blockedTimes,
  slots,
}: {
  officeHours: OfficeHours[]
  bookings: Booking[]
  blockedTimes: BlockedTime[]
  slots: import('@/lib/validations/calendar').Slot[]
}) {
  const { dispatch } = useCalendar()

  useEffect(() => {
    dispatch({
      type: 'SET_DATA',
      payload: { officeHours, bookings, blockedTimes, slots },
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return null
}

// ── Realtime: live-update bookings ────────────────────────────

// Reflects a student's booking (or cancellation) on the professor's calendar without a
// manual refresh. RLS scopes events to this professor's own bookings; the reducer upsert
// feeds the slot-regeneration effect, which redraws the grid.
function BookingRealtime({ professorId }: { professorId: string }) {
  const { dispatch } = useCalendar()

  useEffect(() => {
    const supabase = createClient()
    let mounted = true
    let cleanup: (() => void) | null = null

    ;(async () => {
      try {
        const { data: sess } = await supabase.auth.getSession()
        if (!mounted) return
        const token = sess.session?.access_token
        if (token) supabase.realtime.setAuth(token)
        const channel = supabase
          .channel(`calendar-bookings:${professorId}`)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'bookings', filter: `professor_id=eq.${professorId}` },
            (payload) => {
              const row = payload.new as DbBooking | null
              if (!row?.id) return
              // The realtime payload has no student join — enrich it so the card shows
              // WHO booked, not just the title. Falls back to the bare row on failure.
              void getProfessorBooking(row.id).then((res) => {
                dispatch({ type: 'ADD_BOOKING', payload: { booking: mapDbBooking(res.data ?? row) } })
              })
            },
          )
          .subscribe()
        cleanup = () => supabase.removeChannel(channel)
      } catch (err) {
        logger.error('BookingRealtime: subscribe failed', err, { professorId })
      }
    })()

    return () => {
      mounted = false
      cleanup?.()
    }
  }, [professorId, dispatch])

  return null
}

// ── Inner Component (consumes context) ────────────────────────

function CalendarInner({
  professorId,
  professorName,
  courses,
  readOnlyEvents,
  officeHoursOccurrences,
}: {
  professorId: string
  professorName: string
  courses: { id: string; name: string; code: string }[]
  readOnlyEvents: StudentCalendarEvent[]
  officeHoursOccurrences: OfficeHoursChip[]
}) {
  const { state, dispatch } = useCalendar()

  // Dialog states
  const [createOHOpen, setCreateOHOpen] = useState(false)
  const [editingOH, setEditingOH] = useState<OfficeHours | null>(null)
  const [ohToDelete, setOhToDelete] = useState<OfficeHours | null>(null)
  const [blockedToDelete, setBlockedToDelete] = useState<BlockedTime | null>(null)
  const [eventToEdit, setEventToEdit] = useState<BlockedTime | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false)
  const [bookingToCancel, setBookingToCancel] = useState<Booking | null>(null)

  // Derived data
  const allOfficeHours = useMemo(() => Object.values(state.officeHours), [state.officeHours])
  const allBookings = useMemo(() => Object.values(state.bookings), [state.bookings])
  const allBlockedTimes = useMemo(() => Object.values(state.blockedTimes), [state.blockedTimes])
  const allSlots = useMemo(() => Object.values(state.slots), [state.slots])
  const currentDate = useMemo(() => new Date(state.currentDate + 'T12:00:00'), [state.currentDate])

  // A recurring event is stored as one row; expand it into concrete per-date occurrences for
  // the visible range so each week/day the series repeats shows a card.
  const visibleBlockedTimes = useMemo(() => {
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 })
    const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 })
    const rangeStart = state.viewMode === 'month' ? subDays(weekStart, 35) : subDays(weekStart, 1)
    const rangeEnd = state.viewMode === 'month' ? addDays(weekEnd, 35) : addDays(weekEnd, 1)
    return expandBlockedTimes(allBlockedTimes, rangeStart, rangeEnd)
  }, [allBlockedTimes, currentDate, state.viewMode])

  const selectedBooking = state.selectedBookingId
    ? state.bookings[state.selectedBookingId] ?? null
    : null

  // Filter bookings by course if filter is set
  const filteredBookings = useMemo(() => {
    if (!state.filterCourseId) return allBookings
    return allBookings.filter((b) => b.courseId === state.filterCourseId)
  }, [allBookings, state.filterCourseId])

  // Regenerate slots when the visible date range or office hours change
  useEffect(() => {
    const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 })
    const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 })

    // For month view, extend the range
    const rangeStart = state.viewMode === 'month' ? subDays(weekStart, 35) : subDays(weekStart, 1)
    const rangeEnd = state.viewMode === 'month' ? addDays(weekEnd, 35) : addDays(weekEnd, 1)

    const slots = generateAllSlots(
      allOfficeHours,
      rangeStart,
      rangeEnd,
      allBookings,
      allBlockedTimes,
    )

    dispatch({ type: 'SET_SLOTS', payload: { slots } })
  }, [currentDate, allOfficeHours, allBookings, allBlockedTimes, state.viewMode, dispatch])

  /* Navigation dates come from formatDateISO (the LOCAL calendar date), never
     toISOString(), which yields the UTC date and lands a viewer on the wrong day for
     several hours every evening west of UTC and every morning east of it (#711). */
  // Navigation handlers
  const handleNavigatePrev = useCallback(() => {
    const cur = currentDate
    if (state.viewMode === 'day') {
      dispatch({ type: 'SET_CURRENT_DATE', payload: { date: formatDateISO(subDays(cur, 1)) } })
    } else if (state.viewMode === 'week') {
      dispatch({ type: 'SET_CURRENT_DATE', payload: { date: formatDateISO(subWeeks(cur, 1)) } })
    } else {
      dispatch({ type: 'SET_CURRENT_DATE', payload: { date: formatDateISO(subMonths(cur, 1)) } })
    }
  }, [currentDate, state.viewMode, dispatch])

  const handleNavigateNext = useCallback(() => {
    const cur = currentDate
    if (state.viewMode === 'day') {
      dispatch({ type: 'SET_CURRENT_DATE', payload: { date: formatDateISO(addDays(cur, 1)) } })
    } else if (state.viewMode === 'week') {
      dispatch({ type: 'SET_CURRENT_DATE', payload: { date: formatDateISO(addWeeks(cur, 1)) } })
    } else {
      dispatch({ type: 'SET_CURRENT_DATE', payload: { date: formatDateISO(addMonths(cur, 1)) } })
    }
  }, [currentDate, state.viewMode, dispatch])

  const handleNavigateToday = useCallback(() => {
    dispatch({ type: 'SET_CURRENT_DATE', payload: { date: formatDateISO(new Date()) } })
  }, [dispatch])

  // Office hours creation — persists to the DB, then reflects the saved row (real id)
  // in local state. On reload, SET_DATA re-hydrates from the DB, so students (who read
  // the same table) see these office hours.
  const handleSaveOfficeHours = useCallback(
    async (oh: OfficeHours) => {
      const payload = {
        title: oh.title,
        courseId: oh.courseId,
        courseName: oh.courseName,
        courseCode: oh.courseCode,
        dayOfWeek: oh.dayOfWeek,
        startTime: oh.startTime,
        endTime: oh.endTime,
        slotDuration: oh.slotDuration,
        bufferMinutes: oh.bufferMinutes,
        meetingType: oh.meetingType,
        location: oh.location,
        zoomLink: oh.zoomLink,
        effectiveFrom: oh.effectiveFrom,
        effectiveUntil: oh.effectiveUntil,
      }
      if (editingOH) {
        const res = await updateOfficeHours(editingOH.id, payload)
        if (res.error || !res.data) {
          toast.error(res.error ?? 'Could not update office hours')
          return
        }
        dispatch({ type: 'UPDATE_OFFICE_HOURS', payload: { officeHours: mapDbOfficeHours(res.data, professorName) } })
        toast.success(`Office hours "${oh.title}" updated`)
        setEditingOH(null)
      } else {
        const res = await createOfficeHours(payload)
        if (res.error || !res.data) {
          toast.error(res.error ?? 'Could not create office hours')
          return
        }
        dispatch({ type: 'ADD_OFFICE_HOURS', payload: { officeHours: mapDbOfficeHours(res.data, professorName) } })
        toast.success(`Office hours "${oh.title}" created`)
      }
    },
    [dispatch, professorName, editingOH],
  )

  const handleEditOfficeHours = useCallback((oh: OfficeHours) => {
    setEditingOH(oh)
    setCreateOHOpen(true)
  }, [])

  // "Delete" deactivates (is_active=false) instead of hard-deleting: the bookings FK
  // cascades, so a real delete would wipe students' confirmed meetings. Deactivating stops
  // new bookings + hides it everywhere, while keeping existing bookings intact.
  const handleConfirmDeleteOH = useCallback(async () => {
    if (!ohToDelete) return
    const res = await toggleOfficeHoursActive(ohToDelete.id, false)
    if (res.error) {
      toast.error(res.error)
      return
    }
    dispatch({ type: 'REMOVE_OFFICE_HOURS', payload: { id: ohToDelete.id } })
    toast.success('Office hours removed')
    setOhToDelete(null)
  }, [dispatch, ohToDelete])

  // Delete a blocked time (e.g. an imported .ics event) — clicked on the calendar.
  const handleConfirmDeleteBlocked = useCallback(async () => {
    if (!blockedToDelete) return
    const res = await deleteBlockedTime(blockedToDelete.id)
    if (res.error) {
      toast.error(res.error)
      return
    }
    dispatch({ type: 'REMOVE_BLOCKED_TIME', payload: { id: blockedToDelete.id } })
    toast.success('Removed')
    setBlockedToDelete(null)
  }, [dispatch, blockedToDelete])

  // Add a one-off calendar entry (lecture / exam / meeting / personal block). All persist
  // to blocked_times, which occupies the professor's time and blocks overlapping bookings.
  const handleAddEvent = useCallback(
    async (bt: BlockedTime) => {
      const res = await createBlockedTime({
        date: bt.date,
        startTime: bt.startTime,
        endTime: bt.endTime,
        reason: bt.reason,
        note: bt.note,
        courseId: bt.courseId,
        courseName: bt.courseName,
        courseCode: bt.courseCode,
        meetingType: bt.meetingType,
        location: bt.location,
        zoomLink: bt.zoomLink,
        recurrence: bt.recurrence,
        recurrenceUntil: bt.recurrenceUntil,
      })
      if (res.error || !res.data) {
        toast.error(res.error ?? 'Could not add to calendar')
        return
      }
      dispatch({ type: 'ADD_BLOCKED_TIME', payload: { blockedTime: mapDbBlockedTime(res.data) } })
      toast.success('Added to your calendar')
    },
    [dispatch],
  )

  // Edit an existing event (clicked on the calendar). Reuses ADD_BLOCKED_TIME — keyed by id,
  // it overwrites the existing entry in place.
  const handleUpdateEvent = useCallback(
    async (bt: BlockedTime) => {
      const res = await updateBlockedTime(bt.id, {
        date: bt.date,
        startTime: bt.startTime,
        endTime: bt.endTime,
        reason: bt.reason,
        note: bt.note,
        courseId: bt.courseId,
        courseName: bt.courseName,
        courseCode: bt.courseCode,
        meetingType: bt.meetingType,
        location: bt.location,
        zoomLink: bt.zoomLink,
        recurrence: bt.recurrence,
        recurrenceUntil: bt.recurrenceUntil,
      })
      if (res.error || !res.data) {
        toast.error(res.error ?? 'Could not update event')
        return
      }
      dispatch({ type: 'ADD_BLOCKED_TIME', payload: { blockedTime: mapDbBlockedTime(res.data) } })
      toast.success('Event updated')
      setEventToEdit(null)
    },
    [dispatch],
  )

  // Meeting actions
  const handleSelectBooking = useCallback(
    (bookingId: string) => {
      dispatch({ type: 'SELECT_BOOKING', payload: { bookingId } })
    },
    [dispatch],
  )

  const handleUpdateNote = useCallback(
    async (bookingId: string, note: string) => {
      const res = await updateProfessorNote(bookingId, note)
      if (res.error) {
        toast.error(res.error)
        return
      }
      dispatch({ type: 'UPDATE_PROFESSOR_NOTE', payload: { bookingId, note } })
      toast.success('Note saved')
    },
    [dispatch],
  )

  const handleMarkCompleted = useCallback(
    async (bookingId: string) => {
      const res = await markBookingStatus(bookingId, 'completed')
      if (res.error) {
        toast.error(res.error)
        return
      }
      dispatch({ type: 'MARK_BOOKING_STATUS', payload: { bookingId, status: 'completed' } })
      toast.success('Meeting marked as completed')
    },
    [dispatch],
  )

  const handleMarkNoShow = useCallback(
    async (bookingId: string) => {
      const res = await markBookingStatus(bookingId, 'no_show')
      if (res.error) {
        toast.error(res.error)
        return
      }
      dispatch({ type: 'MARK_BOOKING_STATUS', payload: { bookingId, status: 'no_show' } })
      toast.success('Meeting marked as no-show')
    },
    [dispatch],
  )

  const handleCancelConfirm = useCallback(
    async (reason: string) => {
      if (!bookingToCancel) return
      const res = await cancelBooking(bookingToCancel.id, reason)
      if (res.error) {
        toast.error(res.error)
        return
      }
      dispatch({
        type: 'CANCEL_BOOKING',
        payload: { bookingId: bookingToCancel.id, cancelledBy: 'professor', reason },
      })
      toast.success('Meeting cancelled')
      setCancelDialogOpen(false)
      setBookingToCancel(null)
    },
    [dispatch, bookingToCancel],
  )

  const handleMonthSelectDate = useCallback(
    (dateStr: string) => {
      dispatch({ type: 'SET_CURRENT_DATE', payload: { date: dateStr } })
      dispatch({ type: 'SET_VIEW_MODE', payload: { mode: 'day' } })
    },
    [dispatch],
  )

  return (
    <div className="space-y-4 overflow-hidden">
      <PageHeader
        title="Calendar"
        description="Manage your office hours, lectures, and schedule."
      />

      <CalendarToolbar
        viewMode={state.viewMode}
        currentDate={currentDate}
        officeHours={allOfficeHours}
        filterCourseId={state.filterCourseId}
        onViewModeChange={(mode) => dispatch({ type: 'SET_VIEW_MODE', payload: { mode } })}
        onNavigatePrev={handleNavigatePrev}
        onNavigateNext={handleNavigateNext}
        onNavigateToday={handleNavigateToday}
        onFilterCourseChange={(courseId) =>
          dispatch({ type: 'SET_FILTER_COURSE', payload: { courseId } })
        }
        onAddToCalendar={() => {
          // Clear any edit target so the dialog's Office-hours branch creates, never updates.
          setEditingOH(null)
          setAddOpen(true)
        }}
      />

      {/* Views */}
      {state.viewMode === 'week' && (
        <WeekView
          currentDate={currentDate}
          bookings={filteredBookings}
          officeHours={allOfficeHours}
          blockedTimes={visibleBlockedTimes}
          slots={allSlots}
          readOnlyEvents={readOnlyEvents}
          onSelectBooking={handleSelectBooking}
          onSelectOfficeHours={(id) => {
            const oh = state.officeHours[id]
            if (oh) handleEditOfficeHours(oh)
          }}
          onSelectBlocked={(id) => setEventToEdit(state.blockedTimes[id] ?? null)}
        />
      )}
      {state.viewMode === 'day' && (
        <DayView
          currentDate={currentDate}
          bookings={filteredBookings}
          officeHours={allOfficeHours}
          blockedTimes={visibleBlockedTimes}
          slots={allSlots}
          readOnlyEvents={readOnlyEvents}
          onSelectBooking={handleSelectBooking}
          onSelectOfficeHours={(id) => {
            const oh = state.officeHours[id]
            if (oh) handleEditOfficeHours(oh)
          }}
          onSelectBlocked={(id) => setEventToEdit(state.blockedTimes[id] ?? null)}
        />
      )}
      {state.viewMode === 'month' && (
        <MonthView
          currentDate={currentDate}
          bookings={filteredBookings}
          officeHours={allOfficeHours}
          readOnlyEvents={readOnlyEvents}
          officeHoursOccurrences={officeHoursOccurrences}
          onSelectDate={handleMonthSelectDate}
        />
      )}

      {/* Office-hours templates — edit / remove */}
      {allOfficeHours.some((oh) => oh.isActive) && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="mb-2 text-sm font-medium">Your office hours</h3>
          <ul className="divide-y divide-border">
            {allOfficeHours
              .filter((oh) => oh.isActive)
              .map((oh) => (
                <li key={oh.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{oh.title}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {DAY_LABELS[oh.dayOfWeek]} · {formatTimeDisplay(oh.startTime)}–{formatTimeDisplay(oh.endTime)} ·{' '}
                      {MEETING_TYPE_LABELS[oh.meetingType]}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="icon" onClick={() => handleEditOfficeHours(oh)} aria-label={`Edit ${oh.title}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setOhToDelete(oh)} aria-label={`Remove ${oh.title}`}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* Dialogs */}
      <CreateOfficeHoursDialog
        open={createOHOpen}
        onOpenChange={(open) => {
          setCreateOHOpen(open)
          if (!open) setEditingOH(null)
        }}
        courses={courses}
        professorId={professorId}
        professorName={professorName}
        onSave={handleSaveOfficeHours}
        editing={editingOH}
      />

      <AddToCalendarDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        courses={courses}
        professorId={professorId}
        professorName={professorName}
        onSaveOfficeHours={handleSaveOfficeHours}
        onSaveEvent={handleAddEvent}
      />

      <EditEventDialog
        key={eventToEdit?.id ?? 'none'}
        open={!!eventToEdit}
        onOpenChange={(open) => {
          if (!open) setEventToEdit(null)
        }}
        event={eventToEdit}
        courses={courses}
        professorId={professorId}
        onSave={handleUpdateEvent}
        onDelete={() => {
          // Route delete through the existing confirm alert.
          const e = eventToEdit
          setEventToEdit(null)
          setBlockedToDelete(e)
        }}
      />

      <MeetingDetailDialog
        booking={selectedBooking}
        open={!!selectedBooking}
        onOpenChange={(open) => {
          if (!open) dispatch({ type: 'SELECT_BOOKING', payload: { bookingId: null } })
        }}
        allBookings={allBookings}
        onUpdateNote={handleUpdateNote}
        onMarkCompleted={handleMarkCompleted}
        onMarkNoShow={handleMarkNoShow}
        onCancel={(b) => {
          setBookingToCancel(b)
          setCancelDialogOpen(true)
        }}
      />

      <CancelMeetingDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        booking={bookingToCancel}
        onConfirm={handleCancelConfirm}
      />

      <AlertDialog open={!!ohToDelete} onOpenChange={(open) => { if (!open) setOhToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this office hour?</AlertDialogTitle>
            <AlertDialogDescription>
              {ohToDelete?.title} will stop appearing to students and can no longer be booked.
              Existing bookings are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDeleteOH}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!blockedToDelete} onOpenChange={(open) => { if (!open) setBlockedToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this calendar entry?</AlertDialogTitle>
            <AlertDialogDescription>
              {blockedToDelete
                ? `${blockedToDelete.date} · ${blockedToDelete.startTime}–${blockedToDelete.endTime}${blockedToDelete.note ? ` — ${blockedToDelete.note}` : ''}`
                : ''}{' '}
              will be removed. Any office-hours slots it was covering become bookable again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDeleteBlocked}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Outer Orchestrator ────────────────────────────────────────

export function CalendarManager({
  professorId,
  professorName,
  courses,
  initialOfficeHours,
  initialBookings,
  initialBlockedTimes,
  readOnlyEvents,
  officeHoursOccurrences,
}: CalendarManagerProps) {
  // Map DB rows to app types
  const officeHours = useMemo(
    () => initialOfficeHours.map((r) => mapDbOfficeHours(r, professorName)),
    [initialOfficeHours, professorName],
  )
  const bookings = useMemo(
    () => initialBookings.map(mapDbBooking),
    [initialBookings],
  )
  const blockedTimes = useMemo(
    () => initialBlockedTimes.map(mapDbBlockedTime),
    [initialBlockedTimes],
  )

  return (
    <CalendarProvider>
      <CalendarDataLoader
        officeHours={officeHours}
        bookings={bookings}
        blockedTimes={blockedTimes}
        slots={[]}
      />
      <BookingRealtime professorId={professorId} />
      <CalendarInner
        professorId={professorId}
        professorName={professorName}
        courses={courses}
        readOnlyEvents={readOnlyEvents}
        officeHoursOccurrences={officeHoursOccurrences}
      />
    </CalendarProvider>
  )
}
