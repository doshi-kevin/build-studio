// render_scheduled_deck background pipeline — the durable render that survives
// the professor leaving. The pipeline owns three behaviors on top of the shared
// render core:
//   - idempotency: a re-kicked/retried job must not re-render an already-done deck
//   - graceful skip when the deck/session was cancelled before the worker ran
//   - delete-on-failure: a genuine render failure drops the half-baked deck row
//     so reopening the session offers a clean re-upload (the failed job row stays)

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the render core so we drive its outcome without touching pdfjs/canvas.
// The pipeline does `err instanceof RenderDeckError`, so the mock must expose a
// real class the pipeline and the test both share. vi.hoisted keeps these
// available to the hoisted vi.mock factory.
const { mockRender, MockRenderDeckError } = vi.hoisted(() => {
  class MockRenderDeckError extends Error {
    constructor(
      public reason: string,
      public httpStatus: number,
      public clientMessage: string,
    ) {
      super(clientMessage)
      this.name = 'RenderDeckError'
    }
  }
  return { mockRender: vi.fn(), MockRenderDeckError }
})
vi.mock('@/lib/live-classroom/render-deck', () => ({
  renderDeckToStorage: (...a: unknown[]) => mockRender(...a),
  RenderDeckError: MockRenderDeckError,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { renderScheduledDeckPipeline } from '@/lib/jobs/pipelines/render-scheduled-deck'

const ROOM = 'room-1'
const DECK = 'deck-1'
const SECTION = 'sec-1'

/** Minimal adminDb: the lc_decks lookup returns `deck`; delete is spied. */
function makeDb(deck: { id: string; deck_url: string | null } | null) {
  const deleteSpy = vi.fn(() => ({ eq: () => ({ eq: async () => ({ error: null }) }) }))
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: deck, error: null }) }) }) }),
      delete: deleteSpy,
    }),
  }
  return { db, deleteSpy }
}

function ctx(db: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { adminDb: db, job: { section_id: SECTION, created_by: 'prof-1' } } as any
}

describe('render_scheduled_deck pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips (already_rendered) without re-rendering when deck_url is present', async () => {
    const { db } = makeDb({ id: DECK, deck_url: 'live-classroom-decks/x' })
    const out = await renderScheduledDeckPipeline.run({ roomId: ROOM, deckId: DECK }, ctx(db))
    expect(out.result).toMatchObject({ skipped: 'already_rendered' })
    expect(mockRender).not.toHaveBeenCalled()
  })

  it('skips (deck_gone) when the deck was cancelled/deleted before the worker ran', async () => {
    const { db } = makeDb(null)
    const out = await renderScheduledDeckPipeline.run({ roomId: ROOM, deckId: DECK }, ctx(db))
    expect(out.result).toMatchObject({ skipped: 'deck_gone' })
    expect(mockRender).not.toHaveBeenCalled()
  })

  it('renders and reports the page count on success', async () => {
    const { db } = makeDb({ id: DECK, deck_url: null })
    mockRender.mockResolvedValue({ deckUrl: 'u', pageCount: 7 })
    const out = await renderScheduledDeckPipeline.run({ roomId: ROOM, deckId: DECK }, ctx(db))
    expect(out.result).toMatchObject({ pageCount: 7 })
    // Never activates on the room — attended model (activate:false).
    expect(mockRender).toHaveBeenCalledWith(expect.objectContaining({ activate: false, roomId: ROOM, deckId: DECK }))
  })

  it('deletes the half-baked deck row and rethrows on a genuine render failure', async () => {
    const { db, deleteSpy } = makeDb({ id: DECK, deck_url: null })
    mockRender.mockRejectedValue(new MockRenderDeckError('render', 500, 'boom'))
    await expect(renderScheduledDeckPipeline.run({ roomId: ROOM, deckId: DECK }, ctx(db))).rejects.toThrow('boom')
    expect(deleteSpy).toHaveBeenCalledTimes(1)
  })

  it('treats a cancelled-mid-render as a clean no-op (no delete, no rethrow)', async () => {
    const { db, deleteSpy } = makeDb({ id: DECK, deck_url: null })
    mockRender.mockRejectedValue(new MockRenderDeckError('cancelled', 409, 'This session was cancelled.'))
    const out = await renderScheduledDeckPipeline.run({ roomId: ROOM, deckId: DECK }, ctx(db))
    expect(out.result).toMatchObject({ skipped: 'cancelled' })
    expect(deleteSpy).not.toHaveBeenCalled()
  })
})
