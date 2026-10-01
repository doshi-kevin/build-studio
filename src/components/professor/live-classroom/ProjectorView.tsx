// Projector View — a passive, student-safe rendering of a live session for the
// projector/second display. Shows ONLY the current slide + the professor's
// annotations; while any poll/quiz is open it shows a generic "answer on your
// device" notice instead of the interaction. No controls, nav, sidebar, or
// composer — the professor keeps driving everything from their dashboard.
//
// No-leak guarantee: the snapshot is fetched via the student-safe path
// (`getRoomSnapshot(roomId, { viewerSafe: true })` → `stripQuizAnswers`), and
// the realtime broadcast is already answer-stripped server-side for every
// client (lc_interactions_after_change trigger). This view never renders
// interaction payload content — only a notice keyed on the interaction kind.

'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, Airplay, FileQuestion, BarChart3, Megaphone } from 'lucide-react'
import { ProjectorJoinCode } from './ProjectorJoinCode'
import { logger } from '@/lib/logger'
import { getRoomSnapshot, type RoomSnapshot } from '@/lib/live-classroom/snapshot'
import { useRoomChannel } from '@/lib/live-classroom/broadcast/use-room-channel'
import { useInteractions } from '@/lib/live-classroom/broadcast/use-interactions'
import { SPRING, SLIDE_FADE } from '@/lib/motion'
import { SlideAnnotationLayer } from '@/components/live-classroom/shared/SlideAnnotationLayer'
import type { LcEnvelope } from '@/lib/live-classroom/broadcast/types'

/** Refresh signed slide URLs ~15 min before the 6h TTL elapses — same window
 *  useSlideState uses — so a projector left open across back-to-back classes
 *  doesn't 401 on the slide images mid-lecture. */
const SLIDE_URL_REFRESH_MS = (6 * 60 - 15) * 60 * 1000

interface Props {
  roomId: string
  /** The room's professor — used as the annotation layer's authorId. */
  userId: string
  /** Attendance code (#82). Fetched server-side by the professor-only page, never through
   *  the snapshot — students call that, and handing them the code defeats the feature.
   *  Null for sessions that predate the feature. */
  joinCode: string | null
}

