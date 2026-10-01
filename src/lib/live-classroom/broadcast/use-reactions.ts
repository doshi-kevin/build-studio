// Professor-side reaction aggregator (#36). Listens for `reaction` events on
// the ephemeral topic via the bus and exposes a live, time-decaying count of
// DISTINCT students currently signalling each kind. Ephemeral by design —
// nothing is persisted; a reaction "ages out" of the window so the badges
// reflect the room's pacing right now, not cumulative taps.

'use client'

import { useEffect, useRef, useState } from 'react'
import type { EventBus } from './event-bus'
import type { LcEnvelope, ReactionKind } from './types'
import { REACTION_VISIBLE_MS } from '@/lib/live-classroom/reactions/constants'

/** How long a reaction counts toward the live aggregate before it decays —
 *  shared with the student button's "visible to prof" drain so they match. */
const WINDOW_MS = REACTION_VISIBLE_MS
/** Re-evaluate the window on this cadence so counts decay without new events.
 *  Fine-grained (¼s) so a reaction expires within ~250ms of its true window
 *  rather than lingering up to a full second past it. Cheap because recompute
 *  only re-renders when the counts actually change (see below). */
const TICK_MS = 250

interface TimedReaction {
  kind: ReactionKind
  userId: string
  at: number
}

export type ReactionCounts = Record<ReactionKind, number>

const EMPTY_COUNTS: ReactionCounts = {
  confused: 0,
  slow_down: 0,
  got_it: 0,
  speed_up: 0,
}

/**
 * Count DISTINCT students signalling each kind within the trailing window.
 * Distinct (not raw taps) so one student mashing a button can't skew the
 * pacing signal — "3 confused" means three different people.
 */
export function tallyReactions(
  events: TimedReaction[],
  now: number,
  windowMs: number,
): ReactionCounts {
  const seen: Record<ReactionKind, Set<string>> = {
    confused: new Set(),
    slow_down: new Set(),
    got_it: new Set(),
    speed_up: new Set(),
  }
  for (const e of events) {
    if (now - e.at <= windowMs) seen[e.kind].add(e.userId)
  }
  return {
    confused: seen.confused.size,
    slow_down: seen.slow_down.size,
    got_it: seen.got_it.size,
    speed_up: seen.speed_up.size,
  }
}

export function useReactions(bus: EventBus): ReactionCounts {
  const eventsRef = useRef<TimedReaction[]>([])
  const [counts, setCounts] = useState<ReactionCounts>(EMPTY_COUNTS)

  useEffect(() => {
    const recompute = () => {
      const now = Date.now()
      // Prune aged-out reactions so the buffer can't grow unbounded.
      eventsRef.current = eventsRef.current.filter((e) => now - e.at <= WINDOW_MS)
      const next = tallyReactions(eventsRef.current, now, WINDOW_MS)
      // Only re-render when a count actually changed — otherwise the ¼s tick
      // would re-render the dashboard 4×/sec for nothing.
      setCounts((prev) =>
        prev.confused === next.confused &&
        prev.slow_down === next.slow_down &&
        prev.got_it === next.got_it &&
        prev.speed_up === next.speed_up
          ? prev
          : next,
      )
    }

    const off = bus.on('reaction', (evt: LcEnvelope<'reaction'>) => {
      eventsRef.current.push({
        kind: evt.data.kind,
        userId: evt.data.userId,
        at: Date.now(),
      })
      recompute()
    })
    const tick = setInterval(recompute, TICK_MS)

    return () => {
      off()
      clearInterval(tick)
    }
  }, [bus])

  return counts
}
