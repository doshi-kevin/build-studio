// Logic test for the opened_at fix that drives the quiz countdown. The bug:
// AI quizzes are inserted already-open and arrive via `interaction_created`
// (not `interaction_opened`), so the client had opened_at=null and the
// countdown stayed frozen. The hook must capture opened_at from the event ts
// when status is already 'open', while leaving drafts null until they open.
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { EventBus } from '@/lib/live-classroom/broadcast/event-bus'
import { useInteractions } from '@/lib/live-classroom/broadcast/use-interactions'

describe('useInteractions — opened_at propagation', () => {
  it('captures opened_at from the event ts for an open-on-create quiz (AI quiz)', () => {
    const bus = new EventBus()
    const { result } = renderHook(() => useInteractions({ bus, initialOpenInteractions: [] }))

    act(() => {
      bus.emit({
        type: 'interaction_created',
        seq: 1,
        ts: '2026-06-09T01:00:00.000Z',
        data: { id: 'q1', kind: 'quiz', payload: { timeLimitSeconds: 120 }, status: 'open' },
      })
    })

    expect(result.current.openInteractions).toHaveLength(1)
    expect(result.current.openInteractions[0].opened_at).toBe('2026-06-09T01:00:00.000Z')
  })

  it('leaves opened_at null for a draft, then sets it when the quiz is opened (manual quiz)', () => {
    const bus = new EventBus()
    const { result } = renderHook(() => useInteractions({ bus, initialOpenInteractions: [] }))

    act(() => {
      bus.emit({
        type: 'interaction_created',
        seq: 1,
        ts: '2026-06-09T01:00:00.000Z',
        data: { id: 'q1', kind: 'quiz', payload: {}, status: 'draft' },
      })
    })
    expect(result.current.openInteractions[0].opened_at).toBeNull()

    act(() => {
      bus.emit({
        type: 'interaction_opened',
        seq: 2,
        ts: '2026-06-09T01:00:05.000Z',
        data: { id: 'q1', kind: 'quiz', status: 'open' },
      })
    })
    expect(result.current.openInteractions[0].status).toBe('open')
    expect(result.current.openInteractions[0].opened_at).toBe('2026-06-09T01:00:05.000Z')
  })

  it('dedupes closedInteractions when the same close is delivered twice', () => {
    const bus = new EventBus()
    const { result } = renderHook(() => useInteractions({ bus, initialOpenInteractions: [] }))

    act(() => {
      bus.emit({
        type: 'interaction_created',
        seq: 1,
        ts: '2026-06-09T01:00:00.000Z',
        data: { id: 'q1', kind: 'quiz', payload: { questions: [] }, status: 'open' },
      })
    })
    // A close can arrive more than once (replay + live, or StrictMode double-
    // invoke). closedInteractions must not gain a duplicate (→ duplicate keys).
    act(() => {
      bus.emit({
        type: 'interaction_closed',
        seq: 2,
        ts: '2026-06-09T01:00:05.000Z',
        data: { id: 'q1', kind: 'quiz', status: 'closed' },
      })
      bus.emit({
        type: 'interaction_closed',
        seq: 3,
        ts: '2026-06-09T01:00:06.000Z',
        data: { id: 'q1', kind: 'quiz', status: 'closed' },
      })
    })

    expect(result.current.openInteractions).toHaveLength(0)
    expect(result.current.closedInteractions).toHaveLength(1)
    expect(result.current.closedInteractions[0].id).toBe('q1')
  })
})
