'use client'

/**
 * The one global "we heard you" for navigation.
 *
 * WHY THIS EXISTS AT ALL
 * Most heavy routes now have a loading.tsx, and there the skeleton IS the
 * feedback: the URL commits immediately and the page's shape appears. This bar
 * is the safety net for everything else — the routes that still block on the
 * server before painting, where a click otherwise produces nothing at all.
 *
 * WHY IT LISTENS FOR CLICKS
 * The App Router publishes no navigation events, and `useLinkStatus` only works
 * inside an individual <Link> — where it also goes false the instant a
 * loading.tsx mounts, so it cannot drive one global indicator. Noticing an
 * internal anchor activation is the only mechanism left, and it is what the
 * established libraries in this space do as well.
 *
 * Known limitation, deliberately accepted: navigations started by
 * `router.push()` rather than by a link are not caught. Athena already ships
 * its own indicator for the one high-traffic case of that.
 *
 * THE THREE TIMINGS, which are the whole design
 *   delay 100ms   Nothing renders for the first 100ms. Below that a response
 *                 reads as instant, so a bar would invent a wait nobody felt.
 *                 Same delay Next.js uses in its own useLinkStatus reference CSS.
 *   floor 320ms   Once on screen it stays at least this long, so a navigation
 *                 that resolves at 110ms reads as one motion, not a blink.
 *   ceiling 8s    A navigation that never commits must not leave a bar creeping
 *                 for the rest of the session. Arriving late at a finished bar
 *                 is the better failure.
 *
 * Floor and ceiling are the pattern AthenaShell already proved, reused rather
 * than reinvented.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

const SHOW_DELAY_MS = 100
const MIN_VISIBLE_MS = 320
const MAX_VISIBLE_MS = 8000
/** Matches the fade-out below, so the node unmounts only once it is invisible. */
const FADE_MS = 180 // keep in step with --duration-exit in globals.css

type Phase = 'idle' | 'creeping' | 'done'

