// Student office hours booking page — selects a professor, shows available slots,
// and lets the student book a meeting. Includes auto-selection indicator for clarity.
'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { startOfWeek, addDays } from 'date-fns'
import { toast } from 'sonner'
import { Info } from 'lucide-react'
import { PageHeader } from '@/components/professor/PageHeader'
import { BookingProvider, useBooking } from './office-hours-context'
import { ProfessorSelector } from './ProfessorSelector'
import { AvailableSlotsList } from './AvailableSlotsList'
import { BookSlotDialog } from './BookSlotDialog'
import { MyBookingsPanel } from './MyBookingsPanel'
import { generateAllSlots } from '@/lib/calendar/utils'
import { createBooking, cancelBooking, getStudentBooking } from '@/app/(dashboard)/student/office-hours/actions'
import { createClient } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'
import type { OfficeHours, Booking, BlockedTime, Slot } from '@/lib/validations/calendar'

// ── Props ────────────────────────────────────────────────────

interface OfficeHoursBookingProps {
  studentId: string
  studentName: string
  studentEmail: string
  courses: { id: string; name: string; code: string }[]
  initialOfficeHours: OfficeHours[]
  initialBookings: Booking[]
  /** Every active booking on these office hours, own + others', occupancy only (#712). */
  initialOccupancy: Booking[]
  initialBlockedTimes: BlockedTime[]
}

// ── Data Loader ───────────────────────────────────────────────

function BookingDataLoader({
  officeHours,
  bookings,
  blockedTimes,
  slots,
}: {
  officeHours: OfficeHours[]
  bookings: Booking[]
  blockedTimes: BlockedTime[]
  slots: Slot[]
}) {
  const { dispatch } = useBooking()

  useEffect(() => {
    dispatch({
      type: 'SET_DATA',
      payload: { officeHours, bookings, blockedTimes, slots },
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return null
}

// A bookings row from getStudentBooking carries a joined professor profile.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDbBooking(row: any, studentName: string, studentEmail: string): Booking {
  const prof = Array.isArray(row.professor) ? row.professor[0] : row.professor
  return {
    id: row.id,
    slotId: '',
    officeHoursId: row.office_hours_id,
    professorId: row.professor_id,
    professorName: prof?.name || 'Professor',
    studentId: row.student_id,
    studentName,
    studentEmail,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    title: row.title,
    courseId: row.course_id,
    courseName: row.course_name,
    courseCode: row.course_code,
    meetingType: row.meeting_type,
    purpose: row.purpose,
    studentNote: row.student_note,
    professorNote: row.professor_note,
    location: row.location,
    zoomLink: row.zoom_link,
    status: row.status,
    cancelledBy: row.cancelled_by,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── Realtime: live-update this student's bookings ─────────────

// Reflects a change to the student's own booking (e.g. the professor cancels or updates
// it) without a manual reload. RLS scopes events to the student's own bookings; the reducer
// upsert feeds slot regeneration + the My Bookings panel.
function BookingRealtime({
  studentId,
  studentName,
  studentEmail,
}: {
  studentId: string
  studentName: string
  studentEmail: string
}) {
  const { dispatch } = useBooking()

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
          .channel(`student-bookings:${studentId}`)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'bookings', filter: `student_id=eq.${studentId}` },
            (payload) => {
              const row = payload.new as { id?: string } | null
              if (!row?.id) return
              // The realtime payload has no professor join — enrich before dispatch.
              void getStudentBooking(row.id).then((res) => {
                if (res.data) {
                  dispatch({ type: 'ADD_BOOKING', payload: { booking: mapDbBooking(res.data, studentName, studentEmail) } })
                }
              })
            },
          )
          .subscribe()
        cleanup = () => supabase.removeChannel(channel)
      } catch (err) {
        logger.error('student BookingRealtime: subscribe failed', err, { studentId })
      }
    })()

    return () => {
      mounted = false
      cleanup?.()
    }
  }, [studentId, studentName, studentEmail, dispatch])

  return null
}

// ── Inner Component (consumes context) ────────────────────────

