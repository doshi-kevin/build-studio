// Layer regression guard for the Athena shell after the command-palette pose was
// retired. Two invariants the port introduced, both easy to break by "simplifying":
//
//   1. One Escape closes ONE layer. The old code asked the DOM whether any Radix
//      overlay was open (the citation Sheet, the history dropdown) and skipped the
//      shell teardown if so. The Sheet is gone — the citation preview is now shell
//      STATE, not an overlay — so the ladder is explicit: a layer that already
//      handled Escape (defaultPrevented) → preview → shell. Drop the `if (preview)`
//      rung and one Escape from a cited page tears the whole shell down.
//   2. The preview panel keeps its page while it slides out (the retained
//      `shownPreview`). Collapsing it back to `preview && <…>` empties the panel
//      on the first frame of a 200ms transition, so it animates out blank.
//
// AthenaChat is stubbed: the shell's own behavior is the subject, and the real
// chat drags in useChat + the context server action, neither of which this asserts.

import { useEffect, useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AthenaShell } from '@/components/student/athena/AthenaShell'
import type { PreviewTarget } from '@/components/student/athena/ChatMessage'
import { studentRoute } from '@/lib/routes/student'
import { announceAthenaCourse } from '@/lib/hooks/use-athena-course'

// Per-test knobs for the route, the server quiz-lock signal, and the query string.
/** Escape presses the conversation's rung claimed (see the AthenaChat stub). */
const rungCalls = vi.hoisted(() => [] as string[])

const nav = vi.hoisted(() => ({
  pathname: '/student/courses/sec-1/modules',
  search: '',
  activeAttempt: false,
  push: vi.fn(),
  /** The shell refreshes as it drives, so a note the same turn just created is
   *  there when the page arrives. A mock without it made every driving test throw
   *  `router.refresh is not a function` from inside the click handler. */
  refresh: vi.fn(),
  /** Query string → the ONE params object handed out for it (see below). */
  params: new Map<string, URLSearchParams>(),
}))

vi.mock('next/navigation', () => ({
  // Stable per query string, which is what the real hook gives you. Handing back
  // a fresh URLSearchParams on every render is an infinite render loop here, not
  // just churn: the deep-link reader below lists `searchParams` in its deps and
  // SETS STATE when it finds a topic, so a new identity each render re-fires it
  // forever. That loop OOMs the worker rather than failing, which reads as the
  // whole suite hanging.
  useSearchParams: () => {
    const cached = nav.params.get(nav.search)
    if (cached) return cached
    const fresh = new URLSearchParams(nav.search)
    nav.params.set(nav.search, fresh)
    return fresh
  },
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
}))

