// `useBakeWatch` is the roadmap's watcher for work nothing notifies it about: a
// node's quick-check questions are written by a background job, so the map has to
// look again until they land.
//
// Every rule below is a bug that was live at some point, and all four are about
// NOT becoming a standing poll on the heaviest page in the app. They're tested
// here rather than through the canvas because the canvas is a 3700-line client
// component (reactflow, framer-motion, the annotation layer) — mounting it to
// observe a timer would measure everything except the timer.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBakeWatch } from '@/lib/roadmap/use-bake-watch'

const MS = 1000
const MAX = 3

/** jsdom reports 'visible'; both states have to be forced. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

afterEach(() => {
  setVisibility('visible')
  vi.useRealTimers()
})

describe('useBakeWatch', () => {
  it('does not tick at all while nothing is being written', async () => {
    // The whole point of `active`: no baking node, no timer. A standing poll on
    // this page would re-run the roadmap's entire assembly forever.
    vi.useFakeTimers()
    const onTick = vi.fn()
    renderHook(() => useBakeWatch({ active: false, busy: false, onTick, intervalMs: MS, maxTicks: MAX }))

    await vi.advanceTimersByTimeAsync(MS * 10)
    expect(onTick).not.toHaveBeenCalled()
  })

  it('retires on the tick budget even though the work never finished', async () => {
    vi.useFakeTimers()
    const onTick = vi.fn()
    const onGiveUp = vi.fn()
    renderHook(() => useBakeWatch({ active: true, busy: false, onTick, onGiveUp, intervalMs: MS, maxTicks: MAX }))

    await vi.advanceTimersByTimeAsync(MS * 20)
    expect(onTick).toHaveBeenCalledTimes(MAX)
    // And it SAYS so. Clearing the interval while leaving the caller's state set
    // was the bug: the node kept shimmering and promising questions forever.
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })

  it('spends the budget on the clock, not on the requests it managed to make', async () => {
    // The regression this ordering exists for: while the tab is hidden nothing is
    // requested, but the ticks still count. Counting only requests let a
    // backgrounded tab hold the interval open indefinitely and then spend its
    // whole budget the moment it was refocused, an hour later.
    vi.useFakeTimers()
    const onTick = vi.fn()
    setVisibility('hidden')
    renderHook(() => useBakeWatch({ active: true, busy: false, onTick, intervalMs: MS, maxTicks: MAX }))

    await vi.advanceTimersByTimeAsync(MS * 5)
    expect(onTick).not.toHaveBeenCalled()

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(MS * 10)
    expect(onTick).not.toHaveBeenCalled() // budget already gone
  })

  it('skips a tick while a look is in flight, without restarting the budget', async () => {
    /* `busy` is read through a ref on purpose. As a dep it would re-run the
       effect on every look — a fresh interval with a fresh budget each time,
       which is precisely the unbounded poll the budget exists to stop. So:
       flipping it repeatedly must never buy extra ticks. */
    vi.useFakeTimers()
    const onTick = vi.fn()
    let busy = false
    const { rerender } = renderHook(() =>
      useBakeWatch({ active: true, busy, onTick, intervalMs: MS, maxTicks: MAX }),
    )

    busy = true
    rerender()
    await vi.advanceTimersByTimeAsync(MS) // tick 1 — skipped, still counted
    expect(onTick).not.toHaveBeenCalled()

    busy = false
    rerender()
    await vi.advanceTimersByTimeAsync(MS) // tick 2 — fires
    expect(onTick).toHaveBeenCalledTimes(1)

    busy = true
    rerender()
    busy = false
    rerender()
    await vi.advanceTimersByTimeAsync(MS * 10)
    // 3 ticks total ever, whatever `busy` did in between.
    expect(onTick).toHaveBeenCalledTimes(2)
  })

  it('stops when the work finishes, before the budget runs out', async () => {
    vi.useFakeTimers()
    const onTick = vi.fn()
    const onGiveUp = vi.fn()
    let active = true
    const { rerender } = renderHook(() =>
      useBakeWatch({ active, busy: false, onTick, onGiveUp, intervalMs: MS, maxTicks: MAX }),
    )

    await vi.advanceTimersByTimeAsync(MS)
    expect(onTick).toHaveBeenCalledTimes(1)

    active = false
    rerender()
    await vi.advanceTimersByTimeAsync(MS * 10)
    expect(onTick).toHaveBeenCalledTimes(1)
    // Finishing is not giving up — the note goes away because the work is done.
    expect(onGiveUp).not.toHaveBeenCalled()
  })
})
