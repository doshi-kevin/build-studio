/**
 * Tests for useSlideState — slide, blank, deck and ended state driven off a bus the
 * CALLER owns.
 *
 * It used to be useSlideSync, which opened its own connection and fetched its own
 * snapshot. That was the whole defect in #639: the student page already had a connection
 * for polls and questions, so the StudentLiveView inside it opened a second one for the
 * slide. Two sockets to the same room, two reconnect loops, two replay cursors. A ~12s
 * wifi drop could restore one and not the other, leaving a student on a stale slide for
 * the rest of the class with nothing on screen to say so. The professor dashboard had the
 * same double mount through LivePresenter.
 *
 * The hook that could open its own connection is gone rather than deprecated, so the
 * single-connection rule cannot be violated by a future caller reaching for the
 * convenient-looking one.
 *
 * The listener behaviour below is unchanged from the old hook and is the point of the
 * component: a slide_changed must move the slide, a room_ended must end the room, and a
 * screen_blank_changed must blank it. What's new is that the room arrives as a prop, so
 * there is no window where the hook is mounted without one — the window in which a
 * replayed slide_changed used to be dispatched to a bus nobody was listening on, and
 * silently lost forever because the channel had already banked its seq.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { LcEnvelope } from '@/lib/live-classroom/broadcast/types'
import type { LcRoom } from '@/lib/validations/live-classroom'

const mockGetRoomSnapshot = vi.fn()
type AnyEnvelope =
  | LcEnvelope<'slide_changed'>
  | LcEnvelope<'room_ended'>
  | LcEnvelope<'screen_blank_changed'>
  | LcEnvelope<'deck_failed'>
let mockBus: { on: ReturnType<typeof vi.fn>; emit: (e: AnyEnvelope) => void }

vi.mock('@/lib/live-classroom/snapshot', () => ({
  getRoomSnapshot: (...args: unknown[]) => mockGetRoomSnapshot(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let useSlideState: any

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

const ROOM = {
  id: ROOM_ID,
  current_slide: 2,
  status: 'live',
  section_id: 's',
  prof_id: 'p',
  deck_url: null,
  deck_page_count: null,
  created_at: 't',
  ended_at: null,
  is_blanked: false,
} as unknown as LcRoom

beforeEach(async () => {
  vi.resetModules()
  mockGetRoomSnapshot.mockReset()

  // Tiny in-test bus mirroring the EventBus surface.
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  mockBus = {
    on: vi.fn((type: string, cb: (e: unknown) => void) => {
      const arr = listeners[type] ?? []
      arr.push(cb)
      listeners[type] = arr
      return () => {
        listeners[type] = (listeners[type] ?? []).filter((x) => x !== cb)
      }
    }),
    emit(event) {
      const arr = listeners[event.type] ?? []
      for (const cb of arr) cb(event)
    },
  }

  const mod = await import('@/lib/live-classroom/broadcast/use-slide-sync')
  useSlideState = mod.useSlideState
})

/** Mount with the caller's bus and snapshot, the way both real parents now do. */
const mount = () =>
  renderHook(() =>
    useSlideState({ bus: mockBus, roomId: ROOM_ID, initialRoom: ROOM, initialSlideUrls: ['u0', 'u1'] }),
  )

describe('useSlideState (#639)', () => {
  it('opens no connection of its own and exposes the room it was given', () => {
    const { result } = mount()

    expect(result.current.room.current_slide).toBe(2)
    expect(result.current.slideUrls).toEqual(['u0', 'u1'])
    /* No snapshot fetch on mount. The parent already did it, and a second fetch here
       was half of the duplicate work this hook existed to stop. */
    expect(mockGetRoomSnapshot).not.toHaveBeenCalled()
  })

  it('registers its listeners immediately, with no window where events are dropped', () => {
    mount()

    /* The listeners are attached during the mounting render rather than behind an
       async snapshot gate. That gate is what let a replayed slide_changed land on a
       bus with no subscriber, and the channel banked the seq so no later replay would
       ever offer it again. */
    const registered = mockBus.on.mock.calls.map((c: unknown[]) => c[0])
    expect(registered).toContain('slide_changed')
    expect(registered).toContain('room_ended')
    expect(registered).toContain('screen_blank_changed')
  })

  it('moves the slide when a slide_changed arrives', () => {
    const { result } = mount()

    act(() => {
      mockBus.emit({ seq: 1, ts: 't', type: 'slide_changed', data: { slideIndex: 5 } } as AnyEnvelope)
    })

    expect(result.current.room.current_slide).toBe(5)
  })

  it('ends the room when a room_ended arrives', () => {
    const { result } = mount()

    act(() => {
      mockBus.emit({ seq: 2, ts: 't', type: 'room_ended', data: {} } as AnyEnvelope)
    })

    expect(result.current.room.status).toBe('ended')
  })

  it('blanks the room when a screen_blank_changed arrives', () => {
    const { result } = mount()

    act(() => {
      mockBus.emit({ seq: 3, ts: 't', type: 'screen_blank_changed', data: { isBlanked: true } } as AnyEnvelope)
    })

    expect(result.current.room.is_blanked).toBe(true)
  })

  it('surfaces a failed deck render so the wait can stop being silent', () => {
    const { result } = mount()

    act(() => {
      mockBus.emit({
        seq: 4,
        ts: 't',
        type: 'deck_failed',
        data: { reason: 'convert', page: 3 },
      } as AnyEnvelope)
    })

    expect(result.current.deckRender).toEqual({
      pagesRendered: 0,
      totalPages: 0,
      failed: true,
      reason: 'convert',
      page: 3,
    })
  })
})
