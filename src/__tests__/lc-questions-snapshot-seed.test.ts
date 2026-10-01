/**
 * useQuestions did `useState(initialQuestions)`, which captures the FIRST render's value —
 * and the parent renders a "joining classroom" placeholder while the snapshot is null, so
 * the hook mounted with `[]` and the snapshot's questions never reached state. The Q&A list
 * was built entirely from replayed broadcast events.
 *
 * That was invisible until those broadcasts stopped carrying `upvotedBy` (#658): the
 * viewer's own upvote state lives ONLY in the snapshot, redacted per viewer, so their
 * button stopped rendering as voted — live AND after a reload. A browser pass caught it.
 *
 * The oracle is that `upvotedBy` from a LATE snapshot survives, while live event data still
 * wins for fields the broadcast owns. Asserting "questions is non-empty" would pass against
 * the old code as soon as any replay event arrived.
 */

import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useQuestions } from '@/lib/live-classroom/broadcast/use-questions'
import type { SnapshotInteraction } from '@/lib/live-classroom/snapshot'

const VIEWER = 'viewer-1'

/** Minimal EventBus double: records handlers so a test can emit into the hook. */
function makeBus() {
  const handlers = new Map<string, Array<(e: unknown) => void>>()
  return {
    bus: {
      on: (type: string, fn: (e: unknown) => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), fn])
        return () => {}
      },
      emit: vi.fn(),
    } as never,
    fire: (type: string, evt: unknown) => {
      for (const fn of handlers.get(type) ?? []) fn(evt)
    },
  }
}

const q = (id: string, over: Record<string, unknown> = {}): SnapshotInteraction =>
  ({
    id,
    room_id: 'r-1',
    kind: 'question',
    status: 'open',
    created_by: 'asker-1',
    created_at: '2026-06-14T10:00:00Z',
    opened_at: null,
    closed_at: null,
    payload: { text: 'Why O(log n)?', upvotes: 1, upvotedBy: [VIEWER], ...over },
  }) as unknown as SnapshotInteraction

describe('useQuestions — a snapshot that arrives after mount', () => {
  it('adopts questions from a snapshot that was empty at mount', () => {
    const { bus } = makeBus()
    const { result, rerender } = renderHook(
      ({ initial }) => useQuestions({ bus, initialQuestions: initial }),
      { initialProps: { initial: [] as SnapshotInteraction[] } },
    )

    // Mounted during the "joining classroom" placeholder — nothing to show yet.
    expect(result.current.questions).toHaveLength(0)

    rerender({ initial: [q('q-1')] })

    expect(result.current.questions).toHaveLength(1)
    // The whole point: the viewer's own upvote state only ever exists in the snapshot.
    expect(result.current.questions[0].payload.upvotedBy).toEqual([VIEWER])
  })

  it("keeps the viewer's upvotedBy when replay already added the question", () => {
    const { bus, fire } = makeBus()
    const { result, rerender } = renderHook(
      ({ initial }) => useQuestions({ bus, initialQuestions: initial }),
      { initialProps: { initial: [] as SnapshotInteraction[] } },
    )

    // A replayed broadcast arrives first — and broadcasts no longer carry upvotedBy (#658).
    act(() =>
      fire('interaction_created', {
        ts: '2026-06-14T10:00:01Z',
        data: { id: 'q-1', kind: 'question', status: 'open', payload: { text: 'Why O(log n)?', upvotes: 1 } },
      }),
    )
    expect(result.current.questions[0].payload.upvotedBy).toBeUndefined()

    // Then the snapshot lands. It is the ONLY source for this field.
    rerender({ initial: [q('q-1')] })

    expect(result.current.questions).toHaveLength(1)
    expect(result.current.questions[0].payload.upvotedBy).toEqual([VIEWER])
  })

  it('lets a LIVE update still win over the snapshot for the fields it owns', () => {
    const { bus, fire } = makeBus()
    const { result, rerender } = renderHook(
      ({ initial }) => useQuestions({ bus, initialQuestions: initial }),
      { initialProps: { initial: [] as SnapshotInteraction[] } },
    )

    act(() =>
      fire('interaction_created', {
        ts: '2026-06-14T10:00:01Z',
        data: { id: 'q-1', kind: 'question', status: 'open', payload: { text: 'Why O(log n)?', upvotes: 7 } },
      }),
    )
    rerender({ initial: [q('q-1', { upvotes: 1 })] })

    // A stale snapshot count must not roll the live count backwards.
    expect(result.current.questions[0].payload.upvotes).toBe(7)
    expect(result.current.questions[0].payload.upvotedBy).toEqual([VIEWER])
  })

  it('does not duplicate a question present in both sources', () => {
    const { bus, fire } = makeBus()
    const { result, rerender } = renderHook(
      ({ initial }) => useQuestions({ bus, initialQuestions: initial }),
      { initialProps: { initial: [] as SnapshotInteraction[] } },
    )
    act(() =>
      fire('interaction_created', {
        ts: '2026-06-14T10:00:01Z',
        data: { id: 'q-1', kind: 'question', status: 'open', payload: { text: 'Why O(log n)?', upvotes: 1 } },
      }),
    )
    rerender({ initial: [q('q-1')] })
    expect(result.current.questions.filter((x) => x.id === 'q-1')).toHaveLength(1)
  })

  it('ignores an empty snapshot rather than clearing live questions', () => {
    const { bus, fire } = makeBus()
    const { result, rerender } = renderHook(
      ({ initial }) => useQuestions({ bus, initialQuestions: initial }),
      { initialProps: { initial: [] as SnapshotInteraction[] } },
    )
    act(() =>
      fire('interaction_created', {
        ts: '2026-06-14T10:00:01Z',
        data: { id: 'q-1', kind: 'question', status: 'open', payload: { text: 'live only', upvotes: 0 } },
      }),
    )
    // A re-render with a still-empty snapshot must not wipe what the stream delivered.
    rerender({ initial: [] })
    expect(result.current.questions).toHaveLength(1)
  })
})