export function ProjectorView({ roomId, userId, joinCode }: Props) {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [loading, setLoading] = useState(true)

  // Student-safe snapshot fetch on mount. `viewerSafe: true` forces the
  // answer-stripping path even though the caller is the professor.
  useEffect(() => {
    let cancelled = false
    getRoomSnapshot(roomId, { viewerSafe: true })
      .then((result) => {
        if (cancelled) return
        if (result.snapshot) setSnapshot(result.snapshot)
        else logger.warn('ProjectorView: snapshot failed', { error: result.error })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [roomId])

  /* Failed, not slow. getRoomSnapshot returns { error } rather than throwing, so `loading`
     clears with `snapshot` still null and this gate span its spinner forever on a dropped
     fetch. A wall display showing an eternal spinner tells the room nothing.
     A MESSAGE, not a retry button: the projector has a zero-controls spec, so the recovery
     is the professor reloading it, not anyone touching the screen. */
  if (!loading && !snapshot) {
    return (
      <div className="lc-projector h-dvh w-screen bg-background">
        <ProjectorMessage
          title="Couldn't load this classroom"
          body="The connection dropped. Reload this display to try again."
        />
      </div>
    )
  }

  if (loading || !snapshot) {
    return (
      <div className="lc-projector h-dvh w-screen bg-background flex items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // Mount the live view only once the snapshot is in, so useRoomChannel anchors
  // its replay at the real lastSeq and useInteractions seeds from the snapshot's
  // open interactions — otherwise a Projector opened DURING an active quiz (or
  // reconnecting) would miss the notice and replay from seq 0.
  return (
    <ProjectorStage
      roomId={roomId}
      userId={userId}
      joinCode={joinCode}
      snapshot={snapshot}
      setSnapshot={setSnapshot}
    />
  )
}

interface StageProps extends Props {
  snapshot: RoomSnapshot
  setSnapshot: React.Dispatch<React.SetStateAction<RoomSnapshot | null>>
}

function ProjectorStage({ roomId, userId, joinCode, snapshot, setSnapshot }: StageProps) {
  /* "Has the lecture started" has to LATCH. current_slide is a plain pointer that moves both
     ways: handlePrev walks back to 0, and switching the active deck writes 0 outright. Reading
     the overlay straight off `current_slide === 0` meant a professor flipping back to the title
     slide got a full-screen code takeover across the projection, mid-lecture, with nothing on
     that screen to clear it (the projector is spec'd with zero controls). Once the deck has
     moved, it has started, and it stays started. */
  const [hasAdvanced, setHasAdvanced] = useState((snapshot.room.current_slide ?? 0) > 0)
  if (!hasAdvanced && (snapshot.room.current_slide ?? 0) > 0) setHasAdvanced(true)

  const channel = useRoomChannel({
    roomId,
    initialLastSeq: snapshot.lastSeq,
  })

  // Slide / deck / ended state — driven off the broadcast bus, mirroring the
  // student view. We patch the WHOLE snapshot functionally so the annotation
  // layer's activeDeckId + slideAnnotations stay correct across a deck switch
  // (deck_ready replaces the entire snapshot).
  useEffect(() => {
    const offSlide = channel.bus.on('slide_changed', (evt: LcEnvelope<'slide_changed'>) => {
      setSnapshot((prev) =>
        prev ? { ...prev, room: { ...prev.room, current_slide: evt.data.slideIndex } } : prev,
      )
    })
    const offBlank = channel.bus.on('screen_blank_changed', (evt: LcEnvelope<'screen_blank_changed'>) => {
      setSnapshot((prev) =>
        prev ? { ...prev, room: { ...prev.room, is_blanked: evt.data.isBlanked } } : prev,
      )
    })
    const offEnded = channel.bus.on('room_ended', () => {
      setSnapshot((prev) => (prev ? { ...prev, room: { ...prev.room, status: 'ended' } } : prev))
    })
    // deck_ready fires on the initial render and on any deck switch/re-upload.
    // The signed URLs are scoped to the prior deck_url, so re-fetch the
    // (still student-safe) snapshot to pick up the new deck's URLs + strokes.
    const offDeck = channel.bus.on('deck_ready', () => {
      getRoomSnapshot(roomId, { viewerSafe: true }).then((result) => {
        if (result.snapshot) setSnapshot(result.snapshot)
      })
    })
    return () => {
      offSlide()
      offBlank()
      offEnded()
      offDeck()
    }
  }, [channel.bus, roomId, setSnapshot])

  // Long-session signed-URL refresh (see SLIDE_URL_REFRESH_MS).
  useEffect(() => {
    const id = setTimeout(() => {
      getRoomSnapshot(roomId, { viewerSafe: true }).then((result) => {
        if (result.snapshot) setSnapshot(result.snapshot)
      })
    }, SLIDE_URL_REFRESH_MS)
    return () => clearTimeout(id)
  }, [roomId, setSnapshot])

  const { openInteractions } = useInteractions({
    bus: channel.bus,
    initialOpenInteractions: snapshot.openInteractions,
  })

  // The notice shows while ANY poll/quiz is open; it clears when the prof
  // closes them. We render only a generic message keyed on the interaction
  // kind — never the interaction payload.
  const openNow = openInteractions.filter((i) => i.status === 'open')
  const hasOpenInteraction = openNow.length > 0
  const onlyQuizzes = openNow.length > 0 && openNow.every((i) => i.kind === 'quiz')
  const onlyPolls = openNow.length > 0 && openNow.every((i) => i.kind === 'poll')
  const noticeKind: 'quiz' | 'poll' | 'mixed' = onlyQuizzes ? 'quiz' : onlyPolls ? 'poll' : 'mixed'
  // Icon tracks the label: quiz / poll / (mixed → neutral announcement).
  const NoticeIcon = noticeKind === 'poll' ? BarChart3 : noticeKind === 'mixed' ? Megaphone : FileQuestion
  const noticeLabel = noticeKind === 'poll' ? 'Poll' : noticeKind === 'quiz' ? 'Quiz' : 'Live'

  const { room, slideUrls, activeDeckId, slideAnnotations } = snapshot

  if (room.status === 'ended') {
    return (
      <ProjectorMessage title="The class has ended" body="This live session has wrapped up." />
    )
  }

  if (!room.deck_url || room.deck_page_count === null) {
    return (
      <ProjectorMessage
        title="Waiting for slides"
        body="The lecture deck will appear here the moment it's ready."
        spin
      />
    )
  }

  const currentSlide = room.current_slide ?? 0
  const slideUrl = slideUrls[currentSlide] ?? ''
  const isLive = channel.status === 'live'
  const isBlanked = room.is_blanked === true

  return (
    /* `lc-projector` — the wall's own dark scope. It is NOT the presenter's
       `.lc-stage`: that one went light to rescue the controls floating over it,
       and this surface has no controls but would pay the glare. See globals.css. */
    <div className="lc-projector relative h-dvh w-screen bg-background overflow-hidden flex items-center justify-center">
      {/* Passive live indicator — a pulsing dot, no controls. z-50 so it stays
          visible above the blank cover (z-40): a blanked wall must read as
          "paused", not "projector lost signal". */}
      <div className="absolute top-4 left-4 z-50" aria-hidden>
        {isLive ? (
          <span className="lc-live-dot h-2.5 w-2.5 text-success" />
        ) : (
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground/40" />
        )}
      </div>

      {/* Attendance code (#82). Big until the professor advances the deck, then a corner chip
          for the rest of class. Advancing IS the professor starting, and it already arrives on
          the bus, so this needs no new event and no button on a screen nobody touches. See the
          latch above for why it is not read straight off the slide index. */}
      {joinCode && <ProjectorJoinCode code={joinCode} showOverlay={!hasAdvanced} />}

      {/* Slide stage — a little padding off the screen edge + a soft radius so
          the deck reads as a framed surface rather than bleeding to the bezel. */}
      <div className="relative w-full h-full p-4 sm:p-6">
        <div className="relative w-full h-full rounded-xl overflow-hidden ring-1 ring-border/60">
          {slideUrl ? (
            <Image
              src={slideUrl}
              alt={`Slide ${currentSlide + 1}`}
              fill
              className="object-contain"
              priority
              unoptimized
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}
          {activeDeckId && (
            <SlideAnnotationLayer
              mode="view"
              roomId={roomId}
              deckId={activeDeckId}
              slideIndex={currentSlide}
              slideUrl={slideUrl}
              authorId={userId}
              bus={channel.bus}
              initialAnnotations={slideAnnotations}
            />
          )}
        </div>
      </div>

      {/* "Answer on your device" notice — a compact pill anchored at the
          bottom. It uses the dark foreground surface so it reads clearly over
          any slide (light or dark), and the slide stays fully visible above it
          so students can still reference it. Never renders interaction content. */}
      <AnimatePresence>
        {hasOpenInteraction && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={SPRING}
            className="absolute bottom-8 left-1/2 -translate-x-1/2 z-30 pointer-events-none"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-3 rounded-full bg-primary text-primary-foreground shadow-xl pl-4 pr-5 py-3">
              <span className="lc-live-dot h-2.5 w-2.5 text-primary-foreground" aria-hidden />
              <NoticeIcon className="h-5 w-5 opacity-90" aria-hidden />
              <span className="text-base sm:text-lg font-semibold tracking-tight">
                Answer on your device
              </span>
              <span className="text-xs font-medium uppercase tracking-widest opacity-70 border-l border-primary-foreground/25 pl-3">
                {noticeLabel}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Blank screen — the professor blanked the projector (presenter-remote
          "."). A plain black cover above the slide + notice; the tiny live dot
          stays visible so the display doesn't read as powered off.

          `initial={false}`: arriving at an already-blanked room is a STATE, not a
          transition, so it must not animate. `is_blanked` is persisted and comes
          back in the snapshot, so reloading the wall display while blanked used to
          mount the cover at opacity 0 and fade it in over 140ms — painting the
          slide the professor had deliberately hidden, at full brightness, to the
          whole room. The image is `priority` + `unoptimized` and its signed URL is
          usually still in cache, so it really does paint inside that window. A
          live blank/unblank still gets the fade; only the mount is cut. */}
      <AnimatePresence initial={false}>
        {isBlanked && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            // A fast linear tween, not a spring. Blanking is usually "get that
            // off the wall NOW"; a spring's asymptotic tail leaves the slide
            // faintly visible for longer than the professor asked for.
            transition={SLIDE_FADE}
            // `bg-background` is the blackout because this cover only ever
            // renders on the projector, and `.lc-projector` paints pure black.
            // Load-bearing, so it is stated rather than assumed: if the wall
            // ever follows the presenter into a light palette, this stops being
            // a blackout and becomes a lit rectangle glaring off the wall, and
            // it needs its own dark token that day. The live dot stays above it
            // (z-50) so a blanked wall reads as paused, not as dead.
            className="absolute inset-0 z-40 bg-background"
            aria-hidden
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Exported for (projector)/not-found.tsx — the projector's dead ends must use
 * this passive state, never a component with buttons/links: the wall display
 * has a zero-controls spec (the professor drives from their own dashboard).
 */
export function ProjectorMessage({
  title,
  body,
  spin,
}: {
  title: string
  body: string
  spin?: boolean
}) {
  return (
    <div className="lc-projector h-dvh w-screen bg-background flex flex-col items-center justify-center text-center px-6">
      <div className="rounded-full bg-card p-6 mb-7 ring-1 ring-border/60">
        {spin ? (
          <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
        ) : (
          <Airplay className="h-10 w-10 text-muted-foreground" />
        )}
      </div>
      <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-foreground mb-3">{title}</h1>
      <p className="text-base sm:text-lg text-muted-foreground max-w-lg">{body}</p>
    </div>
  )
}
