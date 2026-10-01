'use client'

// Schedule a live classroom ahead of time. One dialog for both:
//  • one-off — pick a date/time, optionally upload slides (rendered in the
//    background so nothing blocks the professor);
//  • weekly — pick weekdays + an end date; occurrences are created up front and
//    each gets its deck at its own pre-class screen (no pre-upload here).
// The professor only waits for the file to reach storage; the render runs on
// the background queue. Nothing goes live to students — the professor still
// clicks "Start class" at the scheduled time.

import { useState, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarPlus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  scheduleLiveClass,
  createDeckUploadUrl,
  enqueueScheduledDeckRender,
} from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
import {
  expandWeeklyOccurrences,
  MAX_SCHEDULE_OCCURRENCES,
} from '@/lib/live-classroom/recurrence'
import {
  MAX_DECK_BYTES,
  MAX_PPTX_BYTES,
  MAX_ROOM_NAME_LENGTH,
} from '@/lib/validations/live-classroom'

const WEEKDAYS = [
  { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
  { value: '0', label: 'Sun' },
]

const MB = 1024 * 1024

function extensionOf(name: string): 'pdf' | 'pptx' | 'ppt' | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.pptx')) return 'pptx'
  if (lower.endsWith('.ppt')) return 'ppt'
  return null
}

interface ScheduleSessionDialogProps {
  sectionId: string
  pptxEnabled: boolean
}

