'use client'

// The "Upcoming" list on the Live tab: scheduled sessions ordered by start time,
// each showing when it starts, a recurrence chip, a slides-prep badge, and
// Open / Cancel. Opening a session lands on its pre-class setup screen (with the
// countdown). Cancelling a recurring occurrence offers "this one" vs "the series".

import { useState, useSyncExternalStore, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, CalendarClock, ChevronRight, Loader2, Repeat, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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
import { LocalDateTime } from '@/components/shared/LocalDateTime'
import { LiveClassName } from '@/components/live-classroom/shared/LiveClassName'
import { cancelScheduledSession } from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'

export interface UpcomingSession {
  id: string
  name: string | null
  scheduledAt: string | null
  recurrenceGroupId: string | null
  isRecurring: boolean
  slidesState: 'none' | 'processing' | 'ready' | 'failed'
}

// Empty subscribe — the client/server split never changes after hydration.
const noopSubscribe = () => () => {}
// A stable client-side "now", captured once on first read so the snapshot React
// caches never changes (a fresh Date.now() each render would loop / be impure).
// Server snapshot is 0 → nothing reads as overdue until hydration.
let clientNowCache: number | null = null
const getClientNow = () => (clientNowCache ??= Date.now())

const SLIDES_BADGE: Record<UpcomingSession['slidesState'], { label: string; className: string } | null> = {
  none: null,
  processing: { label: 'Preparing slides…', className: 'bg-muted text-muted-foreground' },
  ready: { label: 'Slides ready', className: 'bg-success-muted text-success-muted-foreground' },
  failed: { label: 'Slides failed — reopen to retry', className: 'bg-destructive/10 text-destructive' },
}

export function UpcomingSessions({
  sectionId,
  sessions,
}: {
  sectionId: string
  sessions: UpcomingSession[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [toCancel, setToCancel] = useState<UpcomingSession | null>(null)
  // Overdue is decided against the professor's clock, but only client-side: the
  // same useSyncExternalStore split LocalDateTime uses, so reading the clock
  // can't cause a hydration mismatch across the overdue boundary (nor trip the
  // set-state-in-effect rule). Server render → false, so no badge flashes in.
  const now = useSyncExternalStore(noopSubscribe, getClientNow, () => 0)

  const doCancel = (session: UpcomingSession, scope: 'one' | 'series') => {
    startTransition(async () => {
      const res = await cancelScheduledSession({ roomId: session.id, scope })
      if (res.error) {
        toast.error(res.error)
      } else {
        toast.success(scope === 'series' ? 'Series cancelled.' : 'Session cancelled.')
        router.refresh()
      }
      setToCancel(null)
    })
  }

  if (sessions.length === 0) return null

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-widest font-semibold text-muted-foreground">
        <CalendarClock className="h-3.5 w-3.5" aria-hidden />
        Upcoming
      </p>
      <ul className="space-y-2">
        {sessions.map((s) => {
          const badge = SLIDES_BADGE[s.slidesState]
          // Past its start time but never started (still 'scheduled'). Kept in the
          // list so it can still be started late, but flagged so it doesn't read
          // as genuinely upcoming.
          const isOverdue =
            now > 0 && s.scheduledAt != null && new Date(s.scheduledAt).getTime() < now
          return (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm"
            >
              <Link
                href={`/professor/courses/${sectionId}/live-classroom/${s.id}`}
                className="group flex min-w-0 flex-1 items-center gap-3"
              >
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
                  <CalendarClock className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  {/* flex-wrap, because `truncate` alone let the name reach 0px wide.
                      A flex item's automatic minimum size is its content width ONLY
                      while overflow is visible; truncate sets overflow:hidden, which
                      drops that floor to zero. With two shrink-0 chips and the gaps
                      eating a 390px row, the name was squeezed out of existence rather
                      than ellipsised — measured at exactly {width: 0}. Wrapping lets a
                      chip drop to the next line and gives the name the row back, which
                      also avoids the horizontal overflow a min-width floor would cause
                      when both chips show at once. */}
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {/* truncate stays on the span itself — a flex parent won't
                        ellipsize its text child. */}
                    <span className="min-w-0 truncate">
                      <LiveClassName name={s.name} createdAt={s.scheduledAt ?? ''} />
                    </span>
                    {isOverdue && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-muted px-2 py-0.5 text-xs font-medium text-warning-muted-foreground">
                        <AlertTriangle className="h-3 w-3" />
                        Overdue
                      </span>
                    )}
                    {s.isRecurring && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        <Repeat className="h-3 w-3" />
                        Weekly
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {s.scheduledAt && <LocalDateTime iso={s.scheduledAt} mode="datetime" />}
                    {badge && (
                      <>
                        {' · '}
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                          {badge.label}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                aria-label="Cancel session"
                disabled={pending}
                onClick={() => setToCancel(s)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          )
        })}
      </ul>

      <AlertDialog open={toCancel !== null} onOpenChange={(o) => !o && setToCancel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this session?</AlertDialogTitle>
            <AlertDialogDescription>
              {toCancel?.isRecurring
                ? 'This is part of a weekly series. Cancel just this occurrence, or the whole series?'
                : 'This scheduled session and any slides you uploaded for it will be removed.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep it</AlertDialogCancel>
            {toCancel?.isRecurring && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => toCancel && doCancel(toCancel, 'series')}
              >
                Cancel series
              </Button>
            )}
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault()
                if (toCancel) doCancel(toCancel, 'one')
              }}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : toCancel?.isRecurring ? 'Cancel this one' : 'Cancel session'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
