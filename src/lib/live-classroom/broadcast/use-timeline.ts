// Activity timeline hook. Listens to the room's broadcast bus for
// meaningful lifecycle events and exposes a chronologically-sorted entry
// list for the UI. Seeded from snapshot data so the timeline isn't empty
// when someone joins mid-session.
//
// Intentionally skips high-frequency events (slide_changed, aggregate
// updates, drawing strokes) — those would drown the timeline. Slide
// movements + drawings are visible in their own UI; the timeline is for
// "what happened in this class".

'use client'

import { useEffect, useState } from 'react'
import type { EventBus } from './event-bus'
import type { LcEnvelope } from './types'
import type { RoomSnapshot, SnapshotInteraction } from '@/lib/live-classroom/snapshot'

export type TimelineEntryType =
  | 'class_started'
  | 'poll_created'
  | 'poll_opened'
  | 'poll_closed'
  | 'quiz_created'
  | 'quiz_opened'
  | 'quiz_closed'
  | 'question_asked'
  | 'question_answered'
  | 'class_ended'

export interface TimelineEntry {
  /** Stable unique key — usually `${type}:${interactionId}` so we can dedup. */
  id: string
  type: TimelineEntryType
  /** ISO timestamp, used for sorting + relative-time display. */
  timestamp: string
  title: string
  /** Optional second-line context (e.g. the poll question text). */
  detail?: string
  /** True when this entry represents the most recent state for its kind —
   *  used so the timeline doesn't show "Poll created … Poll opened" cluttered. */
  meta?: { interactionId?: string; anonymous?: boolean; authorName?: string }
}

interface Options {
  bus: EventBus
  snapshot: RoomSnapshot | null
}

function entryFromSnapshotInteraction(i: SnapshotInteraction): TimelineEntry[] {
  const out: TimelineEntry[] = []
  if (i.kind === 'question') {
    const anonymous = (i.payload.anonymous as boolean | undefined) ?? false
    const authorName = i.payload.authorName as string | undefined
    out.push({
      id: `question_asked:${i.id}`,
      type: 'question_asked',
      timestamp: i.created_at,
      title: anonymous ? 'Anonymous question' : `${authorName ?? 'A student'} asked`,
      detail: (i.payload.text as string | undefined) ?? '',
      meta: { interactionId: i.id, anonymous, authorName },
    })
    const answered =
      ((i.payload.answered as boolean | undefined) ?? false) || i.status === 'closed'
    if (answered) {
      out.push({
        id: `question_answered:${i.id}`,
        type: 'question_answered',
        timestamp: i.closed_at ?? i.created_at,
        title: 'Question answered',
        detail: (i.payload.text as string | undefined) ?? '',
        meta: { interactionId: i.id },
      })
    }
    return out
  }
  // poll / quiz
  const isPoll = i.kind === 'poll'
  const subject = isPoll
    ? ((i.payload.question as string | undefined) ?? 'Poll')
    : ((i.payload.title as string | undefined) ?? 'Quiz')
  out.push({
    id: `${i.kind}_created:${i.id}`,
    type: isPoll ? 'poll_created' : 'quiz_created',
    timestamp: i.created_at,
    title: isPoll ? 'Poll created' : 'Quiz created',
    detail: subject,
    meta: { interactionId: i.id },
  })
  if (i.opened_at) {
    out.push({
      id: `${i.kind}_opened:${i.id}`,
      type: isPoll ? 'poll_opened' : 'quiz_opened',
      timestamp: i.opened_at,
      title: isPoll ? 'Poll opened' : 'Quiz opened',
      detail: subject,
      meta: { interactionId: i.id },
    })
  }
  if (i.closed_at) {
    out.push({
      id: `${i.kind}_closed:${i.id}`,
      type: isPoll ? 'poll_closed' : 'quiz_closed',
      timestamp: i.closed_at,
      title: isPoll ? 'Poll closed' : 'Quiz closed',
      detail: subject,
      meta: { interactionId: i.id },
    })
  }
  return out
}

