// Hook that exposes the live + persisted drawing strokes for a room,
// scoped to the currently-viewed slide. Hydrates from the snapshot's
// slideAnnotations (permanent storage) and listens for live `drawing_stroke`
// plus `drawing_clear` events on the ephemeral topic via the bus.

'use client'

import { useEffect, useMemo, useState } from 'react'
import type { EventBus } from './event-bus'
import type { LcEnvelope } from './types'
import type { Stroke } from '@/lib/live-classroom/drawings/types'

interface Options {
  bus: EventBus
  /** From getRoomSnapshot.slideAnnotations — every stroke ever drawn in
   *  this room across every slide. We filter by current slideIndex
   *  internally so callers don't have to re-pass on slide change. */
  initialAnnotations: Stroke[]
  slideIndex: number
  /** Active deck id. Live strokes and the cleared-slide filter are scoped
   *  to the deck: switching decks resets both so one deck's in-session
   *  strokes (or a cleared-slide flag) never leak onto another deck's same
   *  slide index. initialAnnotations refreshes to the new deck's strokes via
   *  a fresh snapshot on the switch, so old-deck local state must be dropped. */
  deckId: string
}

export function useDrawings({ bus, initialAnnotations, slideIndex, deckId }: Options) {
  // Slides whose snapshot-loaded annotations have been cleared. This is a
  // ONE-WAY filter: once a slide is in the set, its initialAnnotations
  // entries are dropped permanently for this session. New strokes drawn
  // AFTER the clear go into liveBySlide and render fine; we deliberately
  // do NOT "un-clear" on subsequent drawing_stroke events, because that
  // would resurrect the persisted-but-now-deleted strokes (the bug the
  // prof saw: clear → draw red → blue ghosts come back).
  //
  // The DB is the source of truth for new joiners — clearSlideAnnotations
  // already deletes those rows. This local filter keeps the current
  // session in sync with that delete without re-fetching the snapshot.
  const [clearedInitial, setClearedInitial] = useState<Set<number>>(() => new Set())

  const initialForSlide = useMemo(() => {
    if (clearedInitial.has(slideIndex)) return []
    return initialAnnotations.filter((s) => s.slideIndex === slideIndex)
  }, [initialAnnotations, slideIndex, clearedInitial])

  // Live deltas, bucketed BY slide index so in-session strokes survive slide
  // navigation. A single-slot bucket (one slide at a time) silently dropped a
  // slide's fresh strokes the moment a stroke arrived for a different slide —
  // returning to the first slide then showed only what the DB snapshot held at
  // mount. Persisted strokes are never merged back into initialAnnotations, so
  // this map is the only place a session's fresh strokes live until a reload.
  const [liveBySlide, setLiveBySlide] = useState<Record<number, Stroke[]>>(() => ({}))

  // Reset per-deck state on a deck switch (see Options.deckId). Adjusting state
  // during render (the React-recommended "reset on prop change" pattern, keyed
  // off the previous deck id) rather than in an effect avoids a wasted commit +
  // cascading re-render. On a real switch it drops the previous deck's live
  // strokes and cleared-slide flags so they don't bleed onto the new deck.
  const [prevDeckId, setPrevDeckId] = useState(deckId)
  if (prevDeckId !== deckId) {
    setPrevDeckId(deckId)
    setLiveBySlide({})
    setClearedInitial(new Set())
  }

  useEffect(() => {
    const offStroke = bus.on('drawing_stroke', (evt: LcEnvelope<'drawing_stroke'>) => {
      const stroke = evt.data
      setLiveBySlide((prev) => {
        const existing = prev[stroke.slideIndex] ?? []
        // Dedup by id so an echoed broadcast (or addStroke→broadcast race)
        // can't double-render the same stroke.
        if (existing.some((s) => s.id === stroke.id)) return prev
        return { ...prev, [stroke.slideIndex]: [...existing, stroke] }
      })
    })

    const offClear = bus.on('drawing_clear', (evt: LcEnvelope<'drawing_clear'>) => {
      const target = evt.data.slideIndex
      setClearedInitial((prev) => {
        if (prev.has(target)) return prev
        const next = new Set(prev)
        next.add(target)
        return next
      })
      // Drop any live deltas for the cleared slide.
      setLiveBySlide((prev) => (prev[target]?.length ? { ...prev, [target]: [] } : prev))
    })

    return () => {
      offStroke()
      offClear()
    }
  }, [bus])

  const strokes = useMemo(() => {
    return [...initialForSlide, ...(liveBySlide[slideIndex] ?? [])]
  }, [initialForSlide, liveBySlide, slideIndex])

  /**
   * Clear local strokes for the current slide. Permanently filters this
   * slide's initialAnnotations and wipes its live deltas. The broadcast
   * + persistence side is handled by the parent component.
   */
  const clearStrokes = () => {
    setClearedInitial((prev) => {
      if (prev.has(slideIndex)) return prev
      const next = new Set(prev)
      next.add(slideIndex)
      return next
    })
    setLiveBySlide((prev) => (prev[slideIndex]?.length ? { ...prev, [slideIndex]: [] } : prev))
  }

  /**
   * Push a stroke the LOCAL user just drew into our state. Without this,
   * the prof's own strokes only live as bitmap pixels painted directly by
   * the rAF loop — and any canvas-resetting render (fullscreen toggle,
   * window resize) wipes them. Supabase Broadcast doesn't echo `self`
   * sends back, so we have to add the stroke ourselves.
   *
   * Dedup by id keeps things safe in case an echoed broadcast does arrive.
   *
   * Importantly, this does NOT touch clearedInitial — drawing a new stroke
   * after a clear must not resurrect the persisted strokes that the clear
   * just hid.
   */
  const addStroke = (stroke: Stroke) => {
    setLiveBySlide((prev) => {
      const existing = prev[stroke.slideIndex] ?? []
      if (existing.some((s) => s.id === stroke.id)) return prev
      return { ...prev, [stroke.slideIndex]: [...existing, stroke] }
    })
  }

  return { strokes, clearStrokes, addStroke }
}