function BookingInner({
  studentId,
  studentName,
  studentEmail,
  courses,
  occupancy,
}: {
  studentId: string
  studentName: string
  studentEmail: string
  courses: { id: string; name: string; code: string }[]
  /* Own + others' active bookings, occupancy only. Kept as a PROP rather than pushed into
     the reducer: state.bookings feeds "My bookings", and mixing classmates' rows into it
     would list them as the viewer's own (#712). */
  occupancy: Booking[]
}) {
  const { state, dispatch } = useBooking()

  const [bookDialogOpen, setBookDialogOpen] = useState(false)

  // Derived arrays
  const allOfficeHours = useMemo(() => Object.values(state.officeHours), [state.officeHours])
  const allBookings = useMemo(() => Object.values(state.bookings), [state.bookings])
  const allBlockedTimes = useMemo(() => Object.values(state.blockedTimes), [state.blockedTimes])
  const allSlots = useMemo(() => Object.values(state.slots), [state.slots])

  // Student's own bookings
  const myBookings = useMemo(
    () => allBookings.filter((b) => b.studentId === studentId),
    [allBookings, studentId],
  )

  // Selected slot + its office hours template
  const selectedSlot = state.selectedSlotId ? state.slots[state.selectedSlotId] ?? null : null
  const selectedSlotOH = selectedSlot
    ? state.officeHours[selectedSlot.officeHoursId] ?? null
    : null

  // Resolve the selected professor's name for the info banner
  const selectedProfessorName = useMemo(() => {
    if (!state.selectedProfessorId) return null
    const oh = allOfficeHours.find((o) => o.professorId === state.selectedProfessorId)
    return oh?.professorName ?? null
  }, [state.selectedProfessorId, allOfficeHours])

  // Regenerate slots for the 2-week window
  useEffect(() => {
    const now = new Date()
    const monday = startOfWeek(now, { weekStartsOn: 1 })
    const rangeEnd = addDays(monday, 13)

    /* Occupancy, not just the viewer's own bookings (#712) — otherwise a slot a
       classmate already took renders as available and inflates the count. */
    const slots = generateAllSlots(
      allOfficeHours,
      monday,
      rangeEnd,
      occupancy,
      allBlockedTimes,
    )

    dispatch({ type: 'SET_SLOTS', payload: { slots } })
  }, [allOfficeHours, occupancy, allBlockedTimes, dispatch])

  /* `?professor=` / `?date=` — Athena proposing office hours (design doc §14,
     C10). She resolved both server-side: the professor of the course she was
     answering about, and the next day they actually hold hours, which is
     usually not today. The drafted note travels separately, out of the URL, and
     lands in the booking dialog.

     A professor with no active office hours here is ignored rather than
     selected — a stale link must not empty the page. Applied once, so the
     student can pick a different professor afterwards and it stays picked. */
  const searchParams = useSearchParams()
  const proposedProfessor = searchParams.get('professor')
  const proposedDate = searchParams.get('date')
  const appliedProposalRef = useRef<string | null>(null)
  const proposalKey = `${proposedProfessor ?? ''}|${proposedDate ?? ''}`
  /* In an effect, not during render: `dispatch` belongs to `BookingProvider`, an
     ancestor. Adjusting state during render is only sanctioned for state the
     RENDERING component owns; updating an ancestor store here trips React's
     "cannot update a component while rendering a different component" warning and,
     under concurrent rendering, could fire for a discarded render. The applied-key
     guard is a ref, not state — it's only a "did this run" flag, never rendered,
     so it doesn't need to trigger a re-render (and keeps setState out of the
     effect). It still makes the proposal apply exactly once, so a later manual
     professor pick stays. */
  useEffect(() => {
    if (
      !proposedProfessor ||
      proposalKey === appliedProposalRef.current ||
      !allOfficeHours.some((oh) => oh.professorId === proposedProfessor && oh.isActive)
    )
      return
    appliedProposalRef.current = proposalKey
    dispatch({ type: 'SELECT_PROFESSOR', payload: { professorId: proposedProfessor } })
    if (proposedDate) dispatch({ type: 'SELECT_DATE', payload: { date: proposedDate } })
  }, [proposedProfessor, proposedDate, proposalKey, allOfficeHours, dispatch])

  // Auto-select first professor if none selected
  useEffect(() => {
    if (state.selectedProfessorId) return
    const profIds = new Set(allOfficeHours.filter((oh) => oh.isActive).map((oh) => oh.professorId))
    const first = profIds.values().next().value
    if (first) {
      dispatch({ type: 'SELECT_PROFESSOR', payload: { professorId: first } })
    }
  }, [allOfficeHours, state.selectedProfessorId, dispatch])

  // Handlers
  const handleSelectProfessor = useCallback(
    (professorId: string) => {
      dispatch({ type: 'SELECT_PROFESSOR', payload: { professorId } })
    },
    [dispatch],
  )

  const handleSelectDate = useCallback(
    (date: string) => {
      dispatch({ type: 'SELECT_DATE', payload: { date } })
    },
    [dispatch],
  )

  const handleSelectSlot = useCallback(
    (slotId: string) => {
      dispatch({ type: 'SELECT_SLOT', payload: { slotId } })
      setBookDialogOpen(true)
    },
    [dispatch],
  )

  const handleBook = useCallback(
    async (booking: Booking) => {
      const res = await createBooking({
        officeHoursId: booking.officeHoursId,
        date: booking.date,
        startTime: booking.startTime,
        endTime: booking.endTime,
        title: booking.title,
        courseId: booking.courseId,
        courseName: booking.courseName,
        courseCode: booking.courseCode,
        meetingType: booking.meetingType,
        purpose: booking.purpose,
        studentNote: booking.studentNote,
      })
      if (res.error || !res.data) {
        toast.error(res.error ?? 'Could not book this slot')
        return
      }
      // Keep the dialog's display fields, swap in the real DB id so a later cancel
      // hits the right row. On reload SET_DATA re-hydrates from the DB.
      dispatch({ type: 'ADD_BOOKING', payload: { booking: { ...booking, id: res.data.id } } })
      toast.success('Booking confirmed!')
      setBookDialogOpen(false)
    },
    [dispatch],
  )

  const handleCancelBooking = useCallback(
    async (bookingId: string) => {
      const res = await cancelBooking(bookingId, 'Cancelled by student')
      if (res.error) {
        toast.error(res.error)
        return
      }
      dispatch({ type: 'CANCEL_BOOKING', payload: { bookingId, reason: 'Cancelled by student' } })
      toast.success('Booking cancelled')
    },
    [dispatch],
  )

  const handleViewModeChange = useCallback(
    (mode: 'upcoming' | 'history') => {
      dispatch({ type: 'SET_VIEW_MODE', payload: { mode } })
    },
    [dispatch],
  )

  return (
    <div className="space-y-6 overflow-hidden">
      <PageHeader
        title="Office Hours"
        description="Browse available office hours and book a meeting with your professor."
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
        {/* Left panel: Professor selector + available slots */}
        <div className="space-y-6">
          <ProfessorSelector
            officeHours={allOfficeHours}
            slots={allSlots}
            selectedProfessorId={state.selectedProfessorId}
            onSelect={handleSelectProfessor}
          />

          {/* Info banner showing which professor's slots are displayed */}
          {selectedProfessorName && (
            <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
              <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <p className="text-xs text-muted-foreground">
                Showing slots for <span className="font-medium text-foreground">{selectedProfessorName}</span>. Select a different professor above to change.
              </p>
            </div>
          )}

          {state.selectedProfessorId && (
            <AvailableSlotsList
              slots={allSlots}
              officeHours={allOfficeHours}
              professorId={state.selectedProfessorId}
              selectedDate={state.selectedDate}
              onSelectDate={handleSelectDate}
              onSelectSlot={handleSelectSlot}
            />
          )}
        </div>

        {/* Right panel: My bookings */}
        <div>
          <MyBookingsPanel
            bookings={myBookings}
            viewMode={state.viewMode}
            onViewModeChange={handleViewModeChange}
            onCancelBooking={handleCancelBooking}
          />
        </div>
      </div>

      {/* Book slot dialog */}
      <BookSlotDialog
        open={bookDialogOpen}
        onOpenChange={(open) => {
          setBookDialogOpen(open)
          if (!open) dispatch({ type: 'SELECT_SLOT', payload: { slotId: null } })
        }}
        slot={selectedSlot}
        officeHours={selectedSlotOH}
        courses={courses}
        studentId={studentId}
        studentName={studentName}
        studentEmail={studentEmail}
        onBook={handleBook}
      />
    </div>
  )
}

// ── Outer Orchestrator ────────────────────────────────────────

export function OfficeHoursBooking({
  studentId,
  studentName,
  studentEmail,
  courses,
  initialOfficeHours,
  initialBookings,
  initialOccupancy,
  initialBlockedTimes,
}: OfficeHoursBookingProps) {
  return (
    <BookingProvider>
      <BookingDataLoader
        officeHours={initialOfficeHours}
        bookings={initialBookings}
        blockedTimes={initialBlockedTimes}
        slots={[]}
      />
      <BookingRealtime studentId={studentId} studentName={studentName} studentEmail={studentEmail} />
      <BookingInner
        studentId={studentId}
        studentName={studentName}
        studentEmail={studentEmail}
        courses={courses}
        occupancy={initialOccupancy}
      />
    </BookingProvider>
  )
}