export function useRoomTimeline({ bus, snapshot }: Options): TimelineEntry[] {
  const [entries, setEntries] = useState<TimelineEntry[]>([])

  // Seed from snapshot every time the room changes. This is fine to
  // re-run because we dedup by id.
  useEffect(() => {
    if (!snapshot) return
    const seed: TimelineEntry[] = []
    seed.push({
      id: `class_started:${snapshot.room.id}`,
      type: 'class_started',
      timestamp: snapshot.room.created_at,
      title: 'Class started',
    })
    const allInteractions: SnapshotInteraction[] = [
      ...snapshot.openInteractions,
      ...(snapshot.closedInteractions ?? []),
      ...snapshot.recentQuestions,
    ]
    for (const i of allInteractions) {
      seed.push(...entryFromSnapshotInteraction(i))
    }
    if (snapshot.room.status === 'ended' && snapshot.room.ended_at) {
      seed.push({
        id: `class_ended:${snapshot.room.id}`,
        type: 'class_ended',
        timestamp: snapshot.room.ended_at,
        title: 'Class ended',
      })
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEntries((prev) => mergeEntries(prev, seed))
  }, [snapshot])

  // Live bus subscriptions
  useEffect(() => {
    const off: Array<() => void> = []

    off.push(
      bus.on('interaction_created', (evt: LcEnvelope<'interaction_created'>) => {
        const { id, kind, payload, status } = evt.data
        if (kind === 'question') {
          const anonymous = (payload.anonymous as boolean | undefined) ?? false
          const authorName = payload.authorName as string | undefined
          const entry: TimelineEntry = {
            id: `question_asked:${id}`,
            type: 'question_asked',
            timestamp: evt.ts,
            title: anonymous ? 'Anonymous question' : `${authorName ?? 'A student'} asked`,
            detail: (payload.text as string | undefined) ?? '',
            meta: { interactionId: id, anonymous, authorName },
          }
          setEntries((prev) => mergeEntries(prev, [entry]))
          return
        }
        const isPoll = kind === 'poll'
        const subject = isPoll
          ? ((payload.question as string | undefined) ?? 'Poll')
          : ((payload.title as string | undefined) ?? 'Quiz')
        const entry: TimelineEntry = {
          id: `${kind}_created:${id}`,
          type: isPoll ? 'poll_created' : 'quiz_created',
          timestamp: evt.ts,
          title: isPoll ? 'Poll created' : 'Quiz created',
          detail: subject,
          meta: { interactionId: id },
        }
        setEntries((prev) => mergeEntries(prev, [entry]))
        // If a poll/quiz is created already in 'open' state (rare but
        // possible if the prof clicks Push fast), also log the open event.
        if (status === 'open') {
          setEntries((prev) => mergeEntries(prev, [{
            id: `${kind}_opened:${id}`,
            type: isPoll ? 'poll_opened' : 'quiz_opened',
            timestamp: evt.ts,
            title: isPoll ? 'Poll opened' : 'Quiz opened',
            detail: subject,
            meta: { interactionId: id },
          }]))
        }
      }),
    )

    off.push(
      bus.on('interaction_opened', (evt: LcEnvelope<'interaction_opened'>) => {
        const { id, kind } = evt.data
        if (kind === 'question') return // questions auto-open; covered by created
        const isPoll = kind === 'poll'
        setEntries((prev) =>
          mergeEntries(prev, [{
            id: `${kind}_opened:${id}`,
            type: isPoll ? 'poll_opened' : 'quiz_opened',
            timestamp: evt.ts,
            title: isPoll ? 'Poll opened' : 'Quiz opened',
            // detail unknown from event payload; will be enriched by snapshot
          }]),
        )
      }),
    )

    off.push(
      bus.on('interaction_closed', (evt: LcEnvelope<'interaction_closed'>) => {
        const { id, kind } = evt.data
        if (kind === 'question') {
          setEntries((prev) =>
            mergeEntries(prev, [{
              id: `question_answered:${id}`,
              type: 'question_answered',
              timestamp: evt.ts,
              title: 'Question answered',
              meta: { interactionId: id },
            }]),
          )
          return
        }
        const isPoll = kind === 'poll'
        setEntries((prev) =>
          mergeEntries(prev, [{
            id: `${kind}_closed:${id}`,
            type: isPoll ? 'poll_closed' : 'quiz_closed',
            timestamp: evt.ts,
            title: isPoll ? 'Poll closed' : 'Quiz closed',
          }]),
        )
      }),
    )

    off.push(
      bus.on('room_ended', (evt: LcEnvelope<'room_ended'>) => {
        setEntries((prev) =>
          mergeEntries(prev, [{
            id: `class_ended:${evt.ts}`,
            type: 'class_ended',
            timestamp: evt.ts,
            title: 'Class ended',
          }]),
        )
      }),
    )

    return () => {
      off.forEach((fn) => fn())
    }
  }, [bus])

  return entries
}

/** Merge new entries into existing, dedup by id, keep newest timestamp wins
 *  for any duplicate id (so live updates can refine seeded entries with
 *  more accurate detail), and sort newest-first. */
function mergeEntries(prev: TimelineEntry[], incoming: TimelineEntry[]): TimelineEntry[] {
  if (incoming.length === 0) return prev
  const byId = new Map<string, TimelineEntry>()
  for (const e of prev) byId.set(e.id, e)
  for (const e of incoming) {
    const existing = byId.get(e.id)
    if (!existing) {
      byId.set(e.id, e)
    } else {
      // Keep the most informative version: prefer the one with detail,
      // and use the EARLIER timestamp (when it actually happened, not
      // when we noticed it via snapshot).
      byId.set(e.id, {
        ...existing,
        ...e,
        detail: e.detail || existing.detail,
        timestamp:
          new Date(existing.timestamp).getTime() < new Date(e.timestamp).getTime()
            ? existing.timestamp
            : e.timestamp,
      })
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )
}
