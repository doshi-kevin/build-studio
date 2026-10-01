// Student Live View — synced slide viewer with manual navigation.
// Students auto-follow the professor's slide but can browse freely.
// A "Sync" pill appears when out of sync so they can snap back.

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PortalContainerProvider } from '@/components/ui/portal-container'
import { Toaster } from '@/components/ui/sonner'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Airplay,
  Loader2,
  ArrowLeft,
  AlertCircle,
  Maximize2,
  Minimize2,
  BarChart3,
  FileQuestion,
  X,
  ChevronLeft,
  ChevronRight,
  Radio,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useSlideState } from '@/lib/live-classroom/broadcast/use-slide-sync'
import type { EventBus } from '@/lib/live-classroom/broadcast/event-bus'
import type { ConnectionStatus } from '@/lib/live-classroom/broadcast/use-room-channel'
import type { LcRoom } from '@/lib/validations/live-classroom'
import { SPRING, SPRING_SNAPPY, SLIDE_FADE } from '@/lib/motion'
import { LiveClassName } from '@/components/live-classroom/shared/LiveClassName'
import { exitFullscreen as exitFullscreenSafe } from '@/lib/quiz/fullscreen'
import {
  selectFullscreenNotice,
  type FullscreenNoticeCandidate,
} from '@/lib/live-classroom/select-fullscreen-notice'

export type PendingInteraction = FullscreenNoticeCandidate

interface StudentLiveViewProps {
  roomId: string
  sectionId: string
  /**
   * The bus and snapshot state of the connection StudentClassroomView owns.
   *
   * This used to call useRoom(roomId), which opened a SECOND connection to the same
   * room alongside the parent's. The two reconnected independently, so a brief wifi
   * drop could restore polls while leaving the slide frozen for the rest of the
   * lecture (#639). Taking them as props makes the single-connection rule
   * structural: there is no longer a way for this component to open its own.
   */
  bus: EventBus
  initialRoom: LcRoom
  initialSlideUrls: string[]
  connectionStatus: ConnectionStatus
  renderSlideOverlay?: (slideIndex: number) => React.ReactNode
  pendingInteractions?: PendingInteraction[]
  statusSlot?: (isFullscreen: boolean) => React.ReactNode
}

