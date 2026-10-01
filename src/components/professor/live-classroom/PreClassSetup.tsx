// Pre-class setup — the screen the professor sees before a live session starts.
// They pick/upload a deck; while it renders (which takes a moment) they fill in
// a couple of quick settings — the session name and whether students can use
// "Catch me up". "Start class" activates the rendered deck and begins the
// session. Shown while room.setup_completed is false; LivePresenter swaps to the
// live deck once startLiveClass flips it true.
//
// The deck pipeline (pick → upload → render) lives in UploadDeckDialog, kept
// mounted throughout so its render lifecycle isn't interrupted; this component
// owns the config form + "Start class" and reads the render phase via callbacks.

'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { CalendarClock, Loader2, Mic, Play, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAudioInputDevices, resolveMicDeviceId } from '@/lib/live-classroom/audio-devices'
import { toast } from 'sonner'
import { UploadDeckDialog, type DeckSetupPhase } from './UploadDeckDialog'
import { PreClassInteractionPrep } from './PreClassInteractionPrep'
import { startLiveClass } from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
import { MAX_ROOM_NAME_LENGTH, type DeckSummary } from '@/lib/validations/live-classroom'
import type { DeckRenderState } from '@/lib/live-classroom/broadcast/use-slide-sync'
import { SPRING } from '@/lib/motion'

interface PreClassSetupProps {
  roomId: string
  sectionId: string
  deckRender: DeckRenderState | null
  onResetDeckRender?: () => void
  /** Decks already in the room — used to recover the "ready" state after a
   *  reload mid-setup (the deck is rendered but not yet activated on the room). */
  decks?: DeckSummary[]
  /** Set when this is a scheduled session; drives the countdown and lets a
   *  background render (deck present but not yet ready) show "Preparing" on
   *  open instead of the picker (which would invite a duplicate upload). */
  scheduledAt?: string | null
  /** The room's existing name (e.g. one chosen when scheduling). Seeds the name
   *  field and suppresses the deck-filename auto-fill so it isn't overwritten. */
  initialName?: string | null
}

/** The last rendered deck in the room, if any. On a reload mid-setup the deck
 *  is rendered (ready) but not yet activated on the room, so we recover the
 *  "ready" state from it instead of sending the professor back to the picker. */
function lastReadyDeck(decks?: DeckSummary[]): DeckSummary | null {
  const ready = decks?.filter((d) => d.ready) ?? []
  return ready.length > 0 ? ready[ready.length - 1] : null
}

/** Microphone chooser — which input feeds live transcription AND the class
 *  recording (one per-browser preference, read by both capture hooks at
 *  start). Device labels are empty until mic permission is granted, so the
 *  select swaps in only after a one-tap permission prime. */