// Stand-in for the conversation: surfaces the two callbacks the shell owns
// (a citation chip opening a preview, and ✕ releasing the app).
vi.mock('@/components/student/athena/AthenaChat', () => ({
  AthenaChat: ({
    onOpenPreview,
    onRelease,
    onDriveTo,
    onGoBack,
    drive,
    registerEscapeRung,
    topicPrompt,
  }: {
    onOpenPreview: (t: PreviewTarget) => void
    onRelease: () => void
    onDriveTo: (
      drive: {
        route: string
        label: string
        said: string
        messageId: string
        prefill?: { kind: 'lc_question' | 'booking_note'; text: string }
      },
      force?: boolean,
    ) => boolean
    onGoBack: () => void
    drive: { said: string; back: string } | null
    registerEscapeRung: (rung: (() => boolean) | null) => void
    topicPrompt?: { text: string; nonce: number }
  }) => {
    // Stands in for a suggestion Athena is mulling over: an Escape rung that
    // claims ONE press while it's armed, then declines.
    const [armed, setArmed] = useState(false)
    useEffect(() => {
      registerEscapeRung(() => {
        if (!armed) return false
        setArmed(false)
        rungCalls.push('claimed')
        return true
      })
      return () => registerEscapeRung(null)
    }, [registerEscapeRung, armed])

    return (
      <div>
        <button type="button" onClick={() => onOpenPreview({ itemId: 'item-1', page: 14, title: 'Transformers' })}>
          cite
        </button>
        <button type="button" onClick={onRelease}>
          release
        </button>
        <button
          type="button"
          onClick={() =>
            onDriveTo({
              route: studentRoute.roadmapNode('sec-1', 'module_item:item-9'),
              label: 'Roadmap · a node',
              said: 'Opened the roadmap.',
              messageId: 'm-1',
            })
          }
        >
          drive
        </button>
        <button
          type="button"
          onClick={() =>
            onDriveTo({
              route: studentRoute.challenge('sec-1', 'ch-7'),
              label: 'Challenges · Graph Sprint',
              said: 'Opened the board on that challenge.',
              messageId: 'm-2',
            })
          }
        >
          propose
        </button>
        <button
          type="button"
          onClick={() =>
            onDriveTo({
              route: studentRoute.liveRoom('sec-1', 'room-3'),
              label: 'Live class',
              said: 'Put the question in the class question box.',
              messageId: 'm-3',
              prefill: { kind: 'lc_question', text: 'Could you go over attention again?' },
            })
          }
        >
          ask in class
        </button>
        <button type="button" onClick={onGoBack}>
          back
        </button>
        {/* The drive receipt as the SHELL hands it over: the sentence, plus how
            far the undo got. Asserting the state rather than BackLine's wording
            keeps the copy in one place. */}
        {drive ? (
          <div>
            <div>{drive.said}</div>
            <div>{`back:${drive.back}`}</div>
          </div>
        ) : null}
        <button type="button" onClick={() => setArmed(true)}>
          arm rung
        </button>
        <div>{`armed:${armed}`}</div>
        {topicPrompt ? <div>{`topic:${topicPrompt.text}`}</div> : null}
      </div>
    )
  },
}))

vi.mock('@/app/(dashboard)/student/courses/[sectionId]/ai-tutor/actions', () => ({
  hasActiveQuizAttempt: async () => nav.activeAttempt,
}))

vi.mock('@/components/shared/DocumentPagePreview', () => ({
  DocumentPagePreview: ({ title, page }: { title: string; page: number }) => (
    <div>{`preview:${title}:${page}`}</div>
  ),
}))

const host = () => document.querySelector('.athena-host') as HTMLElement
const previewPanel = () => screen.getByLabelText('Cited page preview')

// The entry pill replaced the old "Athena" button: it is a mini composer, so the
// input IS the affordance and ⌘K / ⌘J (or Enter in it) is the open gesture.
const pill = () => screen.queryByLabelText('Ask Athena')
const openAthena = () => fireEvent.keyDown(document, { key: 'j', metaKey: true })

// The ring's stop-shuffle effect reads matchMedia the moment the shell opens.
beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia
  // The pre-fill handoff lives in sessionStorage; a leftover draft would make
  // the "refuses to drive" tests pass for the wrong reason.
  sessionStorage.clear()
  // The shell now takes its course from the beacon the course layout fires
  // rather than from props (§14.7 D1), so every test has to be "inside a
  // course" the way a real student is.
  announceAthenaCourse({ sectionId: 'sec-1', courseCode: 'CS584', enabled: true })
  nav.pathname = '/student/courses/sec-1/modules'
  nav.search = ''
  nav.activeAttempt = false
  nav.push.mockClear()
  rungCalls.length = 0
  window.history.replaceState(null, '', '/student/courses/sec-1/modules')
})

function renderShell() {
  const view = render(
    <AthenaShell greetingName="Ada">
      <div>course page</div>
    </AthenaShell>,
  )
  openAthena()
  return view
}

