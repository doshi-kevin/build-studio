// Live Presenter — the professor's deck viewer with keyboard navigation,
// fullscreen toggle, slide counter, connection status, and an End Class CTA.
// Visual layer only. The connection, snapshot and replay logic belongs to
// ClassroomDashboard, which passes this component its bus (#639).

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  PowerOff,
  Loader2,
  ArrowDownRight,
  ArrowUpLeft,
  Presentation,
  Plus,
  MonitorOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { PortalContainerProvider } from '@/components/ui/portal-container'
import { Toaster } from '@/components/ui/sonner'
import { UploadDeckDialog } from './UploadDeckDialog'
import { PreClassSetup } from './PreClassSetup'
import { DeckSwitcher } from './DeckSwitcher'
import { LiveClassName } from '@/components/live-classroom/shared/LiveClassName'
import { advanceSlide, endRoom, switchDeck, removeDeck, setScreenBlank, shareRoomUploads, cancelScheduledSession } from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
import { useSlideState } from '@/lib/live-classroom/broadcast/use-slide-sync'
import type { EventBus } from '@/lib/live-classroom/broadcast/event-bus'
import type { ConnectionStatus } from '@/lib/live-classroom/broadcast/use-room-channel'
import type { LcRoom } from '@/lib/validations/live-classroom'
import { SPRING, SPRING_SNAPPY, SPRING_POP, SLIDE_FADE } from '@/lib/motion'
import { SLIDE_ADVANCE_THROTTLE_MS, type DeckSummary } from '@/lib/validations/live-classroom'

interface LivePresenterProps {
  roomId: string
  sectionId: string
  /**
   * The bus and snapshot state of the connection ClassroomDashboard owns.
   *
   * This used to call useRoom(roomId) and open a SECOND connection to the same room
   * alongside its parent's — the same double mount that froze students' slides after a
   * brief drop (#639). The professor side had it too, so it is fixed the same way: the
   * connection arrives as a prop and cannot be opened here.
   */
  bus: EventBus
  initialRoom: LcRoom
  initialSlideUrls: string[]
  connectionStatus: ConnectionStatus
  renderSlideOverlay?: (slideIndex: number) => React.ReactNode
  statusSlot?: (isFullscreen: boolean) => React.ReactNode
  /** Decks in this room (from the dashboard snapshot) for the switcher.
   *  Omitted on surfaces without multi-deck context (e.g. the student view
   *  doesn't use this component). */
  decks?: DeckSummary[]
  activeDeckId?: string | null
}

