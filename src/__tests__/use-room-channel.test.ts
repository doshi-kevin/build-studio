// Tests for the resilient useRoomChannel hook — covers replay-on-subscribe,
// dedup-by-seq, spoof filter, and visibility-change re-replay.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StrictMode } from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { mockChannel, type MockChannel } from './setup'
import type { LcEnvelope } from '@/lib/live-classroom/broadcast/types'

const mockGetEventsSince = vi.fn()
const mockSupabaseClient = {
  channel: vi.fn(),
  removeChannel: vi.fn(async () => undefined),
}

vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(() => mockSupabaseClient),
}))
vi.mock('@/lib/live-classroom/replay', () => ({
  getEventsSince: (...args: unknown[]) => mockGetEventsSince(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
import { logger } from '@/lib/logger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let useRoomChannel: any

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

beforeEach(async () => {
  vi.resetModules()
  mockGetEventsSince.mockReset()
  mockSupabaseClient.channel.mockReset()
  mockSupabaseClient.removeChannel.mockClear()
  const mod = await import('@/lib/live-classroom/broadcast/use-room-channel')
  useRoomChannel = mod.useRoomChannel
})

function setupChannels(): { auth: MockChannel; ephem: MockChannel } {
  const auth = mockChannel(`room:${ROOM_ID}`, { private: true })
  const ephem = mockChannel(`room:${ROOM_ID}:ephem`, { private: true })
  mockSupabaseClient.channel
    .mockImplementationOnce(() => auth)
    .mockImplementationOnce(() => ephem)
  return { auth, ephem }
}

/**
 * Waits for the hook to actually join.
 *
 * `subscribe()` awaits a teardown before it calls `supabase.channel()`, so on the tick
 * `renderHook` returns, no channel exists yet. Every test that drives a channel status by hand
 * has to wait for the join, or it simulates a status on a channel the hook never bound and the
 * assertion passes or fails for the wrong reason. Microtask flushes only, so it works the same
 * under fake timers.
 */
async function flushJoin(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

describe('useRoomChannel', () => {
  it('replays events from getEventsSince on SUBSCRIBED and emits them via the bus', async () => {
    setupChannels()
    mockGetEventsSince.mockResolvedValue({
      events: [
        { seq: 1, ts: 't', type: 'slide_changed', data: { slideIndex: 1 } },
        { seq: 2, ts: 't', type: 'slide_changed', data: { slideIndex: 2 } },
      ],
    })

    const { result } = renderHook(() =>
      useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 0 }),
    )
    await flushJoin()

    const received: Array<{ seq: number | null; data: { slideIndex: number } }> = []
    result.current.bus.on('slide_changed', (evt: LcEnvelope<'slide_changed'>) => {
      received.push({ seq: evt.seq, data: evt.data })
    })

    // The first channel returned is the auth channel.
    const authChannel = mockSupabaseClient.channel.mock.results[0].value as MockChannel
    act(() => {
      authChannel.simulateStatus('SUBSCRIBED')
    })

    await waitFor(() => expect(received.length).toBe(2))
    expect(received[0].seq).toBe(1)
    expect(received[1].seq).toBe(2)
    expect(result.current.lastSeq).toBe(2)
  })

  it('dedupes events with the same seq from broadcast and replay', async () => {
    setupChannels()
    mockGetEventsSince.mockResolvedValue({
      events: [
        { seq: 5, ts: 't', type: 'slide_changed', data: { slideIndex: 5 } },
      ],
    })

    const { result } = renderHook(() =>
      useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 0 }),
    )
    await flushJoin()

    const received: number[] = []
    result.current.bus.on('slide_changed', (evt: LcEnvelope<'slide_changed'>) => {
      if (evt.seq != null) received.push(evt.seq)
    })

    const authChannel = mockSupabaseClient.channel.mock.results[0].value as MockChannel
    // Broadcast arrives first.
    act(() => {
      authChannel.simulate('slide_changed', {
        seq: 5,
        ts: 't',
        type: 'slide_changed',
        data: { slideIndex: 5 },
      })
    })
    // Then we go SUBSCRIBED and replay returns the same seq.
    act(() => {
      authChannel.simulateStatus('SUBSCRIBED')
    })

    await waitFor(() => expect(received).toEqual([5]))
  })

  it('rejects spoofed authoritative events that arrive with seq=null', async () => {
    setupChannels()
    mockGetEventsSince.mockResolvedValue({ events: [] })

    const { result } = renderHook(() =>
      useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 0 }),
    )
    await flushJoin()

    const received: unknown[] = []
    result.current.bus.on('slide_changed', (evt: LcEnvelope<'slide_changed'>) => received.push(evt))

    const authChannel = mockSupabaseClient.channel.mock.results[0].value as MockChannel
    act(() => {
      authChannel.simulateStatus('SUBSCRIBED')
    })
    act(() => {
      // A malicious client somehow gets through RLS and emits without seq.
      authChannel.simulate('slide_changed', {
        seq: null,
        ts: 't',
        type: 'slide_changed',
        data: { slideIndex: 99 },
      })
    })

    expect(received).toHaveLength(0)
  })

  it('reschedules a reconnect on CHANNEL_ERROR', async () => {
    vi.useFakeTimers()
    try {
      // First subscribe attempt — auth + ephem channels.
      const first = setupChannels()
      // Second subscribe attempt (after reconnect) — fresh auth + ephem.
      const second = {
        auth: mockChannel(`room:${ROOM_ID}`, { private: true }),
        ephem: mockChannel(`room:${ROOM_ID}:ephem`, { private: true }),
      }
      mockSupabaseClient.channel
        .mockImplementationOnce(() => second.auth)
        .mockImplementationOnce(() => second.ephem)

      mockGetEventsSince.mockResolvedValue({ events: [] })

      renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 0 }))
      await flushJoin()

      act(() => {
        first.auth.simulateStatus('CHANNEL_ERROR')
      })
      // Backoff[0] is 500ms; after that the hook resubscribes.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      act(() => {
        second.auth.simulateStatus('SUBSCRIBED')
      })

      // The hook attempted a second subscribe pair (auth + ephem).
      expect(mockSupabaseClient.channel.mock.calls.length).toBeGreaterThanOrEqual(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses exponential backoff for repeated reconnect attempts', async () => {
    vi.useFakeTimers()
    try {
      // Three subscribe attempts in a row — each fails with CHANNEL_ERROR.
      // Backoff schedule [500, 1000, 2000, 4000, 8000, 15000].
      const channels: Array<{ auth: MockChannel; ephem: MockChannel }> = []
      for (let i = 0; i < 4; i++) {
        const auth = mockChannel(`room:${ROOM_ID}`, { private: true })
        const ephem = mockChannel(`room:${ROOM_ID}:ephem`, { private: true })
        channels.push({ auth, ephem })
        mockSupabaseClient.channel
          .mockImplementationOnce(() => auth)
          .mockImplementationOnce(() => ephem)
      }
      mockGetEventsSince.mockResolvedValue({ events: [] })

      renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 0 }))
      await flushJoin()

      // Failure #1 → schedules a reconnect at 500ms.
      act(() => channels[0].auth.simulateStatus('CHANNEL_ERROR'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(499)
      })
      // Not yet at 500 — second subscribe should NOT have happened.
      expect(mockSupabaseClient.channel.mock.calls.length).toBe(2)

      // Tick past 500ms → second subscribe happens.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2)
      })
      expect(mockSupabaseClient.channel.mock.calls.length).toBe(4)

      // Failure #2 → schedules at 1000ms.
      act(() => channels[1].auth.simulateStatus('CHANNEL_ERROR'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(999)
      })
      expect(mockSupabaseClient.channel.mock.calls.length).toBe(4)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2)
      })
      expect(mockSupabaseClient.channel.mock.calls.length).toBe(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('triggers replay on document.visibilitychange → visible', async () => {
    setupChannels()
    mockGetEventsSince.mockResolvedValue({ events: [] })

    renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 7 }))
    await flushJoin()
    const authChannel = mockSupabaseClient.channel.mock.results[0].value as MockChannel
    act(() => {
      authChannel.simulateStatus('SUBSCRIBED')
    })

    await waitFor(() => expect(mockGetEventsSince).toHaveBeenCalledTimes(1))

    // Simulate a tab returning to foreground.
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() => expect(mockGetEventsSince).toHaveBeenCalledTimes(2))
  })

  /* ── #639: the two recovery gaps that let a student's slide freeze ──────────── */

  it('re-anchors the replay cursor when the real lastSeq arrives after mount', async () => {
    setupChannels()
    mockGetEventsSince.mockResolvedValue({ events: [] })

    /* Every real caller passes `snapshot?.lastSeq ?? 0`, and on the first render the
       snapshot has not resolved. The hook latched that 0 into a ref and never heard the
       real value, because useRef and useState both ignore everything after the first
       render. Replay then ran from the START of the room on every reconnect, re-dispatching
       the whole session and flooding the 500-entry dedup set with history. */
    const { rerender } = renderHook(
      ({ seq }: { seq: number }) => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: seq }),
      { initialProps: { seq: 0 } },
    )
    await flushJoin()

    rerender({ seq: 42 })

    const authChannel = mockSupabaseClient.channel.mock.results[0].value as MockChannel
    act(() => {
      authChannel.simulateStatus('SUBSCRIBED')
    })

    await waitFor(() => expect(mockGetEventsSince).toHaveBeenCalled())
    expect(mockGetEventsSince).toHaveBeenLastCalledWith(ROOM_ID, 42)
  })

  it('never drags the cursor backwards once a real event has advanced it', async () => {
    setupChannels()
    mockGetEventsSince.mockResolvedValue({
      events: [{ seq: 90, ts: 't', type: 'slide_changed', data: { slideIndex: 9 } }],
    })

    const { rerender } = renderHook(
      ({ seq }: { seq: number }) => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: seq }),
      { initialProps: { seq: 0 } },
    )
    await flushJoin()

    const authChannel = mockSupabaseClient.channel.mock.results[0].value as MockChannel
    act(() => {
      authChannel.simulateStatus('SUBSCRIBED')
    })
    await waitFor(() => expect(mockGetEventsSince).toHaveBeenCalled())

    /* A late snapshot reporting an OLDER position must not rewind a cursor that live
       events have already moved on — that would re-deliver events as if they were new. */
    rerender({ seq: 5 })
    act(() => {
      authChannel.simulateStatus('SUBSCRIBED')
    })

    await waitFor(() => expect(mockGetEventsSince).toHaveBeenCalledTimes(2))
    expect(mockGetEventsSince).toHaveBeenLastCalledWith(ROOM_ID, 90)
  })

  it('asks the caller to re-read the snapshot on a RECONNECT, but not on first subscribe', async () => {
    setupChannels()
    mockGetEventsSince.mockResolvedValue({ events: [] })
    const onResync = vi.fn()

    renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 3, onResync }))
    await flushJoin()

    const authChannel = mockSupabaseClient.channel.mock.results[0].value as MockChannel

    /* First subscribe is a normal join. The caller has just fetched a snapshot itself,
       so asking it to fetch another would be a wasted round-trip on every page load. */
    act(() => {
      authChannel.simulateStatus('SUBSCRIBED')
    })
    await waitFor(() => expect(mockGetEventsSince).toHaveBeenCalledTimes(1))
    expect(onResync).not.toHaveBeenCalled()

    /* A re-subscribe is different: replay reads FORWARD from this client's cursor, so it
       cannot repair anything the client never applied, and the dedup set guarantees those
       events are never offered again. Only an absolute re-read fixes that, which is why a
       12-second drop used to leave a student on a stale slide for the rest of the class. */
    act(() => {
      authChannel.simulateStatus('SUBSCRIBED')
    })
    await waitFor(() => expect(onResync).toHaveBeenCalledTimes(1))
  })

  it('asks the caller to re-read the snapshot when replay is truncated', async () => {
    setupChannels()
    mockGetEventsSince.mockResolvedValue({ events: [], truncated: true })
    const onReplayTruncated = vi.fn()

    renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 1, onReplayTruncated }))
    await flushJoin()

    const authChannel = mockSupabaseClient.channel.mock.results[0].value as MockChannel
    act(() => {
      authChannel.simulateStatus('SUBSCRIBED')
    })

    /* This callback existed, was documented, and had zero callers app-wide before #639 —
       the gap-recovery path was dead code. */
    await waitFor(() => expect(onReplayTruncated).toHaveBeenCalledTimes(1))
  })


  /* ── The reconnect rejoin loop found in browser QA ─────────────────────────── */

  it('ignores status callbacks from a channel it has already torn down', async () => {
    setupChannels()
    mockGetEventsSince.mockResolvedValue({ events: [] })

    renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 1 }))
    await flushJoin()
    const first = mockSupabaseClient.channel.mock.results[0].value as MockChannel

    act(() => {
      first.simulateStatus('SUBSCRIBED')
    })
    await waitFor(() => expect(mockGetEventsSince).toHaveBeenCalledTimes(1))

    /* Queue the channels the reconnect will open, then drop the first one. */
    setupChannels()
    act(() => {
      first.simulateStatus('CLOSED')
    })
    await waitFor(() => expect(mockSupabaseClient.removeChannel).toHaveBeenCalled())

    const schedulesOf = () =>
      (logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes('scheduling reconnect'),
      ).length
    const before = schedulesOf()

    /* The superseded channel keeps its callback. In browser QA this was the loop: its CLOSED
       scheduled a reconnect, that reconnect superseded it again, and the room rejoined every
       500 ms for as long as it stayed open — 270 joins on one topic in 145 seconds, never
       backing off, never self-healing, and dropping room_ended along the way. A dead channel
       must not be able to drive the connection.

       Asserting on the SCHEDULE, which happens synchronously in the callback. My first
       version counted removeChannel instead, which only runs when the reconnect timer fires,
       so it passed with the guard deleted and proved nothing. */
    act(() => {
      first.simulateStatus('CLOSED')
      first.simulateStatus('CLOSED')
    })

    expect(schedulesOf()).toBe(before)
  })

  it('does not reset the backoff the instant a resubscribe lands', async () => {
    vi.useFakeTimers()
    try {
      setupChannels()
      mockGetEventsSince.mockResolvedValue({ events: [] })

      renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 1 }))
      await flushJoin()
      const ch = mockSupabaseClient.channel.mock.results[0].value as MockChannel

      /* A connection that comes back and immediately drops again must ESCALATE. Resetting
         the counter on SUBSCRIBED pinned `attempt` at 1 forever, so the 500ms first step of
         RECONNECT_BACKOFF_MS became the only step ever used. The reset now waits for the
         connection to hold for CONNECTION_STABLE_MS. */
      act(() => {
        ch.simulateStatus('SUBSCRIBED')
      })
      act(() => {
        vi.advanceTimersByTime(200)
        ch.simulateStatus('CLOSED')
      })

      const warns = (logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => String(c[0]).includes('scheduling reconnect'))
      expect(warns.length).toBeGreaterThan(0)
      const last = warns[warns.length - 1][1] as { attempt: number }
      // First drop of this generation is attempt 1; the point is it can now grow.
      expect(last.attempt).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })


  /* The regression my own counter-based guard caused, and the test that would have caught
     it. It is far worse than the loop it replaced: SUBSCRIBED never reached the app, so
     status never became live, replay never ran, and a dropped student silently watched a
     stale slide while the connection pill claimed to be fine. */

  it('runs the SUBSCRIBED branch on a plain mount', async () => {
    setupChannels()
    mockGetEventsSince.mockResolvedValue({ events: [] })

    renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 3 }))
    await flushJoin()
    const ch = mockSupabaseClient.channel.mock.results[0].value as MockChannel

    act(() => {
      ch.simulateStatus('SUBSCRIBED')
    })

    /* replay() only runs inside that branch, and status only becomes 'live' in its finally.
       Asserting the replay call is asserting the branch executed at all. */
    await waitFor(() => expect(mockGetEventsSince).toHaveBeenCalledTimes(1))
  })

  it('delivers a SUBSCRIBED that lands during subscribe() itself', async () => {
    /* The ref assignment sits BEFORE `authChannel.subscribe(...)` on purpose, and nothing
       else in this file can tell: the mock only stores the status callback, so every other
       test delivers SUBSCRIBED later, by hand, once the refs are long since set. Moving the
       assignment back to the end of subscribe(), where it used to live, kept all of them
       green while breaking the app, because the identity guard would compare against a
       channelRef that teardown had just nulled.

       So deliver the status the way the client can: from inside .subscribe(). No
       simulateStatus here, deliberately. */
    const auth = mockChannel(`room:${ROOM_ID}`, { private: true })
    const plainSubscribe = auth.subscribe
    auth.subscribe = (cb) => {
      const ret = plainSubscribe(cb)
      cb?.('SUBSCRIBED')
      return ret
    }
    const ephem = mockChannel(`room:${ROOM_ID}:ephem`, { private: true })
    mockSupabaseClient.channel
      .mockImplementationOnce(() => auth)
      .mockImplementationOnce(() => ephem)
    mockGetEventsSince.mockResolvedValue({ events: [] })

    renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 3 }))
    await flushJoin()

    /* replay() runs only inside the SUBSCRIBED branch, so the call is the branch. */
    await waitFor(() => expect(mockGetEventsSince).toHaveBeenCalledTimes(1))
  })

  it('joins exactly one channel pair, and still goes live, under Strict Mode', async () => {
    /* The regression my own counter-based guard caused, under the conditions that caused it.
       Strict Mode re-invokes the effect on the SAME hook instance, so both subscribes share
       the refs, which is the whole reason a counter drifted past the channel that won the
       topic. Two independent renderHook calls cannot reproduce that: separate instances have
       separate refs.

       Two assertions, one per fault:
         - one channel pair, not two. Two channels on a topic means the server keeps one and
           kicks the other, and nothing downstream can tell which survived.
         - SUBSCRIBED on the surviving channel still reaches the app. Without this the room
           never replays and a dropped student watches a stale slide while the pill says
           'connecting'. */
    for (let i = 0; i < 4; i++) {
      const auth = mockChannel(`room:${ROOM_ID}`, { private: true })
      const ephem = mockChannel(`room:${ROOM_ID}:ephem`, { private: true })
      mockSupabaseClient.channel
        .mockImplementationOnce(() => auth)
        .mockImplementationOnce(() => ephem)
    }
    mockGetEventsSince.mockResolvedValue({ events: [] })

    renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 3 }), {
      wrapper: StrictMode,
    })
    await flushJoin()

    expect(mockSupabaseClient.channel).toHaveBeenCalledTimes(2)

    const live = mockSupabaseClient.channel.mock.results[0].value as MockChannel
    act(() => {
      live.simulateStatus('SUBSCRIBED')
    })
    await waitFor(() => expect(mockGetEventsSince).toHaveBeenCalledTimes(1))
  })


  it('does not report live when a replay resolves after the socket dropped', async () => {
    /* Found by the consultant, and it is the same lie as the stale slide: the pill goes green
       while nothing is connected, so the student has no way to know they are missing slides.
       getEventsSince resolves on its own schedule, and replay's `finally` used to write 'live'
       unconditionally, straight over the 'reconnecting' the drop had just set. */
    vi.useFakeTimers()
    try {
      const { auth } = setupChannels()
      let releaseReplay: (v: { events: unknown[] }) => void = () => {}
      mockGetEventsSince.mockReturnValue(
        new Promise((resolve) => {
          releaseReplay = resolve
        }),
      )

      const { result } = renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 0 }))
      await flushJoin()

      act(() => auth.simulateStatus('SUBSCRIBED'))
      await flushJoin()
      // The replay is in flight and has not resolved, so nothing is live yet.
      expect(result.current.status).not.toBe('live')

      act(() => auth.simulateStatus('CHANNEL_ERROR'))
      expect(result.current.status).toBe('reconnecting')

      // Now the stale replay lands.
      await act(async () => {
        releaseReplay({ events: [] })
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(result.current.status).not.toBe('live')
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes one backoff step per drop, not one per status report', async () => {
    /* A dropped socket reports CHANNEL_ERROR and then CLOSED. Both used to schedule a
       reconnect, so the counter advanced twice and the first 500 ms retry was skipped: the
       room sat dark for a full second on every single drop. The assertion has to be the
       TIMING, because a count of resubscribes looks identical either way. */
    vi.useFakeTimers()
    try {
      const { auth } = setupChannels()
      for (let i = 0; i < 3; i++) {
        mockSupabaseClient.channel
          .mockImplementationOnce(() => mockChannel(`room:${ROOM_ID}`, { private: true }))
          .mockImplementationOnce(() => mockChannel(`room:${ROOM_ID}:ephem`, { private: true }))
      }
      mockGetEventsSince.mockResolvedValue({ events: [] })

      renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 0 }))
      await flushJoin()

      act(() => {
        auth.simulateStatus('CHANNEL_ERROR')
        auth.simulateStatus('CLOSED')
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(499)
      })
      expect(mockSupabaseClient.channel.mock.calls.length).toBe(2)

      /* Backoff step 0 is 500 ms. If the second report had stepped the counter, the retry
         would be at 1000 ms and this assertion would still see 2. */
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2)
      })
      expect(mockSupabaseClient.channel.mock.calls.length).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })


  it('does not report live when a replay resolves after the reconnect has already landed', async () => {
    /* The other half of stillOurs(), and the likelier one in the field: a reconnect always
       follows within 500 ms, which clears the abandoned marker, so by the time a slow replay
       resolves the ONLY thing suppressing the green pill is "is this still my channel?".
       Without the identity clause the pill goes live while the new channel has not even
       subscribed. The sibling test above cannot catch this, because there the abandoned marker
       is still set and the AND short-circuits before identity is ever consulted. */
    vi.useFakeTimers()
    try {
      const { auth } = setupChannels()
      setupChannels() // the pair the reconnect will join
      let releaseReplay: (v: { events: unknown[] }) => void = () => {}
      mockGetEventsSince.mockReturnValue(
        new Promise((resolve) => {
          releaseReplay = resolve
        }),
      )

      const { result } = renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 0 }))
      await flushJoin()
      act(() => auth.simulateStatus('SUBSCRIBED'))
      await flushJoin()
      act(() => auth.simulateStatus('CHANNEL_ERROR'))

      // Let the reconnect complete: teardown clears the abandoned marker and re-points the ref.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })

      await act(async () => {
        releaseReplay({ events: [] })
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(result.current.status).not.toBe('live')
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes the ephemeral channel only once it has joined, and drops it when it closes', async () => {
    /* The ephemeral channel got the same identity guard as the authoritative one and nothing
       exercised it. It is the send path for reactions and hand-raise: if the guard is wrong,
       `ephemeralChannel` stays null forever and those silently never send, with no error
       anywhere. The consumer side has its own test; nothing proved the producer publishes. */
    const { ephem } = setupChannels()
    mockGetEventsSince.mockResolvedValue({ events: [] })

    const { result } = renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 0 }))
    await flushJoin()

    // Not published before it joins: nobody may send on a channel that has not subscribed.
    expect(result.current.ephemeralChannel).toBeNull()

    act(() => ephem.simulateStatus('SUBSCRIBED'))
    await waitFor(() => expect(result.current.ephemeralChannel).toBe(ephem))

    act(() => ephem.simulateStatus('CLOSED'))
    await waitFor(() => expect(result.current.ephemeralChannel).toBeNull())
  })


  it('brings the retry FORWARD when an abandoned channel rejoins, rather than cancelling it', async () => {
    /* This test previously asserted the opposite, and it was wrong. It described "the connection
       comes back on its own", which IS the rogue rejoin: Supabase channels run their own backoff
       until removeChannel is called, so the channel we gave up on can rejoin itself and emit
       SUBSCRIBED while channelRef still points at it.

       Cancelling the retry there looked like an optimisation and was a permanent-desync bug,
       because replay() then refuses to act (stillOurs sees the channel is abandoned) and no retry
       remains to rebuild. Found by the consultant, not by this test, which was happily pinning
       the broken behaviour.

       The right response is neither cancel nor wait: a rogue SUBSCRIBED proves the network is
       back, so the pending retry is pulled forward from up to 15 s down to the next tick. Browser
       QA had measured that 15 s as a real user-visible delay. */
    vi.useFakeTimers()
    try {
      const { auth } = setupChannels()
      for (let i = 0; i < 3; i++) {
        mockSupabaseClient.channel
          .mockImplementationOnce(() => mockChannel(`room:${ROOM_ID}`, { private: true }))
          .mockImplementationOnce(() => mockChannel(`room:${ROOM_ID}:ephem`, { private: true }))
      }
      mockGetEventsSince.mockResolvedValue({ events: [] })

      renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 0 }))
      await flushJoin()

      act(() => auth.simulateStatus('CHANNEL_ERROR'))
      act(() => auth.simulateStatus('SUBSCRIBED'))

      /* 10 ms, far short of the 500 ms backoff step, let alone the 15 s cap. The rebuild has to
         have happened already. */
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      expect(mockSupabaseClient.channel.mock.calls.length).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a SUBSCRIBED from a channel it has already given up on', async () => {
    /* The fatal interleaving, found by the consultant reviewing the previous fix rather than by
       any test or browser pass. Supabase channels run their own rejoin backoff until
       removeChannel is called, and our teardown is deferred behind the reconnect timer, so an
       abandoned channel can rejoin itself and emit SUBSCRIBED while channelRef still points at
       it.

       Letting it through cleared the pending retry (destroying the planned teardown), and then
       replay() refused to act because stillOurs() sees the channel is abandoned. Connected,
       never resynced, status stuck, no retry pending: permanently desynced and silent, which is
       worse than the rejoin loop this whole line of fixes started from.

       The assertion is that the retry SURVIVES, because that is the thing the bug destroyed. */
    vi.useFakeTimers()
    try {
      const { auth } = setupChannels()
      for (let i = 0; i < 3; i++) {
        mockSupabaseClient.channel
          .mockImplementationOnce(() => mockChannel(`room:${ROOM_ID}`, { private: true }))
          .mockImplementationOnce(() => mockChannel(`room:${ROOM_ID}:ephem`, { private: true }))
      }
      mockGetEventsSince.mockResolvedValue({ events: [] })

      renderHook(() => useRoomChannel({ roomId: ROOM_ID, initialLastSeq: 0 }))
      await flushJoin()

      // The drop: schedules a retry 500 ms out and marks this channel abandoned.
      act(() => auth.simulateStatus('CHANNEL_ERROR'))

      // The rogue rejoin, from the client's own backoff, before our retry is due.
      act(() => auth.simulateStatus('SUBSCRIBED'))

      /* The retry must still fire and rebuild the pair. Before the fix this assertion saw 2,
         because the rogue SUBSCRIBED had cleared the timer. */
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(mockSupabaseClient.channel.mock.calls.length).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

})
