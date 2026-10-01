'use client'

/**
 * use-bake-watch — the roadmap's self-retiring watcher for work it can't be told
 * about.
 *
 * A node whose quick-check questions are being written (`Resource.baking`) clears
 * when a background job finishes, and that job notifies nobody. So the map has to
 * look again. The rules below are all about NOT becoming a standing poll on the
 * heaviest read in the app, and each one is a bug that was live at some point:
 *
 *  · It exists only while `active`. No baking node, no timer.
 *  · The budget counts TICKS, not refetches. Counting refetches let a
 *    backgrounded tab hold the interval open indefinitely and then spend its whole
 *    budget the moment it was refocused, an hour later.
 *  · A hidden tab costs a tick, never a refetch.
 *  · `busy` (a refetch already in flight) skips the tick rather than stacking a
 *    second one behind it — read through a ref, because listing it as a dep would
 *    restart the interval on every refetch and reset the budget with it, which is
 *    exactly the unbounded poll the budget exists to stop.
 *
 * Extracted from RoadmapPrototype so those four rules can be tested without
 * mounting a 3700-line canvas (reactflow, framer-motion and all).
 */

import { useEffect, useRef } from 'react'

/** How often the map re-reads itself, and how many ticks it is allowed. Together
 *  ≈ a minute of watching; after that the next page load decides. The cap is the
 *  honest half — the job that clears the state can die, and a shimmer nobody ever
 *  stops is worse than one that gives up. */
export const BAKE_POLL_MS = 4000
export const BAKE_POLL_MAX = 15

export function useBakeWatch({
  active,
  busy,
  onTick,
  onGiveUp,
  intervalMs = BAKE_POLL_MS,
  maxTicks = BAKE_POLL_MAX,
}: {
  /** Something this session started is still being written. */
  active: boolean
  /** A look is already in flight. */
  busy: boolean
  /** Go and look again. */
  onTick: () => void
  /**
   * The budget ran out with the thing still unfinished — so stop CLAIMING it is
   * being written. Clearing the interval alone was the bug: the caller's state
   * stayed set, nothing looked again, and the node sat lit forever. "We stopped
   * watching" is a true thing to show; a frozen shimmer is not.
   */
  onGiveUp?: () => void
  intervalMs?: number
  maxTicks?: number
}): void {
  /* Callbacks and `busy` are read through refs so the interval survives them
     changing. `busy` as a dep would restart the interval on every look and reset
     the budget with it — the unbounded poll the budget exists to stop.
     Written in an effect, not during render: a ref write during render is a
     lint error here (react-hooks/refs) and genuinely unsound under a re-render
     React later discards. */
  const busyRef = useRef(busy)
  const tickRef = useRef(onTick)
  const giveUpRef = useRef(onGiveUp)
  useEffect(() => {
    busyRef.current = busy
    tickRef.current = onTick
    giveUpRef.current = onGiveUp
  }, [busy, onTick, onGiveUp])

  useEffect(() => {
    if (!active) return undefined
    let ticks = 0
    const id = setInterval(() => {
      ticks += 1
      if (ticks > maxTicks) {
        clearInterval(id)
        giveUpRef.current?.()
        return
      }
      if (document.visibilityState !== 'visible' || busyRef.current) return
      tickRef.current()
    }, intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs, maxTicks])
}