function MicrophoneField() {
  const { devices, hasLabels, pref, select, requestAccess } = useAudioInputDevices()
  // Virtual entries some platforms inject; "System default" covers them.
  const items = devices.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
  const activeValue = resolveMicDeviceId(pref, items) ?? 'default'

  return (
    <div className="space-y-2">
      <Label htmlFor="lc-microphone">Microphone</Label>
      {hasLabels ? (
        <Select
          value={activeValue}
          onValueChange={(value) => {
            if (value === 'default') {
              select(null)
              return
            }
            const device = items.find((d) => d.deviceId === value)
            if (device) select({ deviceId: device.deviceId, label: device.label })
          }}
        >
          <SelectTrigger id="lc-microphone" className="w-full">
            <SelectValue placeholder="System default" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">System default</SelectItem>
            {items.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>
                {d.label || 'Microphone'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Button
          id="lc-microphone"
          type="button"
          variant="outline"
          onClick={() =>
            void requestAccess().then((ok) => {
              // A deny leaves the button unchanged — say why, or the click
              // reads as "nothing happened".
              if (!ok) toast.error('Microphone access blocked — allow it in your browser to choose a device.')
            })
          }
          className="w-full justify-start font-normal text-muted-foreground"
        >
          <Mic className="mr-2 h-4 w-4" aria-hidden="true" />
          Choose a microphone…
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        Feeds live transcription and the class recording. Remembered on this browser.
      </p>
    </div>
  )
}

/** Live countdown to the scheduled start. Only ever rendered client-side
 *  (ClassroomDashboard gates the presenter on a loaded snapshot), so seeding
 *  `now` lazily is hydration-safe and keeps setState out of the effect body. */
function ScheduledCountdown({ scheduledAt }: { scheduledAt: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const diffMs = new Date(scheduledAt).getTime() - now
  let label: string
  if (diffMs <= 0) {
    label = "It's time — start when you're ready"
  } else {
    const totalSec = Math.floor(diffMs / 1000)
    const d = Math.floor(totalSec / 86400)
    const h = Math.floor((totalSec % 86400) / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    const parts = d > 0 ? [`${d}d`, `${h}h`, `${m}m`] : h > 0 ? [`${h}h`, `${m}m`, `${s}s`] : [`${m}m`, `${s}s`]
    label = `Starts in ${parts.join(' ')}`
  }
  return (
    <div className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-muted/30 px-4 py-3 text-sm">
      <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <span className="font-medium tabular-nums">{label}</span>
    </div>
  )
}

export function PreClassSetup({ roomId, sectionId, deckRender, onResetDeckRender, decks, scheduledAt, initialName }: PreClassSetupProps) {
  // Initial state derives from any already-rendered deck (reload recovery);
  // lazy initializers run once on mount, so this needs no effect. A room name
  // chosen at schedule time wins over the deck filename.
  const [name, setName] = useState(() => (initialName?.trim() || lastReadyDeck(decks)?.title) ?? '')
  // Treat a pre-set room name as "dirty" so the deck-filename auto-fill leaves it be.
  const [isNameDirty, setIsNameDirty] = useState(() => !!initialName?.trim())
  const [lectureSummaryEnabled, setLectureSummaryEnabled] = useState(true)
  // Scheduled session opened while its deck is still rendering in the background:
  // a deck row exists but isn't ready yet → show "Preparing", NOT the picker (a
  // picker would tempt a duplicate upload → a second concurrent render). The
  // live start-now flow keeps its behaviour: a non-ready deck on reload means the
  // render was interrupted, so it returns to the picker to retry.
  const [phase, setPhase] = useState<DeckSetupPhase>(() => {
    if (lastReadyDeck(decks)) return 'ready'
    if (scheduledAt && (decks?.length ?? 0) > 0) return 'working'
    return 'choosing'
  })
  const [readyDeckId, setReadyDeckId] = useState<string | null>(() => lastReadyDeck(decks)?.id ?? null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // The deck pipeline reports 'choosing' on mount (its internal state starts
  // idle). Ignore it: 'choosing' is the initial state, never something we
  // transition TO — honoring it would kick a recovered "ready" screen (after a
  // reload) back to the picker. Real transitions (working/ready/error) apply.
  const handlePhaseChange = useCallback((next: DeckSetupPhase) => {
    if (next === 'choosing') return
    setPhase(next)
  }, [])

  const handleDeckTitle = useCallback(
    (title: string) => {
      // Only auto-fill while the professor hasn't typed their own name.
      setName((prev) => (isNameDirty ? prev : title))
    },
    [isNameDirty],
  )

  const handleStart = useCallback(async () => {
    if (isSubmitting || phase !== 'ready' || !readyDeckId) return
    setIsSubmitting(true)
    const result = await startLiveClass({
      roomId,
      deckId: readyDeckId,
      name: name.trim() || undefined,
      lectureSummaryEnabled,
    })
    if (result.error) {
      toast.error(result.error)
      setIsSubmitting(false)
      return
    }
    // setup_completed is now true in the DB. The presenter reads room state from
    // the client realtime snapshot, which router.refresh() doesn't update — and
    // racing the deck_ready broadcast against the channel resubscribe can leave
    // the professor's own view stuck on this screen. A full reload re-hydrates
    // straight into the live presenter, reliably. (Students go live via the
    // deck_ready broadcast as usual.)
    window.location.reload()
  }, [isSubmitting, phase, readyDeckId, roomId, name, lectureSummaryEnabled])

  const showConfig = phase === 'working' || phase === 'ready'

  return (
    <div className="space-y-4">
      {scheduledAt && <ScheduledCountdown scheduledAt={scheduledAt} />}

      {/* Deck pipeline. Hidden (but mounted) once rendering starts so its
          lifecycle keeps running while the config card takes the focus; shown
          again on error so the prof sees the retry affordance. */}
      <div className={showConfig ? 'hidden' : undefined}>
        <UploadDeckDialog
          roomId={roomId}
          sectionId={sectionId}
          deckRender={deckRender}
          onResetDeckRender={onResetDeckRender}
          initialSetup
          onPhaseChange={handlePhaseChange}
          onDeckTitle={handleDeckTitle}
          onReady={setReadyDeckId}
        />
      </div>

      {showConfig && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING}
          className="rounded-3xl border border-border bg-background p-6 sm:p-10"
        >
          <div className="mx-auto w-full max-w-5xl">
            {/* Progress / ready indicator */}
            <div className="flex flex-col items-center text-center">
              {phase === 'ready' ? (
                <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-success-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Slides ready
                </p>
              ) : (
                <>
                  <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    Preparing your slides
                    {deckRender && deckRender.totalPages > 0 && (
                      <span className="tabular-nums">
                        · {deckRender.pagesRendered} of {deckRender.totalPages}
                      </span>
                    )}
                  </p>
                  <div className="mt-3 h-[3px] w-full max-w-xs overflow-hidden rounded-full bg-muted/60">
                    <motion.div
                      className="h-full bg-foreground/80"
                      initial={false}
                      animate={{
                        width: deckRender && deckRender.totalPages > 0
                          ? `${Math.min(100, (deckRender.pagesRendered / deckRender.totalPages) * 100)}%`
                          : '10%',
                      }}
                      transition={SPRING}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="mt-8 text-center">
              <h2 className="text-2xl font-semibold tracking-tight">A few quick settings</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {phase === 'ready'
                  ? 'Your slides are ready — review these before you start.'
                  : 'Set these up while your slides finish preparing.'}
              </p>
            </div>

            {/* Essentials on the left, optional interaction prep on the right —
                two columns on wide screens so nothing scrolls off; stacked on
                mobile. */}
            <div className="mt-10 grid lg:grid-cols-2 lg:gap-x-12">
              {/* Essentials */}
              <div className="min-w-0 space-y-6">
                {/* Session name */}
                <div className="space-y-2">
                  <Label htmlFor="lc-session-name">Session name</Label>
                  <Input
                    id="lc-session-name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setIsNameDirty(true)
                    }}
                    maxLength={MAX_ROOM_NAME_LENGTH}
                    placeholder="e.g. Lecture 12 — Backpropagation"
                  />
                  <p className="text-xs text-muted-foreground">
                    Helps you and your students find this class later.
                  </p>
                </div>

                {/* Microphone (transcription + recording source) */}
                <MicrophoneField />

                {/* Catch me up toggle */}
                <div className="flex items-start justify-between gap-4 rounded-2xl border border-border bg-muted/20 p-4">
                  <div className="min-w-0">
                    <Label htmlFor="lc-catch-me-up" className="text-sm font-semibold">
                      Catch me up
                    </Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Let students who join late get an AI summary of the lecture so far.
                    </p>
                  </div>
                  <Switch
                    id="lc-catch-me-up"
                    checked={lectureSummaryEnabled}
                    onCheckedChange={setLectureSummaryEnabled}
                    className="mt-0.5 shrink-0"
                  />
                </div>
              </div>

              {/* Optional: prepare polls & quizzes while the deck renders.
                  Drafts created here surface in the in-class composer. Divider
                  sits on top when stacked, on the left when side-by-side. */}
              <div className="min-w-0 mt-10 border-t border-border pt-8 lg:mt-0 lg:border-t-0 lg:pt-0 lg:border-l lg:pl-12">
                <PreClassInteractionPrep roomId={roomId} />
              </div>
            </div>

            {/* Start — the commit action for the whole screen */}
            <div className="mt-10 flex justify-center border-t border-border pt-8">
              <Button
                onClick={handleStart}
                disabled={phase !== 'ready' || isSubmitting}
                className="h-12 w-full max-w-sm rounded-full text-base font-semibold disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    Starting…
                  </>
                ) : phase === 'ready' ? (
                  <>
                    <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                    Start class
                  </>
                ) : (
                  'Preparing slides…'
                )}
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  )
}