describe('AthenaShell — layer teardown', () => {
  it('opens on ⌘J and closes on Escape', () => {
    render(
      <AthenaShell greetingName="Ada">
        <div>course page</div>
      </AthenaShell>,
    )
    expect(host()).toHaveAttribute('data-pose', 'closed')

    fireEvent.keyDown(document, { key: 'j', metaKey: true })
    expect(host()).toHaveAttribute('data-pose', 'docked')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(host()).toHaveAttribute('data-pose', 'closed')
  })

  it('Escape with a citation preview open closes the preview only, leaving the dock up', () => {
    renderShell()
    fireEvent.click(screen.getByText('cite'))
    expect(host()).toHaveAttribute('data-preview', 'true')

    fireEvent.keyDown(document, { key: 'Escape' })
    // First rung: the preview went, the shell stayed.
    expect(host()).not.toHaveAttribute('data-preview')
    expect(host()).toHaveAttribute('data-pose', 'docked')

    // Second rung: now Escape releases the app.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(host()).toHaveAttribute('data-pose', 'closed')
  })

  it('Escape is ignored when a layer above already took it', () => {
    renderShell()
    fireEvent.click(screen.getByText('cite'))
    // How every Radix layer (history dropdown, and any dialog in the still-
    // interactive app core) behaves: handle Escape in the capture phase and
    // preventDefault, without stopping propagation.
    const radixLike = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault()
    }
    document.addEventListener('keydown', radixLike, { capture: true })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(host()).toHaveAttribute('data-preview', 'true')
    expect(host()).toHaveAttribute('data-pose', 'docked')

    document.removeEventListener('keydown', radixLike, { capture: true })
  })

  // The conversation used to run its OWN document keydown listener for this,
  // racing the shell's: whichever React had re-registered most recently ran
  // first, so one press either tore down two layers or the wrong one. The rung
  // is a function the shell calls, so the order below is the only order.
  it('ranks the conversation\'s Escape rung under the preview and over the pose', () => {
    renderShell()
    fireEvent.click(screen.getByText('arm rung'))
    fireEvent.click(screen.getByText('cite'))

    // Preview is above the rung: it goes first, and the rung is left armed.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(host()).not.toHaveAttribute('data-preview')
    expect(rungCalls).toEqual([])
    expect(screen.getByText('armed:true')).toBeInTheDocument()

    // Now the rung claims the press — the pose must NOT also change.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(rungCalls).toEqual(['claimed'])
    expect(host()).toHaveAttribute('data-pose', 'docked')

    // Disarmed, it declines and the press falls through to releasing the app.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(host()).toHaveAttribute('data-pose', 'closed')
  })

  it('releasing the app drops the citation preview with it', () => {
    renderShell()
    fireEvent.click(screen.getByText('cite'))
    fireEvent.click(screen.getByText('release'))

    expect(host()).toHaveAttribute('data-pose', 'closed')
    // A stale preview would push the app aside the next time Athena opens.
    expect(host()).not.toHaveAttribute('data-preview')
  })
})

describe('AthenaShell — citation preview panel', () => {
  it('keeps the cited page mounted while the panel slides back out', () => {
    renderShell()
    fireEvent.click(screen.getByText('cite'))
    expect(screen.getByText('preview:Transformers:14')).toBeInTheDocument()
    expect(previewPanel()).not.toHaveAttribute('aria-hidden', 'true')

    fireEvent.keyDown(document, { key: 'Escape' })
    // Panel is hidden from AT and pointer input, but still has a page to animate out.
    expect(previewPanel()).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('preview:Transformers:14')).toBeInTheDocument()
  })
})

// Athena leaves the screen entirely while a graded attempt is open — no button
// to press, and any dock already open closes itself. The enforcement lives in
// /api/chat (athena-chat-quiz-lock.test.ts); this is the shell half.
describe('AthenaShell — quiz lock', () => {
  function plainRender() {
    return render(
      <AthenaShell greetingName="Ada">
        <div>course page</div>
      </AthenaShell>,
    )
  }

  it('hides the pill on a quiz-attempt route, and ⌘J does nothing', async () => {
    nav.pathname = '/student/courses/sec-1/quizzes/quiz-1/attempt/att-1'
    plainRender()

    // The pill is unmounted, so the shortcut it owns is gone with it.
    expect(pill()).not.toBeInTheDocument()
    openAthena()
    expect(host()).toHaveAttribute('data-pose', 'closed')
  })

  it('hides the pill when the attempt is open in another tab', async () => {
    nav.activeAttempt = true
    plainRender()

    await waitFor(() => expect(pill()).not.toBeInTheDocument())
  })

  it('closes a dock that was already open when the lock arrives', async () => {
    plainRender()
    openAthena()
    fireEvent.click(screen.getByText('cite'))
    expect(host()).toHaveAttribute('data-pose', 'docked')

    // The student starts a quiz in another tab; this one re-checks on focus.
    nav.activeAttempt = true
    fireEvent(document, new Event('visibilitychange'))

    await waitFor(() => expect(host()).toHaveAttribute('data-pose', 'closed'))
    expect(host()).not.toHaveAttribute('data-preview')
    expect(pill()).not.toBeInTheDocument()
  })
})

