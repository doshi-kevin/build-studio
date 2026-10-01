'use client'

// Create / edit / delete a student's own personal calendar events. Lives in the
// "Add event" dialog on /student/calendar. Personal events render on the grid via the
// aggregator; this is where they're managed. Single events only (v1 — no recurrence).

import { useState } from 'react'
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
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { toast } from 'sonner'
import { Loader2, Pencil, Plus, Repeat, Star, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { personalEventSchema, type PersonalEventRow } from '@/lib/validations/calendar'
import {
  createPersonalEvent,
  updatePersonalEvent,
  deletePersonalEvent,
  importPersonalEvents,
} from '@/app/(dashboard)/student/calendar/actions'
import { ImportCalendarDialog } from '@/components/shared/ImportCalendarDialog'

interface PersonalEventsManagerProps {
  events: PersonalEventRow[]
  /** When set, open editing this event's id (StudentCalendar remounts on change via a key). */
  initialEditId?: string | null
}

interface FormState {
  title: string
  date: string
  allDay: boolean
  startTime: string
  endTime: string
  note: string
  recurrence: 'none' | 'weekly'
  recurrenceUntil: string
}

const blankForm = (): FormState => ({
  title: '',
  date: format(new Date(), 'yyyy-MM-dd'),
  allDay: false,
  startTime: '09:00',
  endTime: '10:00',
  note: '',
  recurrence: 'none',
  recurrenceUntil: '',
})

function formFromRow(e: PersonalEventRow): FormState {
  return {
    title: e.title,
    date: e.date,
    allDay: e.all_day,
    startTime: e.start_time ?? '09:00',
    endTime: e.end_time ?? '10:00',
    note: e.note ?? '',
    recurrence: e.recurrence,
    recurrenceUntil: e.recurrence_until ?? '',
  }
}

function timeLabel(e: PersonalEventRow): string {
  if (e.all_day) return 'All day'
  if (e.start_time && e.end_time) return `${e.start_time}–${e.end_time}`
  return e.start_time ?? ''
}

export function PersonalEventsManager({ events, initialEditId = null }: PersonalEventsManagerProps) {
  const router = useRouter()
  const initial = initialEditId ? events.find((e) => e.id === initialEditId) : null
  const [form, setForm] = useState<FormState>(() => (initial ? formFromRow(initial) : blankForm()))
  const [editingId, setEditingId] = useState<string | null>(initial ? initial.id : null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  // Import via the shared dialog, then refresh so the grid + list pick up the new events.
  const importAndRefresh = async (
    evts: { summary: string; description: string; location: string; dtstart: string; dtend: string }[],
  ) => {
    const res = await importPersonalEvents(evts)
    if (!res.error) router.refresh()
    return res
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const resetForm = () => {
    setForm(blankForm())
    setEditingId(null)
    setError(null)
  }

  const startEdit = (e: PersonalEventRow) => {
    setEditingId(e.id)
    setError(null)
    setForm(formFromRow(e))
  }

  const handleSubmit = async () => {
    const parsed = personalEventSchema.safeParse(form)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check the form')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const res = editingId
        ? await updatePersonalEvent(editingId, parsed.data)
        : await createPersonalEvent(parsed.data)
      if (res.error) {
        toast.error(res.error)
        return
      }
      toast.success(editingId ? 'Event updated' : 'Event added')
      resetForm()
      router.refresh()
    } catch {
      toast.error('Something went wrong — please try again.')
    } finally {
      setSaving(false)
    }
  }

  /* Office hours in the same product area confirm before deleting; this deleted on one
     click, permanently (#713 part 2). Holds the whole event so the dialog can name it —
     "Delete this event?" is a worse question than "Delete Gym?". */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null)

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      const res = await deletePersonalEvent(id)
      if (res.error) {
        toast.error(res.error)
        return
      }
      toast.success('Event deleted')
      setPendingDelete(null)
      if (editingId === id) resetForm()
      router.refresh()
    } catch {
      toast.error('Couldn’t delete that event — please try again.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          Import .ics
        </Button>
      </div>

      {/* Form */}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="pe-title">Title</Label>
          <Input
            id="pe-title"
            value={form.title}
            maxLength={120}
            placeholder="e.g. Study for midterm"
            onChange={(e) => set('title', e.target.value)}
          />
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="pe-date">Date</Label>
            <Input
              id="pe-date"
              type="date"
              value={form.date}
              onChange={(e) => set('date', e.target.value)}
              className="w-auto"
            />
          </div>

          {!form.allDay && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="pe-start">Start</Label>
                <Input
                  id="pe-start"
                  type="time"
                  value={form.startTime}
                  onChange={(e) => set('startTime', e.target.value)}
                  className="w-auto"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pe-end">End</Label>
                <Input
                  id="pe-end"
                  type="time"
                  value={form.endTime}
                  onChange={(e) => set('endTime', e.target.value)}
                  className="w-auto"
                />
              </div>
            </>
          )}

          <label className="flex items-center gap-2 pb-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={form.allDay}
              onChange={(e) => set('allDay', e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            All day
          </label>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="pe-repeat">Repeats</Label>
            <select
              id="pe-repeat"
              value={form.recurrence}
              onChange={(e) => set('recurrence', e.target.value as 'none' | 'weekly')}
              className="flex h-9 w-auto rounded-xl border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="none">Doesn&apos;t repeat</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          {form.recurrence === 'weekly' && (
            <div className="space-y-1.5">
              <Label htmlFor="pe-until">Until</Label>
              <Input
                id="pe-until"
                type="date"
                value={form.recurrenceUntil}
                onChange={(e) => set('recurrenceUntil', e.target.value)}
                className="w-auto"
              />
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pe-note">Note (optional)</Label>
          <textarea
            id="pe-note"
            value={form.note}
            maxLength={500}
            rows={2}
            placeholder="Anything to remember…"
            onChange={(e) => set('note', e.target.value)}
            className="flex w-full rounded-xl border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center gap-2">
          <Button onClick={handleSubmit} disabled={saving} size="sm">
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : editingId ? (
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
            ) : (
              <Plus className="h-3.5 w-3.5 mr-1.5" />
            )}
            {editingId ? 'Save changes' : 'Add event'}
          </Button>
          {editingId && (
            <Button onClick={resetForm} variant="ghost" size="sm" disabled={saving}>
              <X className="h-3.5 w-3.5 mr-1.5" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Existing events */}
      <div className="border-t border-border pt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Your events
        </h3>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No personal events yet.</p>
        ) : (
          <ul className="space-y-1.5 max-h-56 overflow-y-auto">
            {events.map((e) => (
              <li
                key={e.id}
                className="flex items-center gap-2 rounded-xl border border-border px-3 py-2"
              >
                <Star className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{e.title}</p>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>
                      {format(new Date(`${e.date}T00:00:00`), 'EEE, MMM d')} · {timeLabel(e)}
                    </span>
                    {e.recurrence === 'weekly' && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-primary">
                        <Repeat className="h-3 w-3" />
                        Weekly
                      </span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Edit event"
                  onClick={() => startEdit(e)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Delete event"
                  disabled={deletingId === e.id}
                  onClick={() => setPendingDelete({ id: e.id, title: e.title })}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive-muted hover:text-destructive disabled:opacity-50"
                >
                  {deletingId === e.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ImportCalendarDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        importFn={importAndRefresh}
        noun="personal events"
      />

      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => { if (!o) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{pendingDelete?.title}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the event from your calendar. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingId !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingDelete) void handleDelete(pendingDelete.id) }}
              disabled={deletingId !== null}
              variant="destructive"
            >
              {deletingId !== null ? 'Deleting…' : 'Delete event'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
