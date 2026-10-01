// Hook for the Q&A panel. Hydrates from getRoomSnapshot's recentQuestions,
// then listens for interaction_created / interaction_updated / interaction_closed
// for question-kind interactions. Sorts by upvotes desc, then recency desc.

'use client'

import { useEffect, useMemo, useState } from 'react'
import type { EventBus } from './event-bus'
import type { LcEnvelope } from './types'
import type { SnapshotInteraction } from '@/lib/live-classroom/snapshot'

interface Options {
  bus: EventBus
  initialQuestions: SnapshotInteraction[]
}

export function useQuestions({ bus, initialQuestions }: Options) {
  const [questions, setQuestions] = useState<SnapshotInteraction[]>(initialQuestions)

  /* Adopt the snapshot when it ARRIVES, not only at mount.
     `useState(initialQuestions)` captures the first render's value, and the parent renders
     a "joining classroom" placeholder while the snapshot is null — so this hook mounted
     with `[]` and the snapshot's questions never reached state at all. The list was built
     entirely from replayed broadcast events, which was invisible until those events stopped
     carrying `upvotedBy` (#658): the viewer's own upvote state lives ONLY in the snapshot
     (redacted per viewer), so their button stopped showing as voted.

     Merged rather than replaced, because replay may already have applied events for these
     questions — the live `status`/`upvotes` win, and `upvotedBy`/`created_by` are taken
     from the snapshot, which is the only source that carries them. Adjusting state during
     render is React's documented pattern for this and avoids a second paint. */
  const [seededFrom, setSeededFrom] = useState<SnapshotInteraction[] | null>(null)
  if (initialQuestions !== seededFrom && initialQuestions.length > 0) {
    setSeededFrom(initialQuestions)
    setQuestions((prev) => {
      const byId = new Map(prev.map((q) => [q.id, q]))
      for (const snap of initialQuestions) {
        const live = byId.get(snap.id)
        byId.set(
          snap.id,
          live
            ? {
                ...live,
                created_by: snap.created_by,
                payload: { ...snap.payload, ...live.payload, upvotedBy: snap.payload?.upvotedBy },
              }
            : snap,
        )
      }
      return [...byId.values()]
    })
  }

  useEffect(() => {
    const offCreated = bus.on('interaction_created', (evt: LcEnvelope<'interaction_created'>) => {
      if (evt.data.kind !== 'question') return
      setQuestions((prev) => {
        if (prev.some((q) => q.id === evt.data.id)) return prev
        return [
          {
            id: evt.data.id,
            room_id: '',
            kind: 'question',
            payload: evt.data.payload,
            status: evt.data.status,
            created_by: '',
            created_at: evt.ts,
            opened_at: evt.ts,
            closed_at: null,
          } as SnapshotInteraction,
          ...prev,
        ]
      })
    })

    const offUpdated = bus.on('interaction_updated', (evt: LcEnvelope<'interaction_updated'>) => {
      if (evt.data.kind !== 'question') return
      setQuestions((prev) =>
        prev.map((q) =>
          q.id === evt.data.id
            ? {
                ...q,
                status: evt.data.status,
                payload: { ...q.payload, ...((evt.data as { payload?: Record<string, unknown> }).payload ?? {}) },
              }
            : q,
        ),
      )
    })

    const offClosed = bus.on('interaction_closed', (evt: LcEnvelope<'interaction_closed'>) => {
      if (evt.data.kind !== 'question') return
      // The DB trigger only fires ONE event per UPDATE (ELSIF chain). When
      // markQuestionAnswered flips both status='closed' and payload.answered,
      // the status branch wins — meaning the broadcast doesn't carry the
      // updated payload. Mark `answered=true` locally so the UI's
      // "show open / show all" filter behaves correctly.
      setQuestions((prev) =>
        prev.map((q) =>
          q.id === evt.data.id
            ? { ...q, status: 'closed', payload: { ...q.payload, answered: true } }
            : q,
        ),
      )
    })

    return () => {
      offCreated()
      offUpdated()
      offClosed()
    }
  }, [bus])

  // Sorted view — upvotes desc, then created_at desc.
  const sorted = useMemo(() => {
    return [...questions].sort((a, b) => {
      const ua = (a.payload?.upvotes as number | undefined) ?? 0
      const ub = (b.payload?.upvotes as number | undefined) ?? 0
      if (ub !== ua) return ub - ua
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [questions])

  return { questions: sorted }
}