export function RouteProgress() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [phase, setPhaseState] = useState<Phase>('idle')
  /** False for one frame after mount so the width transition runs from zero. */
  const [grown, setGrown] = useState(false)

  /* Phase is mirrored into a ref because the click listener and the timers are
     installed once and would otherwise close over a stale value. */
  const phaseRef = useRef<Phase>('idle')
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ceilingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shownAt = useRef(0)

  const clearTimers = useCallback(() => {
    for (const t of [showTimer, hideTimer, ceilingTimer]) {
      if (t.current) clearTimeout(t.current)
      t.current = null
    }
  }, [])

  /**
   * The visible half of arriving: snap to full, honour the floor, then unmount.
   * Split out from the route-change effect because it sets state, and setting
   * state synchronously in an effect body cascades renders. Callers reach it
   * from a timer or an animation frame instead.
   */
  const finishVisible = useCallback(() => {
    if (phaseRef.current !== 'creeping') return
    if (ceilingTimer.current) {
      clearTimeout(ceilingTimer.current)
      ceilingTimer.current = null
    }
    setPhase('done')
    const held = Date.now() - shownAt.current
    const remaining = Math.max(0, MIN_VISIBLE_MS - held)
    hideTimer.current = setTimeout(() => setPhase('idle'), remaining + FADE_MS)
  }, [setPhase])

  const start = useCallback(() => {
    clearTimers()
    /* Already on screen, because the user clicked again mid-navigation. Keep it
       visible and keep it creeping toward the new destination; only restart the
       ceiling. Falling through to the normal path here caused two bugs:
         · `setPhase('creeping')` on an already-creeping bar is a no-op, so the
           effect keyed on `phase` never re-ran and `grown` stayed false — the
           bar sat at scaleX(0), invisible, for the whole second navigation.
         · if that second navigation then committed before its show timer fired,
           the route effect took the "cancel a pending show" branch and returned
           early, so `finishVisible` never ran and the bar was stranded in
           `creeping` with no timers left to clear it. */
    if (phaseRef.current === 'creeping') {
      ceilingTimer.current = setTimeout(finishVisible, MAX_VISIBLE_MS)
      return
    }
    setGrown(false)
    showTimer.current = setTimeout(() => {
      showTimer.current = null
      shownAt.current = Date.now()
      setPhase('creeping')
      ceilingTimer.current = setTimeout(finishVisible, MAX_VISIBLE_MS)
    }, SHOW_DELAY_MS)
  }, [clearTimers, finishVisible, setPhase])

  /* A committed route change means we arrived. Cancelling a not-yet-shown bar
     happens synchronously here (no state involved, and it must beat the 100ms
     timer); the visible teardown is deferred a frame so the new route gets to
     paint first and so no setState happens in this effect body. */
  useEffect(() => {
    if (showTimer.current) {
      clearTimeout(showTimer.current)
      showTimer.current = null
      return
    }
    if (phaseRef.current !== 'creeping') return
    const id = requestAnimationFrame(finishVisible)
    return () => cancelAnimationFrame(id)
  }, [pathname, searchParams, finishVisible])

  // Grow on the frame after the bar mounts, so the transition has a zero to
  // start from instead of jumping straight to its target.
  useEffect(() => {
    if (phase !== 'creeping') return
    const id = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(id)
  }, [phase])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Modified clicks open tabs or windows; they never navigate this document.
      if (e.defaultPrevented || e.button !== 0) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return

      const anchor = (e.target as Element | null)?.closest?.('a')
      if (!anchor) return
      if (!anchor.getAttribute('href')) return
      if (anchor.hasAttribute('download')) return
      if (anchor.target && anchor.target !== '_self') return
      /* An explicit opt-out, for a link that cancels its own navigation and
         does something else instead. `defaultPrevented` cannot detect those:
         this listener runs in the CAPTURE phase, before the link's handler —
         and by the time that handler has run, Next's own Link has also called
         preventDefault for every REAL client navigation, so the flag stops
         telling the two apart. Without this the bar creeps for its full
         eight-second ceiling on a click that never navigates. */
      if (anchor.hasAttribute('data-no-route-progress')) return

      let url: URL
      try {
        url = new URL(anchor.href, window.location.href)
      } catch {
        return
      }
      if (url.origin !== window.location.origin) return
      /* Same page or a pure hash jump: no route change is coming, so the bar
         would light up and only ever be cleared by the ceiling. */
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return
      }

      start()
    }

    document.addEventListener('click', onClick, { capture: true })
    return () => document.removeEventListener('click', onClick, { capture: true })
  }, [start])

  useEffect(() => clearTimers, [clearTimers])

  if (phase === 'idle') return null

  const done = phase === 'done'

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden"
    >
      <div
        /* motion-reduce: this bar is raw CSS, not framer, so the root MotionConfig
           does not reach it. Without this it is the one surface in the whole
           system that ignores a reduced-motion preference. */
        className="h-full w-full origin-left bg-primary motion-reduce:transition-none"
        style={{
          transform: done ? 'scaleX(1)' : grown ? 'scaleX(0.9)' : 'scaleX(0)',
          opacity: done ? 0 : 1,
          /* Creeping: a long, heavily decelerating curve is what reads as
             progress rather than as a fixed-length animation — quick off the
             mark, never quite arriving. Done: snap shut, then fade.
             Research is consistent that a progress indicator must never
             decelerate to a stall at the end, which is why arrival is its own
             fast transition rather than the tail of the creep.

             --ease-progress-creep exists solely for this line. It is not a UI
             transition curve and nothing else should reuse it; it is named only
             so that every easing in the app is declared in globals.css. */
          transition: done
            ? `transform 160ms var(--ease-out-quint), opacity ${FADE_MS}ms linear 160ms`
            : 'transform 6s var(--ease-progress-creep)',
        }}
      />
    </div>
  )
}
