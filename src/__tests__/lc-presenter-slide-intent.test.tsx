/**
 * Slide advance used to swallow clicks. `handleNext` computed its target from
 * `room.current_slide`, which is server-confirmed state that only moves when the
 * broadcast round-trips (~1s in practice). Two clicks inside that window both read
 * the same "current" slide and both asked the server for the same target, so the
 * second one did nothing and said nothing. Measured in a browser before the fix:
 * 3 clicks 500ms apart advanced 2 slides.
 *
 * The fix carries the professor's intent across that gap in a ref, while leaving the
 * broadcast as the source of truth for what the room actually shows.
 *
 * The oracle is the sequence of `slideIndex` values handed to `advanceSlide` — what we
 * ASKED the server for. Deliberately not the ref itself: the reconcile condition has
 * already been rewritten three times, and a test coupled to its shape would have to be
 * rewritten with it while proving nothing about behaviour.
 *
 * `useSlideState` is mocked so a test can confirm a slide independently of the click
 * that requested it. That separation IS the bug's habitat. The hook's own broadcast
 * contract stays covered by use-slide-sync.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { LcRoom } from '@/lib/validations/live-classroom'

/* Typed with its argument so `mock.calls[n][0].slideIndex` type-checks — that
   sequence is the oracle for every test below. */