export function StudentLiveView({
  roomId,
  sectionId,
  bus,
  initialRoom,
  initialSlideUrls,
  connectionStatus,
  renderSlideOverlay,
  pendingInteractions = [],
  statusSlot,
}: StudentLiveViewProps) {
  const router = useRouter()
  const { room, deckRender, slideUrls } = useSlideState({
    bus,
    roomId,
    initialRoom,
    initialSlideUrls,
  })
  const containerRef = useRef<HTMLDivElement>(null)
  /* Same fullscreen portal problem as the professor's presenter (#653): a student in
     fullscreen got no toast for a failed sync or a rejected question. State, not a bare
     ref — a ref is null on first render and mutating it does not re-render. */
  const [fullscreenEl, setFullscreenEl] = useState<HTMLDivElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())

  // Manual navigation: null = following professor, number = browsing independently.
  // When the professor lands on the same slide the student is viewing,
  // we treat that as "back in sync" — derived below, no effect needed.
  const [manualSlide, setManualSlide] = useState<number | null>(null)
  const profSlide = room.current_slide ?? 0
  const effectiveManual = manualSlide !== null && manualSlide !== profSlide ? manualSlide : null
  const viewingSlide = effectiveManual ?? profSlide
  const isOutOfSync = effectiveManual !== null

  const handlePrev = useCallback(() => {
    if (room.deck_page_count === null) return
    const target = viewingSlide - 1
    if (target < 0) return
    setManualSlide(target)
  }, [room, viewingSlide])

  const handleNext = useCallback(() => {
    if (room.deck_page_count === null) return
    const target = viewingSlide + 1
    if (target >= room.deck_page_count) return
    setManualSlide(target)
  }, [room, viewingSlide])

  const handleSync = useCallback(() => {
    setManualSlide(null)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      containerRef.current.requestFullscreen()
    }
  }, [])

  const activeNotice = useMemo<PendingInteraction | null>(
    () => selectFullscreenNotice(pendingInteractions, dismissedIds),
    [pendingInteractions, dismissedIds],
  )

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement !== null)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      /* Text entry and dialogs still swallow these keys — typing "s" in the ask-a-
         question box must not jump slides. Plain BUTTONS no longer do (#642): the
         old guard skipped every shortcut whenever focus sat inside one, which is
         exactly where focus lands after clicking Next/Prev — so "s" (jump back to
         the live slide) was dead in the one moment a student browsing slides would
         reach for it. None of the keys handled below collide with button
         activation, which is Space and Enter. */
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable ||
        target?.closest('[role="dialog"], [contenteditable="true"]')
      ) {
        return
      }
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          handlePrev()
          break
        case 'ArrowRight':
          e.preventDefault()
          handleNext()
          break
        case 'f':
        case 'F':
          e.preventDefault()
          toggleFullscreen()
          break
        case 'Escape':
          if (isFullscreen) document.exitFullscreen()
          break
        case 's':
        case 'S':
          if (isOutOfSync) {
            e.preventDefault()
            handleSync()
          }
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFullscreen, toggleFullscreen, handlePrev, handleNext, handleSync, isOutOfSync])

  /* The joining spinner and the snapshot-failed state now live in
     StudentClassroomView, which owns the fetch. This component is only mounted once a
     room is in hand, so there is no loading or null case left to render here. */
  if (room.status === 'ended') {
    return (
      <div className="rounded-3xl ring-1 ring-border/50 shadow-sm bg-background flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <div className="rounded-full bg-muted/40 p-5 mb-6 border border-border">
          <Airplay className="h-9 w-9 text-muted-foreground" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground mb-3">
          The class has ended
        </h2>
        <p className="text-sm text-muted-foreground mb-8 max-w-md">
          Your professor has wrapped up this live session. Catch the recording or notes from the course page.
        </p>
        <Button
          onClick={() => router.push(`/student/courses/${sectionId}/live-classroom`)}
          className="rounded-full px-6"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Live Classroom
        </Button>
      </div>
    )
  }

  if (!room.deck_url || room.deck_page_count === null) {
    const failed = deckRender?.failed === true
    return (
      <div className="rounded-3xl ring-1 ring-border/50 shadow-sm bg-background flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <div className="rounded-full bg-muted/40 p-5 mb-6 border border-border">
          {failed ? (
            <AlertCircle className="h-9 w-9 text-muted-foreground" />
          ) : (
            <Loader2 className="h-9 w-9 animate-spin text-muted-foreground" />
          )}
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground mb-3">
          {failed ? 'Upload failed' : 'Waiting for class to start'}
        </h2>
        <p className="text-sm text-muted-foreground max-w-md">
          {failed
            ? "Your professor's upload didn't go through. The slides will appear here automatically as soon as they retry."
            : 'Waiting for the professor to upload the slides. They will appear here automatically the moment they\'re ready.'}
        </p>
      </div>
    )
  }

  const slideUrl = slideUrls[viewingSlide] ?? ''
  const currentPage = viewingSlide + 1
  const totalPages = room.deck_page_count
  const isLive = connectionStatus === 'live'
  const progressPct = totalPages > 0 ? (currentPage / totalPages) * 100 : 0
  const atStart = viewingSlide === 0
  const atEnd = viewingSlide === totalPages - 1

  return (
    <TooltipProvider delayDuration={250}>
      <PortalContainerProvider value={isFullscreen ? (fullscreenEl ?? undefined) : undefined}>
    <motion.div
      ref={(el) => {
        containerRef.current = el
        setFullscreenEl(el)
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={SPRING}
      /* `overflow-clip`, not `overflow-hidden`: hidden still makes this a
         scroll container, so focusing a control past the right edge let the
         browser scroll the whole stage sideways and leave it stuck there. clip
         cannot scroll at all. Same treatment as the professor's presenter. */
      className={`relative overflow-clip flex flex-col bg-background ${
        isFullscreen
          ? 'lc-stage h-screen rounded-none'
          : 'rounded-3xl ring-1 ring-border/50 shadow-sm h-full'
      }`}
    >
      {/* Top-left: connection chip */}
      <div className="absolute top-3 left-3 z-10">
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              /* Elevation, not edge weight — see the professor's chip in
                 LivePresenter for why: over a white slide `bg-card` has no fill
                 contrast and a border alone cannot carry the boundary. */
              className="inline-flex items-center gap-1.5 rounded-full bg-card/80 px-2 py-0.5 shadow-lg ring-1 ring-border backdrop-blur-md"
              role="status"
              aria-live="polite"
              aria-label={isLive ? 'Live' : connectionStatus}
            >
              {isLive ? (
                <span className="lc-live-dot h-1.5 w-1.5 text-success" aria-hidden />
              ) : (
                <span
                  className="inline-flex h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse motion-reduce:animate-none"
                  aria-hidden
                />
              )}
              {!isLive && (
                <span className="text-xs tracking-tight text-muted-foreground">
                  {connectionStatus === 'reconnecting' && 'reconnecting'}
                  {connectionStatus === 'replaying' && 'catching up'}
                  {connectionStatus === 'connecting' && 'connecting'}
                  {connectionStatus === 'closed' && 'offline'}
                </span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isLive ? 'Live · in sync with the professor' : 'Reconnecting to the live class'}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Session title — subtle, centered in the top letterbox margin.
          Hidden in fullscreen to keep the slide stage clean. */}
      {!isFullscreen && room && (
        <div className="pointer-events-none absolute top-3 left-1/2 z-10 max-w-[45%] -translate-x-1/2 truncate rounded-full bg-card/80 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-md">
          <LiveClassName name={room.name} createdAt={room.created_at} />
        </div>
      )}

      {/* Top-right: leave (fullscreen toggle lives in the bottom bar) */}
      {!isFullscreen && (
        <div className="absolute top-3 right-3 z-10">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => router.push(`/student/courses/${sectionId}/live-classroom`)}
                variant="ghost"
                size="sm"
                className="rounded-full h-9 px-3 bg-card/80 text-muted-foreground backdrop-blur-md hover:text-foreground hover:bg-accent"
                aria-label="Leave class"
              >
                <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
                Leave
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Leave the class — rejoin anytime while it&apos;s live
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Fullscreen poll/quiz notification */}
      <AnimatePresence>
        {isFullscreen && activeNotice && (
          <motion.div
            key={activeNotice.id}
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={SPRING}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-auto"
            role="alert"
            aria-live="assertive"
          >
            <div className="flex items-center gap-3 rounded-full bg-card/95 text-foreground shadow-lg ring-1 ring-border backdrop-blur-xl pl-3 pr-2 py-2 max-w-[92vw]">
              <span className="lc-live-dot ml-0.5 h-2 w-2 text-success" aria-hidden />
              {activeNotice.kind === 'quiz' ? (
                <FileQuestion className="h-4 w-4 opacity-80" aria-hidden />
              ) : (
                <BarChart3 className="h-4 w-4 opacity-80" aria-hidden />
              )}
              <div className="flex flex-col leading-tight min-w-0">
                <span className="text-xs font-semibold uppercase tracking-widest opacity-65">
                  New {activeNotice.kind === 'quiz' ? 'quiz' : 'poll'}
                </span>
                <span className="text-sm font-medium truncate max-w-[60vw] sm:max-w-[40vw]">
                  {activeNotice.title}
                </span>
              </div>
              <Button
                onClick={() => void exitFullscreenSafe()}
                size="sm"
                className="rounded-full h-10 px-5 bg-foreground text-background font-semibold hover:bg-foreground/90"
              >
                Answer
              </Button>
              <Button
                onClick={() =>
                  setDismissedIds((prev) => {
                    const next = new Set(prev)
                    next.add(activeNotice.id)
                    return next
                  })
                }
                size="icon"
                variant="ghost"
                className="h-10 w-10 rounded-full opacity-65 hover:opacity-100 hover:bg-accent"
                aria-label="Dismiss notification"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Slide display */}
      <div className={`flex-1 min-h-0 flex items-center justify-center ${isFullscreen ? 'p-2' : 'p-3 sm:p-4'}`}>
        <div
          className={`relative w-full h-full ${
            isFullscreen ? '' : 'aspect-video max-h-[78vh] mx-auto'
          }`}
        >
          {/* Cross-dissolve on slide change — the professor's advance used to
              land as a hard cut with no cue that anything moved. Opacity only:
              the annotation overlay below maps pointer coordinates against its
              own rect, so it deliberately stays outside this subtree. */}
          {slideUrl ? (
            <AnimatePresence initial={false}>
              <motion.div
                key={viewingSlide}
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
          {renderSlideOverlay?.(viewingSlide)}
        </div>
      </div>

      {/* Bottom controls: nav + progress + slide counter.
          A @container, like the professor's bar, so the row reflows on the
          BAR's own width rather than the viewport's — outside fullscreen the
          sidebar insets it, and the viewport knows nothing about that. */}
      {/* `pb-28 lg:pb-2.5` outside fullscreen clears the band the Athena entry
          pill floats in. Once this row wraps on a phone its lower lines land
          under that pill and become unclickable — on-screen but covered, no
          better than the clipping the wrap was added to fix.

          Both numbers are measured, not derived, because the two boxes do not
          share a datum: the pill is `absolute bottom-20 right-4 z-40 lg:bottom-4`
          (AthenaEntryPill) positioned against the dashboard main's padding box,
          while this bar sits inside the course layout's own `p-6`. At 390px the
          pill lands at y 720-764 and, with only 64px reserved, the wrapped
          sync-pill row sat at y 720-756 — its right 55%, including the
          "Slide N" chip, hit-tested to Athena. 112px lifts that row to y 708
          and clears the pill by 12px.

          `lg`, not `md`: the pill itself only drops to `bottom-4` at `lg`, so
          ending the reservation at `md` restored the collision on tablets.
          Fullscreen reserves nothing — Athena is outside the fullscreen element
          and never paints there. */}
      <div
        className={`@container shrink-0 ${
          isFullscreen ? 'px-4 sm:px-6 py-2' : 'px-3 sm:px-4 pb-28 lg:pb-2.5 pt-1'
        }`}
      >
        {/* Progress bar */}
        {/* scaleX, not width: width relays out the bar on every slide change,
            scaleX is compositor-only. Matches the professor's presenter exactly. */}
        <div className="h-1 rounded-full overflow-hidden mb-1.5 bg-muted/60">
          <motion.div
            className="h-full w-full origin-left bg-foreground/80"
            initial={false}
            animate={{ scaleX: progressPct / 100 }}
            transition={SPRING}
          />
        </div>

        {/* Navigation row. `flex-wrap` because all three clusters below are
            structurally incompressible — the nav floors at 184px (min-w-24
            counter plus two shrink-0 buttons), the status cluster is shrink-0,
            and the sync pill is whitespace-nowrap. At 390px the bar has 366px
            to give and the calm state already wanted exactly 366, so a poll or
            an out-of-sync pill pushed Participate and the fullscreen toggle
            clean off the stage. Wrapping costs a row of height and keeps every
            control reachable. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          {/* Prev / counter / Next */}
          <div className="flex items-center gap-2">
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
                  <ChevronLeft className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Previous slide</TooltipContent>
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
                  <ChevronRight className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Next slide</TooltipContent>
            </Tooltip>
          </div>

          {/* Center: sync button. Its own centered second row until the bar is
              wide enough to seat nav + pill + status on one line (184 + 184 +
              158 plus gaps = 550), then inline and centered between them. Same
              order-last/basis-full technique the professor's annotation
              toolbar slot uses. */}
          <div className="order-last basis-full flex items-center justify-center gap-2 min-w-0 empty:hidden @min-[560px]:order-none @min-[560px]:basis-auto @min-[560px]:flex-1">
            <AnimatePresence>
              {isOutOfSync && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: 4 }}
                  transition={SPRING_SNAPPY}
                  className="overflow-visible"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleSync}
                        className="group inline-flex items-center gap-2 rounded-full pl-2.5 pr-1 h-9 text-xs font-semibold bg-foreground text-background shadow-sm transition duration-200 ease-out whitespace-nowrap hover:bg-foreground/90"
                        aria-label={`Jump to the professor's live slide (slide ${profSlide + 1})`}
                      >
                        {/* Live pulse — the professor is presenting elsewhere */}
                        <span className="lc-live-dot h-2 w-2 text-success" aria-hidden />
                        <span className="hidden sm:inline">
                          {viewingSlide < profSlide ? 'Professor moved ahead' : 'You skipped ahead'}
                        </span>
                        <span className="sm:hidden">Out of sync</span>
                        {/* Action chip showing the live slide to jump to */}
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 h-7 bg-background/20"
                        >
                          <Radio className="h-3 w-3" />
                          Slide {profSlide + 1}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      Jump back to the professor&apos;s live slide (press S)
                    </TooltipContent>
                  </Tooltip>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Right: status items (Answer / Participate) + fullscreen toggle.
              Status items hide in fullscreen — the sidebar can't open over a
              fullscreen deck, and active prompts surface via the notice.
              ml-auto keeps this hard-right on the top row while the sync pill
              sits on its own row below. */}
          <div className="ml-auto @min-[560px]:ml-0 flex items-center gap-2 shrink-0">
            {!isFullscreen && statusSlot?.(isFullscreen)}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={toggleFullscreen}
                  variant="ghost"
                  size="icon"
                  className="rounded-full h-9 w-9 border shrink-0 bg-card border-border hover:bg-accent"
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
    </motion.div>
      {/* See the professor presenter: the app Toaster is on document.body and invisible
          in fullscreen. Mounted only while fullscreen so exactly one Toaster listens
          otherwise. */}
      {isFullscreen && <Toaster richColors position="top-right" />}
      </PortalContainerProvider>
    </TooltipProvider>
  )
}
