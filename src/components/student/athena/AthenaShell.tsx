// Athena Shell — the student-side Athena chrome (docs/designs/athena/athena-students.md §2.1,
// dock v2 / prototype variant 01).
//
// Athena is ONE entry pill (bottom-right), parked exactly where her composer will
// land. Sending from it → the whole app is swallowed into her frame (the gradient
// ring) and the dock unfurls out of that box. ⤢ takes her fullscreen, where the
// course rail stays for navigation; ⤡ comes back; ✕ releases the app.
//
// Three poses, all snapping: closed · docked · fullscreen. Backed by the existing
// ai-tutor chat until athena-core lands; this component is pure chrome + pose.

'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AthenaChat } from './AthenaChat'
import { AthenaEntryPill } from './AthenaEntryPill'
import type { PreviewTarget } from './ChatMessage'
import { useAthenaDriveMode } from '@/lib/hooks/use-athena-drive-mode'
import { useAthenaCourse } from '@/lib/hooks/use-athena-course'
import { writeAthenaPrefill, type PrefillKind } from '@/lib/hooks/use-athena-prefill'
import { safeAppPath } from '@/lib/routes/safe-path'
import { DocumentPagePreview } from '@/components/shared/DocumentPagePreview'
import { SpokenPassage } from './SpokenPassage'
import { hasActiveQuizAttempt } from '@/app/(dashboard)/student/courses/[sectionId]/ai-tutor/actions'

// Routes where a page swap would destroy work in progress: the assignment
// workspace holds its draft and staged files in component state, and being
// pulled out of a live classroom mid-session is its own harm.
const COMPOSE_ROUTE = /\/(assignments|live-classroom|discussions|projects)\/[^/]+/

/** How long "Back to where I was" keeps trying AFTER the navigation has settled,
 *  for content that streams in behind a loading skeleton. The wait for the
 *  navigation itself is not a number at all — see `restoreScroll`. */
const SCROLL_RESTORE_SETTLE_MS = 500
/** Backstop for a return that never settles (an error boundary, a route that
 *  suspends forever). Not the normal exit. */
const SCROLL_RESTORE_CEILING_MS = 8000
/** A page that came back shorter than we left it still gets the student as close
 *  to home as it can — but only if that is nearly all the way. Below this, the top
 *  of the page is less disorienting than the bottom of one they no longer
 *  recognise. */
const SCROLL_RESTORE_TOLERANCE = 0.8
/** The shortest a drive is allowed to read as one motion, so an instant same-page
 *  `?node=` push doesn't flash the ring. A floor, not the whole window — see
 *  `driving` below. */
const DRIVE_FLOOR_MS = 2600
/** …and the longest it may claim to still be travelling. Matches the scroll
 *  restore's own backstop below: past this, a navigation is not slow, it is gone. */
const DRIVE_CEILING_MS = 8000
/** Keys that mean the student has taken the scroll back. */
const SCROLL_KEYS = /^(Arrow(Up|Down)|Page(Up|Down)|Home|End|Space| )$/

/** The frame spans the dashboard `<main>` it sits in — its content box PLUS the
 *  padding the negative margins below cancel (p-4 → 2rem, lg:p-8 → 4rem).
 *
 *  It used to be `calc(100dvh-73px)`, a guess at the header's height. The header
 *  measures 61px, so the frame was 12px SHORT (a dead strip under the pill) —
 *  and the guess fails in the dangerous direction too: every header padding and
 *  the notification button are rem-based, so a larger browser default font size
 *  makes the real header taller than 73px, the frame taller than the box it sits
 *  in, and the dashboard's own scroller gains scroll. Then any scroll of it
 *  carries the dock — composer and entry pill included — off the bottom of the
 *  screen, with nothing to scroll it back. A percentage of the parent is the
 *  same number without the guess, at any header height. */
const FRAME_H = 'h-[calc(100%_+_2rem)] lg:h-[calc(100%_+_4rem)]'

type Pose = 'closed' | 'docked' | 'fullscreen'