const advanceSlide = vi.fn(async (args: { roomId: string; slideIndex: number }) => {
  void args
  return { success: true } as { success?: true; error?: string }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

/* The whole actions module, not just advanceSlide: LivePresenter renders
   UploadDeckDialog, which calls getDeckUploadConfig/getModuleDeckItems on mount. */
vi.mock(
  '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions',
  () => ({
    advanceSlide: (args: { roomId: string; slideIndex: number }) => advanceSlide(args),
    endRoom: vi.fn(),
    switchDeck: vi.fn(),
    removeDeck: vi.fn(),
    setScreenBlank: vi.fn(),
    shareRoomUploads: vi.fn(),
    cancelScheduledSession: vi.fn(),
    createDeckUploadUrl: vi.fn(async () => ({ error: 'not used in this test' })),
    getDeckUploadConfig: vi.fn(async () => ({ maxBytes: 1, maxPages: 1 })),
    getModuleDeckItems: vi.fn(async () => ({ items: [] })),
    applyModuleItemAsDeck: vi.fn(async () => ({ error: 'not used in this test' })),
  }),
)

/* The room the component sees. Tests mutate this and re-render to simulate a
   broadcast landing, which is the one thing the real hook does on its own clock. */
let mockRoom: LcRoom

vi.mock('@/lib/live-classroom/broadcast/use-slide-sync', () => ({
  useSlideState: () => ({
    room: mockRoom,
    deckRender: null,
    slideUrls: ['/a.png', '/b.png', '/c.png', '/d.png', '/e.png'],
    resetDeckRender: vi.fn(),
  }),
}))

const { LivePresenter } = await import(
  '@/components/professor/live-classroom/LivePresenter'
)

function makeRoom(over: Partial<LcRoom> = {}): LcRoom {
  return {
    id: 'room-1',
    current_slide: 0,
    deck_page_count: 5,
    deck_url: 'deck-a',
    // Without this LivePresenter renders PreClassSetup instead of the stage,
    // and there are no nav buttons to click.
    setup_completed: true,
    is_blanked: false,
    status: 'live',
    name: 'Test session',
    created_at: new Date(0).toISOString(),
    active_deck_id: 'deck-a',
    ...over,
  } as LcRoom
}

function renderPresenter() {
  const bus = { on: () => () => {}, emit: vi.fn() }
  return render(
    <LivePresenter
      roomId="room-1"
      sectionId="section-1"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bus={bus as any}
      initialRoom={mockRoom}
      initialSlideUrls={['/a.png']}
      connectionStatus="live"
    />,
  )
}

/** Re-render with the room mutated — stands in for a broadcast arriving. */
function confirmSlide(rerender: (ui: React.ReactElement) => void, over: Partial<LcRoom>) {
  mockRoom = makeRoom({ ...mockRoom, ...over })
  const bus = { on: () => () => {}, emit: vi.fn() }
  act(() => {
    rerender(
      <LivePresenter
        roomId="room-1"
        sectionId="section-1"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bus={bus as any}
        initialRoom={mockRoom}
        initialSlideUrls={['/a.png']}
        connectionStatus="live"
      />,
    )
  })
}

const asked = () => advanceSlide.mock.calls.map((c) => c[0].slideIndex)

let now = 1_000_000
beforeEach(() => {
  now = 1_000_000
  // Step past SLIDE_ADVANCE_THROTTLE_MS (300) without real waiting. The throttle is
  // deliberate and untouched; these tests are about what happens OUTSIDE its window.
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  advanceSlide.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const clickNext = () => fireEvent.click(screen.getByRole('button', { name: 'Next slide' }))
const clickPrev = () => fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }))

describe('LivePresenter — slide intent across the broadcast gap', () => {
  it('a second click inside the round-trip advances, it does not re-ask for the same slide', async () => {
    mockRoom = makeRoom({ current_slide: 0 })
    renderPresenter()

    clickNext()
    now += 500 // past the throttle, but the broadcast for slide 1 has NOT landed
    clickNext()

    // Pre-fix this was [1, 1]: both clicks read current_slide 0.
    expect(asked()).toEqual([1, 2])
  })

  it('survives a late confirmation overtaking an intent, going backwards', async () => {
    mockRoom = makeRoom({ current_slide: 4 })
    const { rerender } = renderPresenter()

    clickPrev() // asks 3
    now += 500
    clickPrev() // asks 2, while 3 is still unconfirmed

    // Slide 3 lands late — an intent we have already overtaken.
    confirmSlide(rerender, { current_slide: 3 })

    now += 500
    clickPrev()

    // With a `>=` reconcile this is [3, 2, 2]: the late confirm clears the intent
    // and the third click recomputes from the room. Needs three clicks to show up —
    // the effect only runs when current_slide changes, so two would pass either way.
    expect(asked()).toEqual([3, 2, 1])
  })

  it('drops the intent when the deck changes under it', async () => {
    // Starts at slide 0 deliberately. A deck switch writes current_slide 0, so if the
    // room is already there the slide number never changes and the reconcile effect
    // above never runs — the deck_url effect is the ONLY thing that clears the
    // intent. Starting anywhere else lets the reconcile catch it instead, and the
    // test passes even with the deck reset deleted (confirmed by mutation).
    mockRoom = makeRoom({ current_slide: 0, deck_url: 'deck-a', deck_page_count: 5 })
    const { rerender } = renderPresenter()

    clickNext() // asks 1, outstanding

    confirmSlide(rerender, { deck_url: 'deck-b', current_slide: 0, active_deck_id: 'deck-b' })

    now += 500
    clickNext()

    // Must ask for slide 1 of the NEW deck. Carrying the old intent forward would
    // ask for 2 and skip the new deck's second slide.
    expect(asked()[1]).toBe(1)
  })

  it('ignores an intent once another device moves the room', async () => {
    mockRoom = makeRoom({ current_slide: 1 })
    const { rerender } = renderPresenter()

    clickNext() // asks 2, outstanding

    // A second professor tab jumps the room somewhere we never asked for.
    // Deliberately not the last slide (index 4 of a 5-page deck), or the next
    // click would be a legitimate no-op and prove nothing.
    confirmSlide(rerender, { current_slide: 3 })

    now += 500
    clickNext()

    // Must step from where the room actually is, not from our stale intent —
    // stepping from 2 would drag the whole room backwards in front of the class.
    expect(asked()[1]).toBe(4)
  })
})