export function LivePresenter({
  roomId,
  sectionId,
  bus,
  initialRoom,
  initialSlideUrls,
  connectionStatus,
  renderSlideOverlay,
  statusSlot,
  decks,
  activeDeckId,
}: LivePresenterProps) {
  const router = useRouter()
  const { room, deckRender, slideUrls, resetDeckRender } = useSlideState({
    bus,
    roomId,
    initialRoom,
    initialSlideUrls,
  })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isEnding, setIsEnding] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [addDeckOpen, setAddDeckOpen] = useState(false)
  const [switchingDeck, setSwitchingDeck] = useState(false)
  // Next-slide preview visibility (in-session). Defaults on — preserving the
  // classic presenter view — but the prof can collapse it to a small pill when
  // it gets in the way, then bring it back from that same corner.
  const [previewOpen, setPreviewOpen] = useState(true)

  const handleSwitchDeck = useCallback(
    async (deckId: string) => {
      setSwitchingDeck(true)
      const result = await switchDeck({ roomId, deckId })
      if (result.error) toast.error(result.error)
      setSwitchingDeck(false)
    },
    [roomId],
  )

  const handleRemoveDeck = useCallback(
    async (deckId: string) => {
      const result = await removeDeck({ roomId, deckId })
      if (result.error) toast.error(result.error)
      else toast.success('Deck removed')
    },
    [roomId],
  )
  const containerRef = useRef<HTMLDivElement>(null)
  /* Portal target while presenting (#653). A ref alone cannot drive this: it is null on
     first render and mutating it does not re-render, so the provider would hand out
     `undefined` forever. Tracked in state via a callback ref instead, and only supplied
     while ACTUALLY fullscreen — outside fullscreen, portaling to body is correct and
     keeps toast stacking shared with the rest of the app. */
  const [fullscreenEl, setFullscreenEl] = useState<HTMLDivElement | null>(null)
  const lastAdvanceRef = useRef<number>(0)
  /* The slide we last ASKED for, which is not the same as the slide we are on.
     `room.current_slide` is server-confirmed and only moves when the broadcast
     round-trips (~1s), so two clicks inside that window both read the same
     "current" slide and both request the same target — the second click is
     swallowed with nothing on screen to say so. Measured: 3 clicks 500ms apart
     advanced 2 slides. This ref carries the professor's intent across that gap.
     Null means "nothing outstanding, trust the room". */
  const pendingSlideRef = useRef<number | null>(null)
  /* Slides we have asked for and not yet seen come back. This is what tells a
     broadcast we caused apart from one somebody else caused; the two are
     identical if you only look at the slide number. Deliberately NOT an
     in-flight counter: the server action resolves in ~200ms but its broadcast
     lands ~1s later, so a counter reads zero while a perfectly valid intent is
     still waiting, and clearing there would re-open the swallowed-click bug. */
  const requestedSlidesRef = useRef<Set<number>>(new Set())

  /* The broadcast is still the truth; this ref only ever runs ahead of it
     briefly. Two ways the intent stops being meaningful:

     1. The room reaches the slide we asked for. Exact match, deliberately.
        `>=` breaks going BACKWARDS, though not on a single click — this effect
        only runs when `current_slide` changes, and setting a ref re-renders
        nothing. It takes three: ask 9, ask 8 while 9 is unconfirmed, then 9
        lands late and `>=` clears an intent we have already overtaken, so the
        third click re-asks for 8. The swallowed-click bug in reverse.
     2. The room moved to a slide we never asked for — another tab or a second
        device drove it. Our intent now describes a slide nobody is on, and
        stepping from it would take the WHOLE ROOM backwards on the next
        click, in front of the class. */
  useEffect(() => {
    const slide = room.current_slide
    if (requestedSlidesRef.current.has(slide)) {
      requestedSlidesRef.current.delete(slide)
      if (pendingSlideRef.current === slide) pendingSlideRef.current = null
      return
    }
    // Not ours. Drop the stale intent and anything still outstanding with it.
    pendingSlideRef.current = null
    requestedSlidesRef.current.clear()
  }, [room.current_slide])

  /* A deck switch writes current_slide 0, so any outstanding intent belongs to
     the deck we just left. Without this it survives the switch and the next
     click steps from a slide the new deck never showed — which usually means a
     DEAD Next button, not a visible jump: an orphaned intent of 4 against a
     5-page deck computes 5, fails the bounds check above, and returns silently.
     The requested set goes too, or a stale index from the old deck could later
     be mistaken for a broadcast we caused in the new one. */
  useEffect(() => {
    pendingSlideRef.current = null
    requestedSlidesRef.current.clear()
  }, [room.deck_url])

  // Throttled slide advance
  const handleAdvance = useCallback(
    async (newIndex: number) => {
      if (room.deck_page_count === null) return

      // Throttle
      const now = Date.now()
      if (now - lastAdvanceRef.current < SLIDE_ADVANCE_THROTTLE_MS) return
      lastAdvanceRef.current = now

      // Bounds check
      if (newIndex < 0 || newIndex >= room.deck_page_count) return

      pendingSlideRef.current = newIndex
      requestedSlidesRef.current.add(newIndex)
      const result = await advanceSlide({ roomId, slideIndex: newIndex })
      if (result.error) {
        // Drop the intent — the server never moved, so leaving it set would
        // let the next click compute from a slide that does not exist.
        pendingSlideRef.current = null
        requestedSlidesRef.current.delete(newIndex)
        toast.error(result.error)
      }
    },
    [room, roomId],
  )

  // Projector blank (presenter-remote "."). Live room state — the update
  // broadcasts screen_blank_changed and the Projector View covers itself;
  // students are unaffected. Throttled like slide advances.
  const isBlanked = room.is_blanked === true
  const lastBlankRef = useRef<number>(0)
  const setBlank = useCallback(
    async (next: boolean) => {
      const now = Date.now()
      if (now - lastBlankRef.current < SLIDE_ADVANCE_THROTTLE_MS) return
      lastBlankRef.current = now
      const result = await setScreenBlank({ roomId, isBlanked: next })
      if (result.error) {
        toast.error(result.error)
      }
    },
    [roomId],
  )

  // Nav while blanked wakes the projector instead of moving (PowerPoint
  // semantics) — the first press after a blank should never skip a slide.
  // Both step off the outstanding request when there is one, so a second press
  // inside the broadcast round-trip moves a slide instead of re-asking for the
  // one already in flight.
  const handlePrev = useCallback(() => {
    // room is always present here (mounted after the snapshot)
    if (isBlanked) {
      void setBlank(false)
      return
    }
    handleAdvance((pendingSlideRef.current ?? room.current_slide) - 1)
  }, [room, isBlanked, setBlank, handleAdvance])

  const handleNext = useCallback(() => {
    // room is always present here (mounted after the snapshot)
    if (isBlanked) {
      void setBlank(false)
      return
    }
    handleAdvance((pendingSlideRef.current ?? room.current_slide) + 1)
  }, [room, isBlanked, setBlank, handleAdvance])

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return

    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      containerRef.current.requestFullscreen()
    }
  }, [])

  // Keyboard shortcuts — including a presenter remote (e.g. Logitech R400),
  // which is a plain HID keyboard sending PageDown/PageUp (next/prev), F5/Esc
  // (its play button alternates the two) and "." (blank screen).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore when the user is typing in a form control / editable area, or
      // when any overlay UI is open (dialogs, dropdown menus, selects,
      // comboboxes) — keys there belong to the focused control.
      const target = e.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable ||
        target?.closest('[role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [contenteditable="true"]')
      ) {
        return
      }

      // Remote keys stay live while a plain button holds focus (clicking any
      // toolbar button leaves it focused, and these keys can't activate a
      // button anyway). Space/arrows/f still defer to the focused control.
      const isRemoteKey =
        e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'F5' || e.key === '.'
      if (!isRemoteKey && target?.closest('button, [role="button"]')) {
        return
      }

      switch (e.key) {
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault()
          handlePrev()
          break
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault()
          handleNext()
          break
        case 'f':
        case 'F':
          e.preventDefault()
          toggleFullscreen()
          break
        case 'F5':
          // The remote's play button. preventDefault or the browser reloads
          // mid-class. Idempotent "ensure fullscreen" (not a toggle): the
          // remote alternates F5/Esc from internal state that can drift from
          // the real fullscreen state, so each key declares one direction.
          e.preventDefault()
          if (!document.fullscreenElement) {
            containerRef.current?.requestFullscreen()
          }
          break
        case 'Escape':
          if (isFullscreen) {
            document.exitFullscreen()
          }
          break
        case '.':
          e.preventDefault()
          void setBlank(!isBlanked)
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlePrev, handleNext, isFullscreen, toggleFullscreen, isBlanked, setBlank])

  // Fullscreen change listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement !== null)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const performEndClass = useCallback(async () => {
    if (isEnding) return
    setIsEnding(true)

    /* A room that never started must be CANCELLED, not ended. endRoom requires
       status === 'live', so on the pre-class setup screen (status 'scheduled')
       it could only ever fail — with "Room has already ended", about a room that
       had not begun. Same action the hub's Upcoming list already calls; scope
       'one' matches the singular "Cancel session" label, and cancelling a whole
       series stays where it is discoverable, in that list. */
    if (room.status === 'scheduled') {
      const cancelled = await cancelScheduledSession({ roomId, scope: 'one' })
      if (cancelled.error) {
        toast.error(cancelled.error)
        setIsEnding(false)
        setConfirmEnd(false)
        return
      }
      toast.success('Session cancelled')
      router.push(`/professor/courses/${sectionId}/live-classroom`)
      return
    }

    const result = await endRoom({ roomId })

    if (result.error) {
      toast.error(result.error)
      setIsEnding(false)
      setConfirmEnd(false)
    } else {
      /* Slides uploaded to project are saved as course material but NOT shared with
         students until asked (see promoteUploadedDeckToModuleMaterial). Ask here —
         the end of the class is the one moment it is obviously relevant, and it is
         one click rather than a trip to the Modules page. Declining is fine: the
         roadmap shows an unshared upload faded with an eye-off, so it stays
         findable instead of being silently lost. */
      if (result.unsharedUploads) {
        /* One noun throughout — `unsharedUploads` only ever counts lc_decks, so
           these are always slides; the count goes in the sentence rather than
           switching between "slides" and "uploaded files" for the same thing. */
        const n = result.unsharedUploads
        toast.success('Class ended', {
          description: n === 1
            ? 'Share today’s slides with the class?'
            : `Share today’s slides (${n} files) with the class?`,
          duration: 12000,
          action: {
            label: 'Share',
            /* toast.promise, not a bare await: the share is a multi-row update plus
               four revalidatePath calls, and clicking dismissed this toast
               immediately — leaving nothing on screen past the Doherty threshold.
               The success toast carries an Undo, because this changes what students
               can see and is trivially reversible. */
            onClick: () => {
              void toast.promise(shareRoomUploads(roomId), {
                loading: 'Sharing today’s slides…',
                success: (r) => {
                  if (r.error) throw new Error(r.error)
                  return {
                    message: n === 1 ? 'Slides shared with the class' : `Today’s slides shared (${r.shared} files)`,
                    action: {
                      label: 'Undo',
                      onClick: () => {
                        void shareRoomUploads(roomId, false).then((u) => {
                          if (u.error) toast.error(u.error)
                          else toast.success('Not shared — students can’t see them')
                        })
                      },
                    },
                  }
                },
                error: (e) => (e instanceof Error ? e.message : 'Could not share the slides'),
              })
            },
          },
        })
      } else {
        toast.success('Class ended')
      }
      router.push(`/professor/courses/${sectionId}/live-classroom`)
    }
  }, [roomId, sectionId, router, isEnding, room.status])

  // Auto-dismiss the inline "are you sure?" affordance after a few seconds.
  useEffect(() => {
    if (!confirmEnd) return
    const timer = setTimeout(() => setConfirmEnd(false), 4000)
    return () => clearTimeout(timer)
  }, [confirmEnd])

  // Centered End-class control (non-overlay variant) — shared by the pre-class
  // setup screen and the deckless recovery screen below, with different copy
  // for each: a class that hasn't started yet reads as "Cancel", not "End",
  // to avoid implying it's already running next to "Start class". Two-step
  // inline confirm; performEndClass routes on room.status — a 'scheduled' room
  // is cancelled, a 'live' one ended. (It used to call endRoom for both, which
  // could only fail on a room that had not started.)
  const renderCenteredEndClass = ({
    idleLabel,
    confirmQuestion,
    confirmActionLabel,
    dismissLabel = 'Cancel',
  }: {
    idleLabel: string
    confirmQuestion: string
    confirmActionLabel: string
    dismissLabel?: string
  }) => (
    <div className="flex justify-end">
      {confirmEnd ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={SPRING_SNAPPY}
          className="inline-flex origin-right items-center gap-1 rounded-full border border-border bg-card p-1"
        >
          <span className="px-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {confirmQuestion}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmEnd(false)}
            className="rounded-full h-9 px-3 text-xs hover:bg-accent"
          >
            {dismissLabel}
          </Button>
          <Button
            onClick={performEndClass}
            disabled={isEnding}
            size="sm"
            className="rounded-full h-9 px-4 text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {isEnding ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" aria-hidden="true" />
                Ending…
              </>
            ) : (
              confirmActionLabel
            )}
          </Button>
        </motion.div>
      ) : (
        <Button
          variant="outline"
          onClick={() => setConfirmEnd(true)}
          disabled={isEnding}
          className="rounded-full h-10 px-5 border bg-card border-border text-muted-foreground hover:text-foreground hover:bg-accent"
        >
          <PowerOff className="h-4 w-4 mr-2" />
          {idleLabel}
        </Button>
      )}
    </div>
  )

  // Add-a-deck modal — shared by the deckless recovery screen and the main
  // presenter view. Closes itself once the new deck renders (which also
  // activates it, so the presenter swaps to it underneath).
  const addDeckDialog = (
    <Dialog open={addDeckOpen} onOpenChange={setAddDeckOpen}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a deck</DialogTitle>
        </DialogHeader>
        <UploadDeckDialog
          roomId={roomId}
          sectionId={sectionId}
          deckRender={deckRender}
          onResetDeckRender={resetDeckRender}
          onUploaded={() => setAddDeckOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )

  // Loading state
  /* The loading spinner lives in ClassroomDashboard now, which owns the snapshot fetch.
     This component is only mounted once a room exists. */
  // Room ended
  if (room.status === 'ended') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <h2 className="text-2xl font-semibold tracking-tight mb-3">
          This class has ended
        </h2>
        <p className="text-sm text-muted-foreground mb-8 max-w-md">
          The session is no longer active. Head back to start a new one when you&apos;re ready.
        </p>
        <Button
          onClick={() => router.push(`/professor/courses/${sectionId}/live-classroom`)}
          className="rounded-full px-6"
        >
          Back to Live Classroom
        </Button>
      </div>
    )
  }

  // Class not started yet — show the pre-class setup (deck pick + name +
  // "Catch me up" toggle + Start class) with a Cancel control anchored above
  // it (labeled "Cancel", not "End class" — the class hasn't started, so
  // "End" would misleadingly imply it's already running). Two-step inline
  // confirm matches the in-presenter affordance so professors who change
  // their mind before starting (or hit the page on a stale session) can
  // still close cleanly without having to upload a deck first. Driven by
  // setup_completed (not deck_url) so it survives a reload after the deck
  // renders but before the professor clicks Start.
  if (!room.setup_completed) {
    return (
      <div className="space-y-3">
        {renderCenteredEndClass({
          idleLabel: 'Cancel session',
          confirmQuestion: 'Cancel this session?',
          confirmActionLabel: 'Yes, cancel',
          dismissLabel: 'Keep setting up',
        })}
        <PreClassSetup
          roomId={roomId}
          sectionId={sectionId}
          deckRender={deckRender}
          onResetDeckRender={resetDeckRender}
          decks={decks}
          scheduledAt={room.scheduled_at ?? null}
          initialName={room.name ?? null}
        />
      </div>
    )
  }

  // setup_completed is true but the room has no active deck. This is reachable
  // when the professor removes every deck mid-class (removeDeck clears the deck
  // mirror). Instead of an unrecoverable spinner, offer a recovery screen: add a
  // new deck (re-enters the presenter once it renders) or end the class.
  if (!room.deck_url || room.deck_page_count === null) {
    return (
      <div className="space-y-3">
        {renderCenteredEndClass({
          idleLabel: 'End class',
          confirmQuestion: 'End class?',
          confirmActionLabel: 'Yes, end',
        })}
        <div className="flex flex-col items-center justify-center min-h-[50vh] text-center px-6">
          <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Presentation className="h-6 w-6" aria-hidden />
          </span>
          <h2 className="text-xl font-semibold tracking-tight mb-2">No slides in this class</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm">
            All decks were removed. Add a deck to keep presenting, or end the class above.
          </p>
          <Button onClick={() => setAddDeckOpen(true)} className="rounded-full px-6">
            <Plus className="h-4 w-4 mr-2" />
            Add a deck
          </Button>
        </div>
        {addDeckDialog}
      </div>
    )
  }

  // Main presenter view
  // course-materials is private (mig 49); slide URLs are short-lived
  // signed URLs from the snapshot (refreshed on deck_ready / before TTL).
  const slideUrl = slideUrls[room.current_slide] ?? ''
  const currentPage = room.current_slide + 1
  const totalPages = room.deck_page_count
  const atStart = room.current_slide === 0
  const atEnd = room.current_slide === totalPages - 1
  const progressPct = totalPages > 0 ? (currentPage / totalPages) * 100 : 0
  // Next-slide preview source. Empty on the last slide (nothing ahead) or
  // before the next image's signed URL is available.
  const hasNext = room.current_slide < totalPages - 1
  const nextSlideUrl = slideUrls[room.current_slide + 1] ?? ''

  // Connection chip — shown inside the top-left overlay stack below the deck
  // switcher (so the two never collide).
  const connectionChip = connectionStatus !== 'live' && (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING_SNAPPY}
          /* `shadow-lg ring-1` and not a heavier `--border`: this chip spends
             most of its life over the SLIDE, not over the letterbox, and a slide
             is usually white — so `bg-card` has no fill contrast at all there and
             an edge alone cannot carry it. Elevation separates on both grounds at
             once, and `--border` is shared with the sidebar and the annotation
             toolbar, where a hairline that heavy would be wrong. Same treatment as
             the student interaction notice. */
          className="inline-flex items-center gap-1.5 rounded-full bg-card/80 px-2 py-0.5 shadow-lg ring-1 ring-border backdrop-blur-md"
          role="status"
          aria-live="polite"
        >
          {/* Deliberately NOT `.lc-live-dot` — that dot's outward ping means
              "broadcasting". This chip only shows while the connection is
              degraded, where a gentle pulse plus the label is the honest cue. */}
          <span
            className="inline-flex h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse motion-reduce:animate-none"
            aria-hidden
          />
          <span className="text-xs tracking-tight text-muted-foreground">
            {connectionStatus === 'connecting' && 'connecting'}
            {connectionStatus === 'reconnecting' && 'reconnecting'}
            {connectionStatus === 'replaying' && 'syncing'}
            {connectionStatus === 'closed' && 'offline'}
          </span>
        </motion.div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {connectionStatus === 'closed'
          ? 'Disconnected — students aren’t receiving updates'
          : 'Reconnecting to the live class'}
      </TooltipContent>
    </Tooltip>
  )

  // Top-left stage overlay: the deck switcher (which file is live + add/switch/
  // remove) lives here rather than in the bottom control bar — that row
  // overflows once the Engage sidebar insets the stage, and a deck control
  // floating over the slide's letterbox margin stays glanceable in every
  // sidebar/fullscreen state (mirrors how End class sits top-right). The
  // transient connection chip stacks beneath it.
  const topLeftOverlay = (decks && decks.length > 0) || connectionChip ? (
    <div className="absolute top-3 left-3 z-10 flex flex-col items-start gap-2">
      {decks && decks.length > 0 && (
        <DeckSwitcher
          decks={decks}
          activeDeckId={activeDeckId ?? room.active_deck_id ?? null}
          onSwitch={handleSwitchDeck}
          onAddDeck={() => setAddDeckOpen(true)}
          onRemoveDeck={handleRemoveDeck}
          switching={switchingDeck}
        />
      )}
      {connectionChip}
    </div>
  ) : null

  // End-class control — overlay at the top-right of the slide stage (mirrors
  // the student "Leave" button). Lives here instead of the bottom control bar
  // so it stops colliding with the annotation / transcribe / Engage cluster
  // when the sidebar insets the stage. Two-step inline confirm, theme-aware.
  const endClassOverlay = (
    <div className="absolute top-3 right-3 z-10">
      {confirmEnd ? (
        /* Grows from the top-right corner the idle button occupied, so the
           confirm reads as that button expanding rather than a new object
           appearing next to it. */
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={SPRING_SNAPPY}
          className="inline-flex origin-top-right items-center gap-1 rounded-full border border-border bg-card/90 p-0.5 shadow-lg backdrop-blur-xl"
        >
          <span className="px-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            End?
          </span>
          <Button variant="ghost" size="sm" onClick={() => setConfirmEnd(false)}
            className="rounded-full h-7 px-2 text-xs hover:bg-accent">
            No
          </Button>
          <Button onClick={performEndClass} disabled={isEnding} size="sm"
            className="rounded-full h-7 px-3 text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90">
            {isEnding ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Yes'}
          </Button>
        </motion.div>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              onClick={() => setConfirmEnd(true)}
              disabled={isEnding}
              size="sm"
              className="rounded-full h-9 px-4 border border-border bg-card/90 text-xs text-muted-foreground shadow-lg backdrop-blur-xl hover:text-foreground hover:bg-accent"
            >
              <PowerOff className="h-3.5 w-3.5 mr-1.5" />
              End class
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Stop the session</TooltipContent>
        </Tooltip>
      )}
    </div>
  )

  // Blank-screen banner — loud reassurance that the PROJECTOR is dark while
  // the professor's own view stays crisp (they keep presenting notes). The
  // slide is deliberately NOT dimmed here; without this banner a blanked
  // projector is invisible from the podium.
  const blankBanner = isBlanked && (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 rounded-full bg-destructive text-destructive-foreground shadow-xl pl-4 pr-2 py-1.5">
        <span className="lc-live-dot h-2 w-2 text-destructive-foreground" aria-hidden />
        <MonitorOff className="h-4 w-4" aria-hidden />
        <span className="text-sm font-semibold tracking-tight">Projector blanked</span>
        <Button
          size="sm"
          onClick={() => void setBlank(false)}
          className="rounded-full h-7 px-3 text-xs font-semibold bg-destructive-foreground/15 text-destructive-foreground hover:bg-destructive-foreground/25"
        >
          Resume
        </Button>
      </div>
    </motion.div>
  )

  // Next-slide preview — bottom-right of the stage so the professor can see
  // what's coming (classic presenter view). Minimizes like an iOS app: a small
  // arrow tucks the card down into the corner, leaving a compact rounded-
  // rectangle stub with an expand arrow that pops it back out. The card body
  // stays pointer-events-none so clicks/draws pass straight through to the
  // annotation layer below; only the minimize/expand controls opt back in with
  // pointer-events-auto, so they never steal a draw stroke or advance the
  // slide. `priority` preloads the next image so there's no pop-in on advance
  // (and it warms the next main slide too). Hidden on the last slide and on
  // small screens.
  // Both states are absolutely pinned to the same corner and scale from
  // `origin-bottom-right`, so minimizing reads as the card tucking INTO the stub
  // rather than one element vanishing and an unrelated one appearing. This is
  // the one spot that earns a little overshoot (SPRING_POP): the card is
  // travelling a real distance to a real resting place.
  const nextSlidePreview = hasNext && nextSlideUrl && (
    <AnimatePresence initial={false}>
      {previewOpen ? (
        <motion.div
          key="card"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={SPRING_POP}
          className="pointer-events-none absolute bottom-4 right-4 z-10 hidden w-44 origin-bottom-right overflow-hidden rounded-2xl border border-border bg-card/90 shadow-lg backdrop-blur-xl md:block"
        >
          {/* Label row — gives the "Next" tag its own space instead of floating
              over the image, surfaces which slide is coming, and hosts the
              minimize control. */}
          <div className="flex items-center justify-between gap-1.5 px-3 pb-1.5 pt-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Next
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs tabular-nums text-muted-foreground/70">
                {currentPage + 1} / {totalPages}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setPreviewOpen(false)}
                    className="pointer-events-auto inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="Minimize next-slide preview"
                  >
                    <ArrowDownRight className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Minimize</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {/* Framed thumbnail — inset margins so it reads as a card, not a raw image. */}
          <div className="relative mx-2 mb-2 aspect-video overflow-hidden rounded-xl bg-muted">
            <Image
              src={nextSlideUrl}
              alt="Next slide preview"
              fill
              className="object-contain"
              priority
              unoptimized
            />
          </div>
        </motion.div>
      ) : (
        // Minimized — a small rounded-rectangle stub in the same corner with an
        // expand arrow, like a minimized iOS window. Stays glanceable so the prof
        // always knows the preview is one tap away.
        <Tooltip key="stub">
          <TooltipTrigger asChild>
            <motion.button
              type="button"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={SPRING_POP}
              onClick={() => setPreviewOpen(true)}
              className="pointer-events-auto absolute bottom-4 right-4 z-10 hidden h-8 w-12 origin-bottom-right items-center justify-center rounded-xl border border-border bg-card/90 text-muted-foreground shadow-lg backdrop-blur-xl transition-colors hover:text-foreground md:inline-flex"
              aria-label="Show next-slide preview"
            >
              <ArrowUpLeft className="h-4 w-4" />
            </motion.button>
          </TooltipTrigger>
          <TooltipContent side="left">Next-slide preview</TooltipContent>
        </Tooltip>
      )}
    </AnimatePresence>
  )

  // Slim progress bar. One skin now — `--foreground` / `--muted` invert with the
  // stage. Animates scaleX rather than width: width is a layout property, so the
  // old version relayed out the bar on every slide change; scaleX is
  // compositor-only and can't jank the stage mid-advance.
  const progressBar = (
    <div className="h-1 rounded-full overflow-hidden bg-muted/60">
      <motion.div
        className="h-full w-full origin-left bg-foreground/80"
        initial={false}
        animate={{ scaleX: progressPct / 100 }}
        transition={SPRING}
      />
    </div>
  )

  // Reusable controls row — nav cluster on the left, annotation toolbar
  // slot centered in the middle (collapses to nothing when empty), action
  // buttons on the right. Single row maximises vertical real estate for
  // the slide. Button skins never branch: the stage scope swaps the ground
  // under them, not the classes on them.
  return (
    <TooltipProvider delayDuration={250}>
      {/* `lc-stage` re-points the semantic tokens at the stage palette for
          this whole subtree (see globals.css), so every control below is written
          once against `bg-card` / `border-border` / `text-muted-foreground`
          instead of branching on `isFullscreen` at each site. */}
      <PortalContainerProvider value={isFullscreen ? (fullscreenEl ?? undefined) : undefined}>
      <div
        ref={(el) => {
          containerRef.current = el
          setFullscreenEl(el)
        }}
        /* `overflow-clip`, not `overflow-hidden`: hidden still makes this a
           scroll container, so focusing a control that sits past the right edge
           let the browser scroll the whole stage sideways and leave it there —
           slide reduced to a sliver, "End class" cropped to "class", and
           exiting fullscreen did not put it back. clip cannot scroll at all. */
        className={`relative flex flex-col overflow-clip bg-background ${
          isFullscreen ? 'lc-stage h-screen rounded-none' : 'h-full'
        }`}
      >
        {/* Slide stage — flex-1 min-h-0 + inner absolute so image doesn't dictate height */}
        <div
          className={`relative overflow-hidden ${
            isFullscreen ? 'flex-1' : 'flex-1 min-h-0'
          }`}
        >
          <div className={`absolute ${isFullscreen ? 'inset-2' : 'inset-1 sm:inset-2'}`}>

            {/* Slide changes cross-dissolve instead of hard-cutting. Advancing
                is the single most-repeated action of a whole lecture and had no
                feedback at all — the src just swapped. Opacity only, and the
                annotation overlay stays deliberately OUTSIDE this subtree: it
                maps pointer coordinates against its own bounding rect, so
                animating it would corrupt strokes mid-draw. */}
            {slideUrl ? (
              <AnimatePresence initial={false}>
                <motion.div
                  // Deck id is part of the key: switching decks while both sit on
                  // the same slide number would otherwise keep the key stable and
                  // swap `src` inside one node — a hard cut, the exact thing this
                  // cross-dissolve exists to remove.
                  key={`${activeDeckId ?? room.active_deck_id ?? ''}-${room.current_slide}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={SLIDE_FADE}
                  className="absolute inset-0"
                >
                  <Image
                    src={slideUrl}
                    alt={`Slide ${currentPage}`}
                    fill
                    className="object-contain"
                    priority
                    unoptimized
                  />
                </motion.div>
              </AnimatePresence>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            )}
            {renderSlideOverlay?.(room.current_slide)}
          </div>

          {topLeftOverlay}
          {endClassOverlay}
          {blankBanner}
          {nextSlidePreview}
          {/* Session title — subtle, centered in the top letterbox margin.
              Hidden in fullscreen to keep the projected stage clean. */}
          {!isFullscreen && (
            <div className="pointer-events-none absolute top-3 left-1/2 z-10 max-w-[45%] -translate-x-1/2 truncate rounded-full bg-card/80 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-md">
              <LiveClassName name={room.name} createdAt={room.created_at} />
            </div>
          )}
        </div>

        {addDeckDialog}

        {/* Unified control bar. A @container so the row reflows on the bar's
            own width (the sidebar inset shrinks it, not the viewport): the
            annotation toolbar drops to its own centered second row once the bar
            is narrower than ~880px, so it never overflows on laptops with the
            sidebar open, small screens, or mobile. */}
        <div
          className={`@container shrink-0 ${
            isFullscreen ? 'px-4 sm:px-6 py-2' : 'px-3 sm:px-4 pb-2.5 pt-1'
          }`}
        >
          {!isFullscreen && <div className="mb-1.5">{progressBar}</div>}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {/* Left: slide navigation */}
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handlePrev}
                    disabled={atStart}
                    className="rounded-full h-9 w-9 border bg-card border-border hover:bg-accent disabled:opacity-40"
                    aria-label="Previous slide"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Previous (←)</TooltipContent>
              </Tooltip>

              <div className="flex items-baseline gap-1 px-3 py-1 rounded-full border bg-card border-border min-w-24 justify-center">
                <span className="text-lg font-semibold leading-none tracking-tight tabular-nums">
                  {currentPage}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  / {totalPages}
                </span>
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleNext}
                    disabled={atEnd}
                    className="rounded-full h-9 w-9 border bg-card border-border hover:bg-accent disabled:opacity-40"
                    aria-label="Next slide"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Next (→)</TooltipContent>
              </Tooltip>
            </div>

            {/* Center: annotation toolbar. Its own centered second row
                (order-last basis-full) while the bar is narrow — keeping the
                373px toolbar off the nav/status row so nothing overflows — then
                inline & centered between the nav and the status cluster once the
                bar is wide enough (≈880px) to seat the whole row on one line —
                with headroom for the widest status cluster (Engage button plus
                a live reaction pill). */}
            <div
              id="lc-annotation-toolbar-slot"
              className="order-last basis-full flex items-center justify-center min-w-0 empty:hidden @min-[880px]:order-none @min-[880px]:basis-auto @min-[880px]:flex-1"
            />

            {/* Right: status items + fullscreen. End class moved to a top-right
                overlay on the slide stage. ml-auto keeps this cluster hard-right
                on the top row in the wrapped (narrow) layout. */}
            {/* flex-wrap: the row around this already wraps, but the cluster
                itself held six controls plus dividers in one unwrappable line,
                so on a phone its right-hand end (projector, Engage, fullscreen)
                was simply clipped off the stage. Wrapping keeps every control
                reachable — reflow, not hide, same as the toolbar slot above. */}
            <div className="ml-auto @min-[880px]:ml-0 flex flex-wrap items-center justify-end gap-2">
              {statusSlot?.(isFullscreen)}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={toggleFullscreen}
                    className="rounded-full h-9 w-9 border bg-card border-border hover:bg-accent"
                    aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                  >
                    {isFullscreen ? (
                      <Minimize2 className="h-4 w-4" strokeWidth={2} />
                    ) : (
                      <Maximize2 className="h-4 w-4" strokeWidth={2} />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)'}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
        {/* Scoped Toaster: a DESCENDANT of the fullscreen element, so its toasts are
            painted in the top layer while presenting. The app-level Toaster lives on
            document.body and is invisible in fullscreen — which meant a failed
            advanceSlide/endRoom showed the professor nothing at all (#653). Mounted
            only while fullscreen so there is exactly one Toaster listening otherwise;
            two would double every toast in the app. */}
        {isFullscreen && <Toaster richColors position="top-right" />}
      </div>
      </PortalContainerProvider>
    </TooltipProvider>
  )
}