/** A drafted form value riding along with a drive (§14.4). */
export interface AthenaPrefill {
  kind: PrefillKind
  text: string
}

/** One accepted drive. Passed as an object rather than five positional
 *  arguments — `said` was the fifth, and that was the point at which the call
 *  site stopped being readable. */
export interface AthenaDrive {
  /** An in-app path the SERVER built from its typed registry. */
  route: string
  /** The navigation card's label: "Challenges · Graph Traversal Sprint". */
  label: string
  /** The receipt sentence: what she did and what is now theirs to do. */
  said: string
  messageId: string
  prefill?: AthenaPrefill
}

/** How far the undo got — the chat's BackLine reads this.
 *
 *  Not a boolean, because "took you back to where you were" is TWO claims and the
 *  second can fail on its own: a page that came back shorter than we left it has
 *  no such place any more, and claiming it anyway is the one part of this the
 *  student can check by looking. `returning` exists so a slow route doesn't read
 *  as a dead click. */
export type AthenaBackState = 'offered' | 'returning' | 'restored' | 'route-only'

interface AthenaShellProps {
  greetingName: string
  children: React.ReactNode
}

export function AthenaShell({ greetingName, children }: AthenaShellProps) {
  /* The section, its code and the professor's toggle used to be props from the
     course layout. The shell now sits a layout above that (§14.7 D1), so they
     arrive from the course's own beacon instead — server-resolved, behind the
     same enrollment check, just delivered sideways. `null` means the student
     hasn't opened a course this session, and Athena stays off screen. */
  const course = useAthenaCourse()
  const sectionId = course?.sectionId ?? ''
  const courseCode = course?.courseCode ?? ''
  const enabled = !!course?.enabled
  const [pose, setPose] = useState<Pose>('closed')
  const open = pose !== 'closed'
  const [everOpened, setEverOpened] = useState(false)
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
  // The last preview is retained (React's "adjust state during render" pattern)
  // so the panel still has a page to show while it slides back out.
  const [shownPreview, setShownPreview] = useState<PreviewTarget | null>(null)
  if (preview && preview !== shownPreview) setShownPreview(preview)
  // Nonce'd so a second "Study with Athena" click (even the same topic) fires again.
  const [topicPrompt, setTopicPrompt] = useState<{ text: string; nonce: number } | undefined>(undefined)
  const topicNonceRef = useRef(0)
  // The dock unfurls out of the pill's footprint — only when it was opened FROM
  // the pill, so a deep link or ⌘J doesn't animate out of a box that wasn't there.
  const [unfurl, setUnfurl] = useState(false)

  // The dock is non-modal (the app stays interactive), so it neither traps Tab
  // nor claims aria-modal — but focus does move into her composer on open and
  // back to the pill on release. Declared up here because the ⌘K handler below
  // needs it (a `const` used before its line is a TDZ crash, not a hoist).
  const hostRef = useRef<HTMLDivElement | null>(null)
  const dockRef = useRef<HTMLDivElement | null>(null)
  const focusComposer = useCallback(() => {
    hostRef.current?.querySelector<HTMLTextAreaElement>('.athena-dock textarea, .athena-fs textarea')?.focus()
  }, [])
  /** The course page's own scroll container (the layout's `<main>`). */
  const pageScroller = useCallback(
    () => hostRef.current?.querySelector<HTMLElement>('.athena-core > main') ?? null,
    [],
  )

  /* The conversation's own Escape rung (dismissing a suggestion she's mulling
     over), handed up by AthenaChat. It lives here so there is exactly ONE Escape
     listener and the layer order is written down in one place instead of falling
     out of which component last re-registered a document handler. */
  const escapeRung = useRef<(() => boolean) | null>(null)
  const registerEscapeRung = useCallback((rung: (() => boolean) | null) => {
    escapeRung.current = rung
  }, [])

  const dock = useCallback(() => {
    setPose((p) => (p === 'closed' ? 'docked' : p))
    setEverOpened(true)
  }, [])
  // Releasing the app also drops the citation preview — it belongs to the chat.
  const release = useCallback(() => {
    setPose('closed')
    setPreview(null)
    setUnfurl(false)
  }, [])

  // ── Athena's one autonomy axis ────────────────────────────────────────────
  // Co-pilot: she opens pages and points. Chat only: she answers and the screen
  // stays put. There is no third notch, because there is nothing else she can do
  // — every tool is read-only and every write still needs the student's click on
  // the real page. A control that gates nothing trains people to click through it.
  const [driveMode, setDriveMode] = useAthenaDriveMode()

  // ── Quiz lockdown (student-visible half) ──────────────────────────────────
  // While a graded attempt is open Athena leaves the screen entirely: no pill,
  // and an open dock closes itself — in every tab, not just the one taking the
  // quiz. The GUARANTEE is still server-side (/api/chat returns 423 before it
  // assembles anything); this is what the student sees. Three signals:
  //   · pathname — instant, this tab, on the attempt screen
  //   · BroadcastChannel — instant, other tabs (any course)
  //   · the server — truth on mount and whenever a tab regains focus, which is
  //     also what releases a lock whose quiz tab was closed or crashed
  const pathname = usePathname()
  /* Athena mounts on every /student/* page now, but only course pages bring
     their own scroller and want the edge-to-edge frame. */
  const inCourse = (pathname ?? '').startsWith('/student/courses/')
  const pathLocked = /\/quizzes\/[^/]+\/(attempt|adaptive)(\/|$)/.test(pathname ?? '')
  const [remoteLocked, setRemoteLocked] = useState(false)
  const quizLocked = pathLocked || remoteLocked

  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === 'undefined') return
    // Not keyed by section: the lock spans every course, so must the signal.
    const ch = new BroadcastChannel('athena-quiz-lock')
    ch.onmessage = (e: MessageEvent<{ locked?: boolean }>) => setRemoteLocked(!!e.data?.locked)
    // The attempt tab is the broadcaster — it's the one that knows from its URL.
    if (pathLocked) ch.postMessage({ locked: true })
    return () => {
      // Leaving the attempt screen (or unmounting) releases the other tabs.
      if (pathLocked) ch.postMessage({ locked: false })
      ch.close()
    }
  }, [enabled, pathLocked])

  useEffect(() => {
    if (!enabled || pathLocked) return
    let cancelled = false
    const check = () => {
      hasActiveQuizAttempt(sectionId).then((locked) => {
        if (!cancelled) setRemoteLocked(locked)
      })
    }
    check()
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, sectionId, pathLocked])

  // Locked ⇒ the dock closes itself, wherever it was open. Adjusted during
  // render (React's documented pattern, as with shownPreview above) so it never
  // paints one frame of an open chat over a quiz.
  if (quizLocked && (open || preview)) {
    setPose('closed')
    setPreview(null)
  }

  // `?athena-topic=` deep link (the roadmap's "Study with Athena" link): open
  // the dock with the question auto-sent into a fresh thread, then strip
  // the param so refreshes don't re-trigger it. useSearchParams (not a
  // mount-only read) so same-page client navigations fire it too.
  const searchParams = useSearchParams()
  useEffect(() => {
    if (!enabled) return
    const topic = searchParams.get('athena-topic')
    if (topic && topic.trim()) {
      setTopicPrompt({
        text: `Help me understand "${topic.trim()}" — can you explain it simply, then quiz me on it?`,
        nonce: ++topicNonceRef.current,
      })
      setPose((p) => (p === 'closed' ? 'docked' : p))
      setEverOpened(true)
      const url = new URL(window.location.href)
      url.searchParams.delete('athena-topic')
      window.history.replaceState(null, '', url.toString())
    }
  }, [enabled, searchParams])

  /** A send from the entry pill: the dock unfurls out of the box just typed in,
   *  with the line already in the thread. An empty send just opens her. */
  const askFromPill = useCallback(
    (text: string) => {
      setUnfurl(true)
      dock()
      if (text) setTopicPrompt({ text, nonce: ++topicNonceRef.current })
    },
    [dock],
  )

  // Opening on ⌘K / ⌘J belongs to the entry pill (it holds the typed value).
  // Once she's open the same chord just puts the cursor in her composer, and
  // Escape closes the topmost layer (below).
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && (key === 'j' || key === 'k') && open) {
        e.preventDefault()
        focusComposer()
      }
      if (e.key === 'Escape') {
        // One keypress closes ONE layer. Radix layers (the drive-mode menu, and
        // every dialog/sheet in the still-interactive app core) handle Escape in
        // the capture phase and preventDefault without stopping propagation — so
        // defaultPrevented is the reliable "someone above me took it" signal,
        // where a selector for one specific layer missed all the others.
        if (e.defaultPrevented) return
        // Topmost first: the citation panel, then a mulled suggestion, then the
        // pose. `escapeRung` returns false when there was nothing to dismiss, so
        // the press falls through to the next rung instead of being swallowed.
        if (preview) setPreview(null)
        else if (escapeRung.current?.()) return
        else if (pose === 'fullscreen') setPose('docked')
        else release()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled, open, pose, preview, release, focusComposer])

  // ── Athena driving the app ────────────────────────────────────────────────
  // The ring's radiant state (and the comet) mean "Athena is moving something",
  // not "Athena is typing" — so they light here and nowhere else.
  //
  // "Taking you there…" lasts as long as the trip does, which is TWO facts and
  // neither alone is it:
  //   · `arriving` — the transition around `router.push`. `push` returns long
  //     before the destination is on screen and only four student routes have a
  //     loading.tsx, so on the rest the URL doesn't commit until the whole RSC
  //     round trip lands. A fixed window meant the card ticked "Took you there"
  //     while the student was still looking at the old page.
  //   · `driveWindow` — a floor. The push, the destination's own render and the
  //     node modal opening are one motion to the student, and a same-page `?node=`
  //     drive commits almost instantly, so without it the ring would flash.
  // Lit while EITHER is still true: the floor can't cut the trip short, and a
  // fast trip still gets a motion long enough to read as one.
  //
  // And a CEILING, for the same reason the run card has `settled`: a route that
  // never commits (a dead connection, an error boundary that suspends) would
  // otherwise leave the card saying "Taking you there…" and the comet running at
  // its 450ms driving cadence for the rest of the session. Arriving late at a page
  // whose card already reads "Took you there" is the better failure.
  const router = useRouter()
  const [driveWindow, setDriveWindow] = useState(false)
  const [arriving, startArriving] = useTransition()
  const [driveTimedOut, setDriveTimedOut] = useState(false)
  const driving = (driveWindow || arriving) && !driveTimedOut
  const driveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const driveCeiling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /** Where the student was before the last drive — the one thing Co-pilot costs
   *  them, and no undo restores attention. */
  const placemark = useRef<{ url: string; scroll: number } | null>(null)
  /* The most recent accepted drive, for the chat's navigation card and its way
     back. The SHELL owns it because the shell is what actually moved the app —
     the chat only asked. Nonce'd so a second drive replaces the first offer
     (an older placemark is gone, so offering it back would lie). */
  const [drive, setDrive] = useState<{
    nonce: number
    messageId: string
    label: string
    said: string
    back: AthenaBackState
  } | null>(null)
  /* A drive she prepared but didn't take. The SHELL owns this for the same
     reason it owns `drive`: it is the thing that decides, so it is the thing
     that knows. Keeping the decision here also keeps it out of the chat's
     effect, where recording it would have meant a setState mid-effect. */
  const [declined, setDeclined] = useState<{ messageId: string; drive: AthenaDrive } | null>(null)
  const driveNonce = useRef(0)

  /** The client's ONE drive reducer (§13.3). Every directive kind — a roadmap
   *  node, a pre-filled proposal surface — arrives here as a finished in-app
   *  route the server built from its typed registry. The shell never assembles
   *  a URL and never sees an id. */
  const driveTo = useCallback(
    (request: AthenaDrive, force = false) => {
      const { route, label, said, messageId, prefill } = request
      // An answer can land long after it was asked — the student may have closed
      // the dock, switched tabs, started a quiz, or walked into an editor since.
      // A drive they can't see isn't a drive, it's the app moving on its own, so
      // it is DROPPED rather than queued (a delayed teleport is worse). The answer
      // still names the material; nothing is lost but the shortcut.
      //
      // The compose-route veto is about being taken AWAY from work in progress,
      // so it doesn't apply when the target is the page they're already on:
      // "what should I ask in class?" is asked FROM the live classroom far more
      // often than towards it, and there is nothing to navigate away from. The
      // pre-fill still lands (the surface listens), and it refuses to overwrite
      // anything the student has already typed.
      // `force` is the student clicking the offer below — an explicit choice
      // outranks a veto that exists to protect them from a surprise. Chat-only
      // mode is checked here too, because "may she move my screen" is the
      // shell's axis and this is the only place that acts on it.
      const samePage = route.split('?')[0] === pathname
      const canDrive =
        (force || driveMode === 'copilot') &&
        open &&
        !quizLocked &&
        document.visibilityState === 'visible' &&
        (force || samePage || !COMPOSE_ROUTE.test(pathname ?? ''))
      if (!canDrive) {
        // Declining is right; declining silently was not — the plan card has
        // already ticked "ready on the booking page" and the answer is written
        // as if they were about to see it. So it becomes an offer.
        setDeclined({ messageId, drive: request })
        return
      }
      setDeclined(null)

      // Written before the push so the target surface finds it on mount; a
      // surface already mounted (the same-page case) hears the event instead.
      if (prefill) writeAthenaPrefill(prefill.kind, prefill.text, route)

      /* Through `safeAppPath` like every other value that becomes a `router.push`
         — not because this one is reachable (the shell only mounts under
         /student/*, so a protocol-relative pathname can never produce a
         placemark) but so nobody has to re-derive that argument to read this
         line. A rejected placemark means no way back is offered, which is the
         same outcome as never having moved. */
      const here = safeAppPath(`${window.location.pathname}${window.location.search}`)
      placemark.current = here ? { url: here, scroll: pageScroller()?.scrollTop ?? 0 } : null
      setDriveWindow(true)
      setDriveTimedOut(false)
      setDrive({ nonce: ++driveNonce.current, messageId, label, said, back: 'offered' })
      // Fullscreen has no app to drive — drop back to the dock so she's pointing
      // at something the student can actually see.
      setPose('docked')
      /* Both calls inside the transition, so `arriving` covers the whole trip.
         A drive can land on a page whose server data the same turn just changed —
         `leave_study_artifact` pins a note to the roadmap, then drives to it. When
         that page is the one the student is already on (the dock is ambient), the
         `?node=` push is a same-path query change the router serves from cache
         without refetching, so the new note wouldn't be there. A refresh re-renders
         the destination with fresh server data; it can't be done server-side because
         `revalidatePath` is dropped inside the streaming tool call that created it. */
      startArriving(() => {
        router.push(route)
        router.refresh()
      })
      clearTimeout(driveTimer.current)
      driveTimer.current = setTimeout(() => setDriveWindow(false), DRIVE_FLOOR_MS)
      clearTimeout(driveCeiling.current)
      driveCeiling.current = setTimeout(() => setDriveTimedOut(true), DRIVE_CEILING_MS)
    },
    [router, open, quizLocked, pathname, pageScroller, driveMode],
  )
  useEffect(() => () => {
    clearTimeout(driveTimer.current)
    clearTimeout(driveCeiling.current)
  }, [])

  /* `router.push` returns long before the destination is on screen, and only four
     student routes have a loading.tsx — on the rest (roadmap, grades, the course
     overview) the URL doesn't commit until the whole RSC round trip lands, which
     on a slow connection is seconds. So the return is wrapped in a transition and
     the retry below waits on `returning` instead of on a guessed number: the undo
     takes exactly as long as the navigation does, no more. */
  const [returning, startReturning] = useTransition()
  const returningRef = useRef(false)
  useEffect(() => {
    returningRef.current = returning
  }, [returning])
  /** Cancels an in-flight scroll restore. */
  const abortRestore = useRef<(() => void) | null>(null)
  useEffect(() => () => abortRestore.current?.(), [])

  /** Put the scroller back where the placemark left it, once the page it belongs
   *  to is actually on screen — then report which half of the promise was kept.
   *
   *  This is a retry, not a frame of grace: the layout's `<main>` is the SAME
   *  element across a page swap, so a one-shot restore either scrolls the page
   *  we're leaving or scrolls a stub too short to hold the offset, and calls it
   *  done. Two signals have to line up instead: the URL has committed, and the
   *  scroller can take the number. */
  const restoreScroll = useCallback(
    (mark: { url: string; scroll: number }) => {
      abortRestore.current?.()
      const ceiling = performance.now() + SCROLL_RESTORE_CEILING_MS
      /** Set once the navigation has settled: from there the page is as tall as
       *  it is going to get, so a target still out of reach stays out of reach. */
      let settleBy: number | null = null
      let raf = 0

      // Function declarations, not consts: `finish` detaches the listeners and
      // the listeners call `finish`.
      function finish(restored: boolean) {
        cancelAnimationFrame(raf)
        detach()
        abortRestore.current = null
        setDrive((d) => (d ? { ...d, back: restored ? 'restored' : 'route-only' } : d))
      }
      /* The student scrolling mid-return has taken the wheel; landing them
         somewhere else now is a fight for control, not a courtesy. Deliberately
         NOT the `scroll` event — our own write fires one and would self-cancel. */
      function takeOver() {
        finish(false)
      }
      function onKey(e: KeyboardEvent) {
        if (SCROLL_KEYS.test(e.key)) finish(false)
      }
      function detach() {
        window.removeEventListener('wheel', takeOver, true)
        window.removeEventListener('touchmove', takeOver, true)
        window.removeEventListener('keydown', onKey, true)
      }

      function tick() {
        const now = performance.now()
        const el = pageScroller()
        const landed = `${window.location.pathname}${window.location.search}` === mark.url
        if (landed && el) {
          if (settleBy === null && !returningRef.current) settleBy = now + SCROLL_RESTORE_SETTLE_MS
          const reachable = el.scrollHeight - el.clientHeight
          if (reachable >= mark.scroll) {
            // A placemark at the top has nothing to write: the student was at 0,
            // the route is the whole undo, and writing 0 anyway would yank back
            // anyone who started reading while the page was still coming.
            if (mark.scroll > 0) el.scrollTop = mark.scroll
            return finish(true)
          }
          if (settleBy !== null && now >= settleBy) {
            // Out of content and out of time. Land them as close as the page
            // allows if that is nearly all the way; otherwise leave them at the
            // top, which at least looks like a page they arrived at rather than
            // the bottom of one they don't recognise.
            const closeEnough = reachable >= mark.scroll * SCROLL_RESTORE_TOLERANCE
            if (closeEnough) el.scrollTop = reachable
            return finish(closeEnough)
          }
        }
        if (now >= ceiling) return finish(false)
        raf = requestAnimationFrame(tick)
      }

      window.addEventListener('wheel', takeOver, { capture: true, passive: true })
      window.addEventListener('touchmove', takeOver, { capture: true, passive: true })
      window.addEventListener('keydown', onKey, true)
      abortRestore.current = () => finish(false)
      raf = requestAnimationFrame(tick)
    },
    [pageScroller],
  )

  /** ↩ Back to where I was — route and scroll, restored together. */
  const goBack = useCallback(() => {
    const mark = placemark.current
    if (!mark || returning) return
    setDrive((d) => (d ? { ...d, back: 'returning' } : d))
    startReturning(() => router.push(mark.url))
    restoreScroll(mark)
  }, [router, restoreScroll, returning])

  const prevOpenRef = useRef(false)
  useEffect(() => {
    // Reopening never remounts the chat (it stays mounted under display:none),
    // so the composer's own mount-focus doesn't fire again — do it here.
    if (!prevOpenRef.current && open) focusComposer()
    if (prevOpenRef.current && !open) document.querySelector<HTMLInputElement>('.athena-pill-input')?.focus()
    prevOpenRef.current = open
  }, [open, focusComposer])

  // Apple-Intelligence stop shuffle: re-randomize the ring gradient's stop
  // positions on a timer; the registered custom properties ease between states
  // (450ms while driving, 1.3s idle). Skipped entirely under reduced motion.
  const ringRef = useRef<HTMLDivElement | null>(null)
  const drivingRef = useRef(false)
  useEffect(() => {
    drivingRef.current = driving
  }, [driving])
  useEffect(() => {
    if (!open) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const el = ringRef.current
      if (el) {
        const pts = Array.from({ length: 7 }, () => Math.random() * 100).sort((a, b) => a - b)
        pts.forEach((p, i) => el.style.setProperty(`--athena-p${i + 1}`, `${p.toFixed(1)}%`))
      }
      timer = setTimeout(tick, drivingRef.current ? 450 : 1300)
    }
    tick()
    return () => clearTimeout(timer)
  }, [open])

  /* No course announced, or the professor switched Athena off: hand the page
     straight through. The frame below only exists to hold the ring and the
     absolutely-positioned dock, and it is actively harmful when there is
     neither — it is a fixed-height `overflow:hidden` box, so a page that
     doesn't bring its own scroller gets clipped, and its negative margins
     delete the dashboard's padding.

     One exception: a COURSE page's layout is a fragment (course rail +
     `<main class="flex-1 overflow-y-auto">`) that relies on its parent being a
     flex ROW — normally `.athena-core`. Handing it straight through parents it
     on the dashboard's block `<main>`, which stacks the rail on top of the
     content and shoves the page a rail's-height down (every page of an
     Athena-off course rendered "blank"). So an off-course page passes through
     bare, and a course page gets just the row geometry — none of the frame. */
  if (!enabled) {
    return inCourse
      ? <div className={`-m-4 flex min-h-0 overflow-hidden lg:-m-8 ${FRAME_H}`}>{children}</div>
      : <>{children}</>
  }

  const isFullscreen = pose === 'fullscreen'
  const chat = (
    <AthenaChat
      sectionId={sectionId}
      courseCode={courseCode}
      greetingName={greetingName}
      active={everOpened}
      pose={isFullscreen ? 'fullscreen' : 'docked'}
      topicPrompt={topicPrompt}
      onTopicConsumed={() => setTopicPrompt(undefined)}
      onOpenPreview={setPreview}
      onDriveTo={driveTo}
      drive={drive}
      declined={declined}
      onGoBack={goBack}
      onTogglePose={() => setPose(isFullscreen ? 'docked' : 'fullscreen')}
      onRelease={release}
      driving={driving}
      registerEscapeRung={registerEscapeRung}
      driveMode={driveMode}
      onDriveModeChange={setDriveMode}
    />
  )

  return (
    <div
      ref={hostRef}
      /* The negative margins cancel the dashboard `<main>`'s padding for the
         edge-to-edge course frame. Off-course there is no frame to bleed, so the
         dashboard's own padding is the correct padding. */
      /* The negative margins cancel the dashboard `<main>`'s padding so the host
         spans that box exactly. They are NOT optional off-course: dropping them
         left the host a full padding taller than the space it sits in, which
         made the dashboard's own scroller overflow — and then any scroll of it
         carried Athena off the top of the screen. Off-course padding is restored
         inside, on the scroller below, where it can't affect this geometry. */
      className={`athena-host -m-4 lg:-m-8 ${FRAME_H}`}
      data-pose={pose}
      data-working={open && driving ? 'true' : undefined}
      data-preview={open && preview ? 'true' : undefined}
    >
      {/* The swallowable app core — the real page keeps living inside. In
          fullscreen only its course rail stays visible (see globals.css).

          `.athena-core` is an absolutely-positioned flex box, which means it
          scrolls nothing itself — it relies on its child doing that. Course
          pages have one (the section layout's `<main>`); every other student
          page does not, so the shell supplies it rather than assuming a
          property of its children. Rendered as `<main>` so the scroll placemark
          finds it by the same `.athena-core > main` selector on both. */}
      <div className="athena-core">
        {inCourse ? children : <main className="min-w-0 flex-1 overflow-y-auto p-4 lg:p-8">{children}</main>}
      </div>

      {/* The gradient ring around the swallowed core. */}
      <div ref={ringRef} className="athena-ring" aria-hidden>
        <i className="athena-ring-halo" />
        <i className="athena-ring-inner" />
        <i className="athena-ring-glow" />
        <i className="athena-ring-comet" />
      </div>

      {/* The conversation — ONE element for both poses, deliberately: rendering
          two branches would remount AthenaChat on every ⤢, killing an in-flight
          stream and dropping the thread. Only the classes change. Kept mounted
          while closed for the same reason. */}
      <div
        ref={dockRef}
        role="complementary"
        aria-label="Athena"
        style={{ display: open ? undefined : 'none' }}
        // `right` lives in globals.css with the core + ring so all three snap
        // together when the preview opens: a 200ms glide here left the frame's
        // edge expanding over the chat text while the chat was still travelling.
        className={
          isFullscreen
            ? 'athena-fs absolute inset-y-0 left-14 right-0 z-20 flex bg-background'
            : `athena-dock absolute inset-y-4 right-0 z-20 flex w-[var(--athena-dock-w)] flex-col px-4 ${
                unfurl ? 'athena-dock-grow' : ''
              }`
        }
        onAnimationEnd={() => setUnfurl(false)}
      >
        <div
          className={
            isFullscreen
              ? 'athena-fs-frame m-3.5 flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-border/60'
              : 'flex min-h-0 flex-1 flex-col'
          }
        >
          {chat}
        </div>
      </div>

      {/* The one entry point — absent entirely while a quiz is being taken. */}
      {!open && !quizLocked && <AthenaEntryPill courseCode={courseCode} onSubmit={askFromPill} />}

      {/* Citation preview — slides in from the right and pushes the app + chat
          left (the retired AI-tutor pane's behavior), never an overlay. Below md
          there's no room to push, so it covers the chat instead. */}
      <aside
        aria-label="Cited page preview"
        aria-hidden={!preview}
        inert={!preview}
        className={`athena-preview absolute inset-y-4 right-0 z-30 flex flex-col px-4 transition-transform duration-200 motion-reduce:transition-none ${
          preview ? 'translate-x-0' : 'pointer-events-none translate-x-full'
        }`}
      >
        {shownPreview && (
          <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-border shadow-xl">
            <DocumentPagePreview
              /* Keyed on the target, so switching citations gets a FRESH panel:
                 unkeyed it reused the node, and the next passage opened at the
                 last one's scroll offset with the previous page's "loaded" state
                 still on — which now matters, because a passage can make this
                 panel several screens tall. */
              key={`${shownPreview.itemId}#${shownPreview.page}#${shownPreview.spoken ? 's' : 'p'}`}
              itemId={shownPreview.itemId}
              page={shownPreview.page}
              title={shownPreview.title}
              /* A "said in class" citation cited the WORDS, so the panel leads
                 with them and keeps the slide they were said over below. */
              subtitle={shownPreview.spoken ? `Said in class · slide ${shownPreview.page}` : undefined}
              lead={
                shownPreview.spoken ? (
                  <SpokenPassage
                    key={`${shownPreview.itemId}#${shownPreview.page}`}
                    sectionId={sectionId}
                    itemId={shownPreview.itemId}
                    citedTitle={shownPreview.citedTitle}
                    slide={shownPreview.page}
                  />
                ) : undefined
              }
              onClose={() => {
                setPreview(null)
                focusComposer()
              }}
            />
          </div>
        )}
      </aside>
    </div>
  )
}