export function ScheduleSessionDialog({ sectionId, pptxEnabled }: ScheduleSessionDialogProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [name, setName] = useState('')
  const [startAt, setStartAt] = useState('') // datetime-local (professor's tz)
  const [recurring, setRecurring] = useState(false)
  const [weekdays, setWeekdays] = useState<string[]>([])
  const [untilDate, setUntilDate] = useState('') // date (professor's tz)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reset = useCallback(() => {
    setName('')
    setStartAt('')
    setRecurring(false)
    setWeekdays([])
    setUntilDate('')
    setFile(null)
    setError(null)
  }, [])

  /* Preview the occurrences a weekly series would create (also what we submit).
     Expanded to ONE OVER the cap so truncation is detectable: the builder stops at
     the cap, so `length === MAX` cannot be told apart from a range that happens to
     produce exactly MAX. Without that distinction the reduction was silent — the
     professor asked for a year of classes, got 50, and the only hint was a count
     they had no reason to question. */
  const { occurrences, truncated } = useMemo<{ occurrences: Date[]; truncated: boolean }>(() => {
    const none = { occurrences: [] as Date[], truncated: false }
    if (!startAt) return none
    const start = new Date(startAt)
    if (Number.isNaN(start.getTime())) return none
    if (!recurring) return { occurrences: [start], truncated: false }
    if (weekdays.length === 0 || !untilDate) return none
    const until = new Date(untilDate)
    if (Number.isNaN(until.getTime())) return none
    const raw = expandWeeklyOccurrences(
      start,
      weekdays.map(Number),
      until,
      MAX_SCHEDULE_OCCURRENCES + 1,
    )
    return raw.length > MAX_SCHEDULE_OCCURRENCES
      ? { occurrences: raw.slice(0, MAX_SCHEDULE_OCCURRENCES), truncated: true }
      : { occurrences: raw, truncated: false }
  }, [startAt, recurring, weekdays, untilDate])

  const handleSubmit = useCallback(async () => {
    if (submitting) return
    setError(null)

    if (!startAt) return setError('Pick a date and time.')
    const start = new Date(startAt)
    if (Number.isNaN(start.getTime())) return setError('That date/time is invalid.')
    if (start.getTime() <= Date.now()) return setError('Pick a time in the future.')

    if (recurring) {
      if (weekdays.length === 0) return setError('Pick at least one weekday to repeat on.')
      if (!untilDate) return setError('Pick a date to repeat until.')
      if (occurrences.length === 0) return setError('No sessions fall in that range — check the dates.')
      /* No `length > MAX` guard here any more: it was unreachable, because the
         builder caps the array it returns. Exceeding the cap is not an error to
         block on either — the cap is deliberate. It's now reported inline next to
         the preview (see `truncated`), so the professor can shorten the range or
         accept 50 rather than being stopped. */
    }

    // Validate the (one-off only) slide file before creating anything.
    let ext: 'pdf' | 'pptx' | 'ppt' | null = null
    if (!recurring && file) {
      ext = extensionOf(file.name)
      if (!ext) return setError('Upload a PDF or PowerPoint file.')
      if (ext !== 'pdf' && !pptxEnabled) return setError('PowerPoint upload is unavailable — use a PDF.')
      const cap = ext === 'pdf' ? MAX_DECK_BYTES : MAX_PPTX_BYTES
      if (file.size > cap) return setError(`File too large — max ${Math.round(cap / MB)} MB.`)
    }

    setSubmitting(true)
    try {
      const isoOccurrences = occurrences.map((d) => d.toISOString())
      const res = await scheduleLiveClass({
        sectionId,
        name: name.trim() || undefined,
        occurrences: isoOccurrences,
        recurring,
      })
      if (res.error || !res.roomIds?.length) {
        setError(res.error ?? 'Failed to schedule the session.')
        setSubmitting(false)
        return
      }

      // One-off with slides: upload to storage, then kick the background render.
      if (!recurring && file && ext) {
        const roomId = res.roomIds[0]
        const urlRes = await createDeckUploadUrl({ roomId, extension: ext, title: file.name })
        if (urlRes.error || !urlRes.signedUrl) {
          // The session is scheduled; only the slide prep failed. Tell the prof
          // they can add slides from the session's setup screen.
          toast.warning('Session scheduled, but the slide upload failed — add slides from the session later.')
        } else {
          const putRes = await fetch(urlRes.signedUrl, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${urlRes.token}`, 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          })
          if (!putRes.ok) {
            toast.warning('Session scheduled, but the slide upload failed — add slides from the session later.')
          } else {
            await enqueueScheduledDeckRender({ roomId, deckId: urlRes.deckId })
          }
        }
      }

      toast.success(
        recurring
          ? `Scheduled ${res.roomIds.length} sessions.`
          : file
            ? 'Session scheduled — your slides are being prepared.'
            : 'Session scheduled.',
      )
      reset()
      setOpen(false)
      router.refresh()
    } catch {
      setError('Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }, [submitting, startAt, recurring, weekdays, untilDate, occurrences, file, pptxEnabled, sectionId, name, reset, router])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <CalendarPlus className="h-4 w-4" />
          Schedule a session
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule a live class</DialogTitle>
          <DialogDescription>
            Pick when to hold it. You&apos;ll start the class yourself at that time — students only see it once you do.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="schedule-name">Session name (optional)</Label>
            <Input
              id="schedule-name"
              value={name}
              maxLength={MAX_ROOM_NAME_LENGTH}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Lecture 5 — Backpropagation"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="schedule-start">{recurring ? 'First session' : 'Date & time'}</Label>
            <Input
              id="schedule-start"
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="schedule-recurring"
              checked={recurring}
              onCheckedChange={(v) => setRecurring(v === true)}
            />
            <Label htmlFor="schedule-recurring" className="text-sm font-medium">
              Repeat weekly
            </Label>
          </div>

          {recurring ? (
            <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
              <div className="space-y-1.5">
                <Label>Repeat on</Label>
                <ToggleGroup
                  type="multiple"
                  variant="outline"
                  spacing={2}
                  value={weekdays}
                  onValueChange={setWeekdays}
                  className="flex w-full flex-wrap justify-start"
                >
                  {WEEKDAYS.map((d) => (
                    <ToggleGroupItem key={d.value} value={d.value} className="h-8 w-11 text-xs">
                      {d.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-until">Until</Label>
                <Input
                  id="schedule-until"
                  type="date"
                  value={untilDate}
                  onChange={(e) => setUntilDate(e.target.value)}
                />
              </div>
              {occurrences.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
                    {occurrences.length} session{occurrences.length === 1 ? '' : 's'}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {occurrences.slice(0, 4).map((d, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium tabular-nums"
                      >
                        {d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                      </span>
                    ))}
                    {occurrences.length > 4 && (
                      <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                        +{occurrences.length - 4} more
                      </span>
                    )}
                  </div>
                  {/* The cap is deliberate, so this informs rather than blocks — but
                      it has to be SAID. Previously the range was quietly reduced and
                      the only signal was a count the professor had no reason to
                      question. */}
                  {truncated && (
                    <p className="text-xs text-warning-muted-foreground">
                      Limited to {MAX_SCHEDULE_OCCURRENCES} sessions — shorten the date range or pick
                      fewer weekdays to cover the rest.
                    </p>
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Add slides to each session from its setup screen when it&apos;s time.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="schedule-file">Slides (optional)</Label>
              <Input
                id="schedule-file"
                type="file"
                accept={pptxEnabled ? '.pdf,.ppt,.pptx' : '.pdf'}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                Upload now and we&apos;ll prepare them in the background — they&apos;ll be ready before class, no waiting.
              </p>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Scheduling…
              </>
            ) : (
              'Schedule'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