// Athena driving the app: the ring's radiant state means "she is moving
// something", not "she is typing" — the whole point of re-pointing data-working
// at the drive. If it ever tracks streaming again, the ring lights on every
// answer and stops meaning anything.
// The shell moved to /student/layout.tsx so it survives a drive out of the
// course segment (§14.7 D1). That means it now mounts on pages that have no
// course at all, and has to stay out of the way there.
describe('AthenaShell — outside a course', () => {
  it('renders the app and nothing else until a course has announced itself', () => {
    sessionStorage.clear()
    nav.pathname = '/student/office-hours'
    render(
      <AthenaShell greetingName="Ada">
        <div>office hours page</div>
      </AthenaShell>,
    )

    expect(screen.getByText('office hours page')).toBeInTheDocument()
    expect(screen.queryByText('cite')).not.toBeInTheDocument()
  })

  it('stays with the student after she drives them off the course routes', () => {
    // C10 is the whole reason for the move: she takes them to /student/
    // office-hours, which is a sibling of the course segment, and she has to
    // still be there when they land.
    nav.pathname = '/student/office-hours'
    render(
      <AthenaShell greetingName="Ada">
        <div>office hours page</div>
      </AthenaShell>,
    )
    openAthena()

    expect(screen.getByText('cite')).toBeInTheDocument()
  })
})

describe('AthenaShell — driving the app', () => {
  it('drops the drive when the student can no longer see it', async () => {
    // An answer can land after the dock is closed, after a quiz starts, or in a
    // background tab. Driving then isn't help, it's the app moving on its own —
    // and the quiz case would eject a student out of a live attempt.
    nav.pathname = '/student/courses/sec-1/assignments/a1'
    render(
      <AthenaShell greetingName="Ada">
        <div>course page</div>
      </AthenaShell>,
    )
    openAthena()
    fireEvent.click(screen.getByText('drive'))

    expect(nav.push).not.toHaveBeenCalled()
    expect(host()).not.toHaveAttribute('data-working')
  })

  it('navigates to the node and lights the ring only while it moves', async () => {
    render(
      <AthenaShell greetingName="Ada">
        <div>course page</div>
      </AthenaShell>,
    )
    openAthena()
    expect(host()).not.toHaveAttribute('data-working')

    fireEvent.click(screen.getByText('drive'))

    expect(nav.push).toHaveBeenCalledWith('/student/courses/sec-1/roadmap?node=module_item%3Aitem-9')
    /* And a refresh with it. A same-path `?node=` push is served from the router
       cache, so a note the same turn just created would not be on the page it
       lands on. The mock only exists because the handler calls this. */
    expect(nav.refresh).toHaveBeenCalled()
    expect(host()).toHaveAttribute('data-working', 'true')

    // …and it settles back once the move is done.
    await waitFor(() => expect(host()).not.toHaveAttribute('data-working'), { timeout: 4000 })
  })

  it('still pre-fills the page the student is already on', () => {
    // The compose-route veto exists to stop her pulling a student AWAY from
    // work in progress. Asking "what should I ask in class?" from inside the
    // live class is the normal case, and there is nothing to navigate away
    // from — so the drive lands and the draft reaches the question box.
    nav.pathname = '/student/courses/sec-1/live-classroom/room-3'
    render(
      <AthenaShell greetingName="Ada">
        <div>course page</div>
      </AthenaShell>,
    )
    openAthena()
    fireEvent.click(screen.getByText('ask in class'))

    expect(nav.push).toHaveBeenCalledWith('/student/courses/sec-1/live-classroom/room-3')
    expect(sessionStorage.getItem('athena-prefill')).toContain('Could you go over attention again?')
  })

  it('still refuses to pull the student out of a DIFFERENT compose route', () => {
    nav.pathname = '/student/courses/sec-1/assignments/a1'
    render(
      <AthenaShell greetingName="Ada">
        <div>course page</div>
      </AthenaShell>,
    )
    openAthena()
    fireEvent.click(screen.getByText('ask in class'))

    expect(nav.push).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('athena-prefill')).toBeNull()
  })

  it('pushes a proposal to its pre-filled surface through the same one reducer', () => {
    // §13.3: the shell holds ONE drive path. A propose tool sends a different
    // route, not a second callback with its own parse and its own placemark.
    render(
      <AthenaShell greetingName="Ada">
        <div>course page</div>
      </AthenaShell>,
    )
    openAthena()
    fireEvent.click(screen.getByText('propose'))

    expect(nav.push).toHaveBeenCalledWith('/student/courses/sec-1/challenges?challenge=ch-7')
    expect(host()).toHaveAttribute('data-working', 'true')
  })
})

