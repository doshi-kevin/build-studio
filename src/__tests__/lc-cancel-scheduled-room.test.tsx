/**
 * "Cancel session" on the pre-class setup screen called endRoom, which requires
 * status === 'live'. A scheduled room is 'scheduled' until Start is clicked, so the
 * control could only ever fail — reporting "Room has already ended" about a room
 * that had never begun. The hub's Upcoming list had the correct call all along.
 *
 * The oracle is WHICH action fires for each status. Asserting "no error toast"
 * would be weaker: the old code failed by calling the wrong action, not by
 * throwing, so the call itself is the thing under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const endRoom = vi.fn()
const cancelScheduledSession = vi.fn()
const push = vi.fn()
let roomStatus: 'scheduled' | 'live' = 'scheduled'

vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions', () => ({
  endRoom: (...a: unknown[]) => endRoom(...a),
  cancelScheduledSession: (...a: unknown[]) => cancelScheduledSession(...a),
  advanceSlide: vi.fn(),
  switchDeck: vi.fn(),
  removeDeck: vi.fn(),
  setScreenBlank: vi.fn(),
  shareRoomUploads: vi.fn(),
}))
// Deck picker fetches its config on mount; irrelevant to which end/cancel action fires.
vi.mock('@/components/professor/live-classroom/UploadDeckDialog', () => ({
  UploadDeckDialog: () => null,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), promise: vi.fn() } }))
/* LivePresenter takes its connection from the parent now (#639) rather than opening its
   own, so the slide state hook is what gets mocked — the room shape it returns is the
   same as before. */
vi.mock('@/lib/live-classroom/broadcast/use-slide-sync', () => ({
  useSlideState: () => ({
    room: { id: 'room-1', status: roomStatus, current_slide: 0, deck_page_count: null, deck_url: null },
    deckRender: null,
    slideUrls: [],
    resetDeckRender: vi.fn(),
  }),
}))

/** The parent's bus. LivePresenter only forwards it to the mocked hook here. */
const fakeBus = { on: () => () => {}, emit: () => {}, clear: () => {} } as never
const ROOM_PROP = { id: 'room-1', status: 'scheduled', current_slide: 0 } as never

import { LivePresenter } from '@/components/professor/live-classroom/LivePresenter'

const SECTION = '8a2ac745-bbd2-4848-a4b6-aeac1e69bb4b'

/** Click the two-step inline confirm: the idle control, then its confirm button. */
async function confirmEndOrCancel() {
  fireEvent.click(screen.getByRole('button', { name: /cancel session|end class|end\b/i }))
  // The confirm affordance replaces the idle control, so re-query after the click.
  // Confirm copy differs per surface: "Yes, cancel" pre-class, "Yes, end" on the
  // deckless recovery screen, bare "Yes" in the live overlay.
  const confirm = await screen.findByRole('button', { name: /^yes(,\s*(cancel|end))?$/i })
  fireEvent.click(confirm)
}

describe('pre-class "Cancel session"', () => {
  beforeEach(() => {
    endRoom.mockReset().mockResolvedValue({ success: true })
    cancelScheduledSession.mockReset().mockResolvedValue({ success: true })
    push.mockReset()
  })

  it('cancels a scheduled room instead of trying to end it', async () => {
    roomStatus = 'scheduled'
    render(
      <LivePresenter
        roomId="room-1"
        sectionId={SECTION}
        bus={fakeBus}
        initialRoom={ROOM_PROP}
        initialSlideUrls={[]}
        connectionStatus="live"
        decks={[]}
        activeDeckId={null}
      />,
    )

    await confirmEndOrCancel()

    await waitFor(() => expect(cancelScheduledSession).toHaveBeenCalledWith({ roomId: 'room-1', scope: 'one' }))
    // The bug in one line: endRoom must not be the call for a room that never started.
    expect(endRoom).not.toHaveBeenCalled()
  })

  it('still ends a live room via endRoom', async () => {
    roomStatus = 'live'
    render(
      <LivePresenter
        roomId="room-1"
        sectionId={SECTION}
        bus={fakeBus}
        initialRoom={ROOM_PROP}
        initialSlideUrls={[]}
        connectionStatus="live"
        decks={[]}
        activeDeckId={null}
      />,
    )

    await confirmEndOrCancel()

    await waitFor(() => expect(endRoom).toHaveBeenCalledWith({ roomId: 'room-1' }))
    expect(cancelScheduledSession).not.toHaveBeenCalled()
  })
})
