// Slide, blank, deck-render and ended state for the Live Classroom deck UI.
//
// It consumes a bus the CALLER owns. It never opens a connection, and there is
// deliberately no variant that does.
//
// Why (#639): the student page used to mount two. StudentClassroomView opened one for
// polls and questions, and the StudentLiveView inside it called a self-connecting
// useSlideSync for the slide. Two sockets to the same room, two reconnect loops with
// independent backoff, two replay cursors. A ~12s wifi drop could bring the poll channel
// back and not the slide one, so the student watched a stale slide for the rest of the
// lecture while interactions kept arriving, with nothing on screen to say so. Only a
// reload fixed it. The professor dashboard had the same double mount via LivePresenter.
//
// The self-connecting variant was deleted rather than deprecated: leaving a
// convenient-looking useSlideSync(roomId) in place is how the second connection comes
// back. Pages own their one connection (ClassroomDashboard, StudentClassroomView,
// ProjectorView); children take the bus as a prop.

'use client'

import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { getRoomSnapshot } from '@/lib/live-classroom/snapshot'
import type { LcRoom } from '@/lib/validations/live-classroom'
import type { EventBus } from './event-bus'
import type { LcEnvelope } from './types'

/** Refresh signed slide URLs ~15 minutes before the 6h TTL elapses.
 *  Sessions ~never run that long, but a single refresh covers the edge
 *  without hammering the server with periodic polling. */
const SLIDE_URL_REFRESH_MS = (6 * 60 - 15) * 60 * 1000

/** Live deck-render state. Populated by deck_render_progress and
 *  deck_failed broadcasts. `null` means idle (no render in flight or
 *  prior render already finished). */
export interface DeckRenderState {
  pagesRendered: number
  totalPages: number
  failed: boolean
  /** Stable reason key when failed=true. */
  reason?: 'convert' | 'render' | 'upload' | 'unknown'
  /** 1-based page index where it failed (when known). */
  page?: number
}

export interface UseSlideStateOptions {
  /** The bus of a channel the CALLER owns. Never opened here. */
  bus: EventBus
  roomId: string
  /** Room as of the caller's snapshot. Slide events patch this forward. */
  initialRoom: LcRoom
  /** Signed slide URLs as of the caller's snapshot. */
  initialSlideUrls: string[]
}

export interface UseSlideStateResult {
  room: LcRoom
  deckRender: DeckRenderState | null
  slideUrls: string[]
  resetDeckRender: () => void
}

/**
 * Slide, blank, deck and ended state driven off a bus the caller already owns.
 *
 * The listeners register on mount with a real room already in hand, so there is no
 * window where a slide_changed is emitted to a bus nobody is listening on. That window
 * was the second half of #639: useRoomChannel replays immediately on mount, useSlideSync
 * gated its listeners behind its own snapshot arriving, and any slide change replayed in
 * between was dispatched to nothing. The channel had already recorded that event's seq,
 * so no later replay would ever hand it over again — the loss was permanent, and the
 * student's slide simply stopped where it was.
 */
export function useSlideState({
  bus,
  roomId,
  initialRoom,
  initialSlideUrls,
}: UseSlideStateOptions): UseSlideStateResult {
  const [room, setRoom] = useState<LcRoom>(initialRoom)
  const [slideUrls, setSlideUrls] = useState<string[]>(initialSlideUrls)
  const [deckRender, setDeckRender] = useState<DeckRenderState | null>(null)

  const refreshSnapshot = useCallback(async () => {
    try {
      const result = await getRoomSnapshot(roomId)
      if (result.error || !result.snapshot) {
        logger.warn('useSlideState.refreshSnapshot: failed', { roomId, error: result.error })
        return
      }
      setRoom(result.snapshot.room)
      setSlideUrls(result.snapshot.slideUrls)
    } catch (err) {
      logger.warn('useSlideState.refreshSnapshot: threw', { roomId, err: String(err) })
    }
  }, [roomId])

  /* Long-session TTL refresh. The signed URLs have a 6h TTL; a class that runs past
     5h45m would otherwise start 401ing on slide images mid-lecture. */
  useEffect(() => {
    const id = setTimeout(() => {
      void refreshSnapshot()
    }, SLIDE_URL_REFRESH_MS)
    return () => clearTimeout(id)
  }, [refreshSnapshot])

  useEffect(() => {
    const offSlide = bus.on('slide_changed', (evt: LcEnvelope<'slide_changed'>) => {
      setRoom((prev) => ({ ...prev, current_slide: evt.data.slideIndex }))
    })
    const offBlank = bus.on('screen_blank_changed', (evt: LcEnvelope<'screen_blank_changed'>) => {
      setRoom((prev) => ({ ...prev, is_blanked: evt.data.isBlanked }))
    })
    const offEnded = bus.on('room_ended', () => {
      setRoom((prev) => ({ ...prev, status: 'ended' }))
    })
    /* deck_ready fires on the initial render AND on any re-upload (mig 49 broadened the
       trigger to any deck_url change). The signed URLs in slideUrls are scoped to the
       PRIOR deck_url, so a re-snapshot is required to pick up the new versioned path. */
    const offDeck = bus.on('deck_ready', (evt: LcEnvelope<'deck_ready'>) => {
      setRoom((prev) => ({
        ...prev,
        deck_url: evt.data.deckUrl,
        deck_page_count: evt.data.deckPageCount,
      }))
      setDeckRender(null)
      void refreshSnapshot()
    })
    /* Per-page progress while the prof's PDF converts server-side. The prof sees a
       granular "X / Y"; the student-facing UI ignores the count and shows a calm wait. */
    const offProgress = bus.on('deck_render_progress', (evt: LcEnvelope<'deck_render_progress'>) => {
      setDeckRender({
        pagesRendered: evt.data.pagesRendered,
        totalPages: evt.data.totalPages,
        failed: false,
      })
    })
    const offFailed = bus.on('deck_failed', (evt: LcEnvelope<'deck_failed'>) => {
      setDeckRender({
        pagesRendered: 0,
        totalPages: 0,
        failed: true,
        reason: evt.data.reason,
        page: evt.data.page,
      })
    })
    return () => {
      offSlide()
      offBlank()
      offEnded()
      offDeck()
      offProgress()
      offFailed()
    }
  }, [bus, refreshSnapshot])

  const resetDeckRender = useCallback(() => setDeckRender(null), [])

  return { room, deckRender, slideUrls, resetDeckRender }
}