// "Back to where I was" is the whole price of Co-pilot mode: she is allowed to
// move the screen BECAUSE the move is undoable. Two halves, and the second is
// where it used to be broken — the route came back and the scroll didn't, which
// on a long modules page is most of the way to not going back at all.
describe('AthenaShell — back to where I was', () => {
  /** jsdom does no layout, so a scroller has to be told its size. Without this,
   *  scrollHeight and clientHeight are both 0 and nothing is ever restorable. */
  function sizeScroller(el: HTMLElement, scrollHeight: number, clientHeight: number) {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  }

  const frames = (n: number) =>
    Array.from({ length: n }).reduce<Promise<unknown>>(
      (p) => p.then(() => new Promise(requestAnimationFrame)),
      Promise.resolve(),
    )

  /** The mocked router only records the push, so the test plays the part Next
   *  plays for real: committing the URL when the destination lands. */
  const commit = (url: string) => window.history.replaceState(null, '', url)
  const ROADMAP = '/student/courses/sec-1/roadmap?node=module_item%3Aitem-9'
  const MODULES = '/student/courses/sec-1/modules'

  function renderWithScroller() {
    // A course page supplies its OWN `<main>` (the section layout's), which is
    // what `.athena-core > main` finds in production.
    render(
      <AthenaShell greetingName="Ada">
        <main data-testid="scroller">course page</main>
      </AthenaShell>,
    )
    const scroller = screen.getByTestId('scroller')
    sizeScroller(scroller, 4000, 700)
    openAthena()
    return scroller
  }

  it('returns to the page the drive left, and reports it only once it lands', async () => {
    renderWithScroller()
    fireEvent.click(screen.getByText('drive'))
    expect(screen.getByText('Opened the roadmap.')).toBeInTheDocument()
    expect(screen.getByText('back:offered')).toBeInTheDocument()

    fireEvent.click(screen.getByText('back'))
    expect(nav.push).toHaveBeenLastCalledWith(MODULES)

    // The claim waits for the navigation. Flipping it on click — which is what it
    // used to do — printed "Took you back to where you were." and unmounted the
    // button while the return was still in flight, so a slow route looked like a
    // dead click that had already succeeded.
    expect(screen.getByText('back:returning')).toBeInTheDocument()

    commit(MODULES)
    await waitFor(() => expect(screen.getByText('back:restored')).toBeInTheDocument())
  })

  it('goes back to the exact view it left, query string and all', async () => {
    // "Where I was" on a course page is a path AND a query: the roadmap keeps the
    // open node in `?node=`, so a placemark that remembers only the path returns
    // them to a closed drawer and calls it home. It breaks the scroll half too —
    // the retry only fires while the committed URL EQUALS the placemark, so a
    // placemark missing the query never matches the page it named.
    const NODE_A = '/student/courses/sec-1/roadmap?node=module_item%3Aitem-3'
    nav.pathname = '/student/courses/sec-1/roadmap'
    window.history.replaceState(null, '', NODE_A)

    const scroller = renderWithScroller()
    scroller.scrollTop = 900
    fireEvent.click(screen.getByText('drive'))
    commit(ROADMAP)
    scroller.scrollTop = 0

    fireEvent.click(screen.getByText('back'))

    expect(nav.push).toHaveBeenLastCalledWith(NODE_A)
    commit(NODE_A)
    await waitFor(() => expect(scroller.scrollTop).toBe(900))
  })

  it('waits for the old page to be back on screen before restoring its scroll', async () => {
    const scroller = renderWithScroller()
    scroller.scrollTop = 1280
    fireEvent.click(screen.getByText('drive'))
    // The drive lands: same layout `<main>`, new content, scrolled to the top.
    commit(ROADMAP)
    scroller.scrollTop = 0

    fireEvent.click(screen.getByText('back'))

    // The push has been issued but the destination hasn't committed, so 1280
    // still belongs to a page that isn't on screen. Writing it now would scroll
    // the ROADMAP to where the student was on the modules list — the exact bug a
    // single requestAnimationFrame had.
    await frames(4)
    expect(scroller.scrollTop).toBe(0)

    commit(MODULES)
    await waitFor(() => expect(scroller.scrollTop).toBe(1280))
  })

  it('restores a student who was at the very bottom of the page', async () => {
    const scroller = renderWithScroller()
    // The end of a long modules list — the most common deep position there is,
    // and the one where the height check is exactly satisfied rather than
    // comfortably: max scroll is 1980 - 700 = 1280, the offset itself. A check
    // that demands slack (`>` instead of `>=`) never restores this student at
    // all, and does it silently, since every other case still works.
    sizeScroller(scroller, 1980, 700)
    scroller.scrollTop = 1280
    fireEvent.click(screen.getByText('drive'))
    commit(ROADMAP)
    scroller.scrollTop = 0

    fireEvent.click(screen.getByText('back'))
    commit(MODULES)

    await waitFor(() => expect(scroller.scrollTop).toBe(1280))
  })

  it('leaves the student alone when there was no scroll worth restoring', async () => {
    // They asked from the top of the page, so the route is the whole undo and
    // there is no offset to write. The retry still runs — it is how the shell
    // learns the route landed — but writing the 0 anyway would yank back a
    // student who started reading while the page was still coming.
    const scroller = renderWithScroller()
    fireEvent.click(screen.getByText('drive'))
    commit(ROADMAP)

    fireEvent.click(screen.getByText('back'))
    // The student starts scrolling before the modules page has even committed.
    scroller.scrollTop = 420
    commit(MODULES)

    await frames(5)
    expect(scroller.scrollTop).toBe(420)
  })

  it('gives up rather than jumping when the page comes back too short to hold it', async () => {
    const scroller = renderWithScroller()
    scroller.scrollTop = 1280
    fireEvent.click(screen.getByText('drive'))
    commit(ROADMAP)
    scroller.scrollTop = 0
    // Back on a page whose content shrank (a filter reset, deleted material):
    // 1280 doesn't exist there any more.
    sizeScroller(scroller, 800, 700)

    fireEvent.click(screen.getByText('back'))
    commit(MODULES)

    await frames(6)
    expect(scroller.scrollTop).toBe(0)
    // The route half still happened — that's the part worth keeping. But the
    // receipt has to admit the other half didn't: "took you back to where you
    // were" is the one claim the student can check by looking at the page.
    expect(nav.push).toHaveBeenLastCalledWith(MODULES)
    await waitFor(() => expect(screen.getByText('back:route-only')).toBeInTheDocument())
  })

  it('stops trying once its window has passed, instead of scrolling them later', async () => {
    // The retry above is BOUNDED, and the bound is the part a test has to hold:
    // an unbounded version passes every assertion in this block while leaving a
    // callback armed for the life of the page — and then lands the old offset
    // whenever the page happens to grow tall enough, which by that point is a
    // page the student is already reading. Jumped past any plausible window
    // rather than the exact constant, so tuning the constant isn't a failure.
    const scroller = renderWithScroller()
    scroller.scrollTop = 1280
    fireEvent.click(screen.getByText('drive'))
    commit(ROADMAP)
    scroller.scrollTop = 0
    sizeScroller(scroller, 800, 700)

    let clockJump = 0
    const realNow = performance.now.bind(performance)
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + clockJump)
    try {
      fireEvent.click(screen.getByText('back'))
      commit(MODULES)
      await frames(2)

      clockJump = 60_000
      await frames(3)
      clockJump = 0

      // The page finally finishes loading and IS tall enough now. Too late.
      sizeScroller(scroller, 4000, 700)
      await frames(5)
      expect(scroller.scrollTop).toBe(0)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('gets out of the way the moment the student takes the scroll back', async () => {
    // The nastiest shape of this: a route WITH a loading.tsx commits its skeleton
    // almost immediately, so the student can see they're back and start reading
    // while the retry is still waiting for a page tall enough to hold 1280. When
    // the real content lands, honouring the placemark would yank them out of
    // wherever they had got to. A scroll of their own ends the undo.
    const scroller = renderWithScroller()
    scroller.scrollTop = 1280
    fireEvent.click(screen.getByText('drive'))
    commit(ROADMAP)
    scroller.scrollTop = 0
    sizeScroller(scroller, 900, 700)

    fireEvent.click(screen.getByText('back'))
    commit(MODULES)
    await frames(2)

    fireEvent.wheel(window)
    scroller.scrollTop = 150
    // The page finishes loading and IS tall enough now — too late, they have it.
    sizeScroller(scroller, 4000, 700)

    await frames(5)
    expect(scroller.scrollTop).toBe(150)
    await waitFor(() => expect(screen.getByText('back:route-only')).toBeInTheDocument())
  })

  it('offers nothing to undo when she never moved the app', () => {
    // Chat-only mode declines the drive, so there is no placemark. `back` here is
    // the chat asking anyway (a stale offer, a double click): it must no-op
    // rather than push the page they are already on.
    renderWithScroller()
    fireEvent.click(screen.getByText('back'))
    expect(nav.push).not.toHaveBeenCalled()
  })
})

// The receiving half of the roadmap's "Study with Athena" link. The producers
// (the node card's skill rail and the S19 weak-skill note, via roadmap-signals.ts)
// hardcode `?athena-topic=` and now write it onto the path the student is ALREADY
// on, through the History API — so if this reader ever stops matching that param
// name, the click leaves a param sitting in the URL and nothing else happens: no
// dock, no error, no symptom at all. The old link went to a separate AI-Tutor
// page, where a mismatched param still landed you somewhere; that fallback is
// gone, which is what makes the two ends worth pinning separately.
describe('AthenaShell — ?athena-topic= deep link', () => {
  function renderAt(search: string) {
    nav.pathname = '/student/courses/sec-1/roadmap'
    nav.search = search
    window.history.replaceState(null, '', `/student/courses/sec-1/roadmap?${search}`)
    return render(
      <AthenaShell greetingName="Ada">
        <div>course page</div>
      </AthenaShell>,
    )
  }

  it('opens the dock by itself with the topic already asked', () => {
    // Encoded exactly as roadmap-signals.ts / the node modal build it.
    renderAt('athena-topic=Word+alignment')

    // No click anywhere: the link IS the gesture.
    expect(host()).toHaveAttribute('data-pose', 'docked')
    expect(screen.getByText(/^topic:/).textContent).toContain('Word alignment')
  })

  it('strips the param so a refresh does not re-ask', () => {
    renderAt('athena-topic=Word+alignment&node=module_item%3Ai-1')

    expect(new URLSearchParams(window.location.search).get('athena-topic')).toBeNull()
    // Only the topic goes: ?node= belongs to the roadmap's own card state, and
    // taking it out from under the canvas would close the card the link came from.
    expect(new URLSearchParams(window.location.search).get('node')).toBe('module_item:i-1')
  })

  it('ignores an empty topic instead of asking about nothing', () => {
    // A skill name that URL-encodes to whitespace would otherwise open the dock
    // and send Athena `Help me understand ""`.
    renderAt('athena-topic=+')

    expect(host()).toHaveAttribute('data-pose', 'closed')
    expect(screen.queryByText(/^topic:/)).not.toBeInTheDocument()
  })
})
