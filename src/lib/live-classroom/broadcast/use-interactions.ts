// Hook that exposes the live state of polls + quizzes in a room. Hydrates
// from getRoomSnapshot, then listens for interaction_* and aggregate_updated
// events on the broadcast channel and patches local state in place.

'use client'

import { useEffect, useState } from 'react'
import type { EventBus } from './event-bus'
import type { LcEnvelope } from './types'
import type { SnapshotInteraction } from '@/lib/live-classroom/snapshot'

export interface UseInteractionsResult {
  /** Polls + quizzes only, in 'draft' or 'open' status. */
  openInteractions: SnapshotInteraction[]
  /** Polls + quizzes that have been closed during this session. */
  closedInteractions: SnapshotInteraction[]
  /** Map of interactionId → aggregate payload from aggregate_updated events. */
  aggregatesById: Record<string, Record<string, unknown>>
}

interface Options {
  bus: EventBus
  initialOpenInteractions: SnapshotInteraction[]
}

export function useInteractions({ bus, initialOpenInteractions }: Options): UseInteractionsResult {
  const [openInteractions, setOpenInteractions] = useState<SnapshotInteraction[]>(initialOpenInteractions)
  const [closedInteractions, setClosedInteractions] = useState<SnapshotInteraction[]>([])
  const [aggregatesById, setAggregatesById] = useState<Record<string, Record<string, unknown>>>(() => {
    const seed: Record<string, Record<string, unknown>> = {}
    for (const i of initialOpenInteractions) {
      const counts = (i.payload?.counts as Record<string, unknown> | undefined) ?? null
      if (counts) seed[i.id] = counts
    }
    return seed
  })

  useEffect(() => {
    const offCreated = bus.on('interaction_created', (evt: LcEnvelope<'interaction_created'>) => {
      if (evt.data.kind === 'question') return
      setOpenInteractions((prev) => {
        if (prev.some((i) => i.id === evt.data.id)) return prev
        return [
          ...prev,
          {
            id: evt.data.id,
            room_id: '',
            kind: evt.data.kind,
            payload: evt.data.payload,
            status: evt.data.status,
            created_by: '',
            created_at: evt.ts,
            // AI quizzes are inserted already-open (no later interaction_opened
            // event), so capture opened_at from the event timestamp here.
            // Draft interactions get it on the interaction_opened event below.
            // Without this, an open-on-create quiz has a null opened_at and the
            // student countdown can't tick (stays frozen at the full limit).
            opened_at: evt.data.status === 'open' ? evt.ts : null,
            closed_at: null,
          } as SnapshotInteraction,
        ]
      })
    })

    const offOpened = bus.on('interaction_opened', (evt: LcEnvelope<'interaction_opened'>) => {
      setOpenInteractions((prev) =>
        prev.map((i) =>
          i.id === evt.data.id ? { ...i, status: 'open', opened_at: evt.ts } : i,
        ),
      )
    })

    const offClosed = bus.on('interaction_closed', (evt: LcEnvelope<'interaction_closed'>) => {
      setOpenInteractions((prev) => {
        const closing = prev.find((i) => i.id === evt.data.id)
        if (closing) {
          // Dedupe by id: this updater can run more than once for a single close
          // — React StrictMode double-invokes state updaters in dev, and a close
          // can arrive via both replay and live delivery — which would otherwise
          // append the same interaction twice and produce duplicate React keys.
          setClosedInteractions((c) =>
            c.some((x) => x.id === evt.data.id)
              ? c
              : [...c, { ...closing, status: 'closed', closed_at: evt.ts }],
          )
        }
        return prev.filter((i) => i.id !== evt.data.id)
      })
    })

    const offAgg = bus.on('aggregate_updated', (evt: LcEnvelope<'aggregate_updated'>) => {
      setAggregatesById((prev) => ({
        ...prev,
        [evt.data.interactionId]: (evt.data.aggregate ?? {}) as Record<string, unknown>,
      }))
    })

    return () => {
      offCreated()
      offOpened()
      offClosed()
      offAgg()
    }
  }, [bus])

  return { openInteractions, closedInteractions, aggregatesById }
}
