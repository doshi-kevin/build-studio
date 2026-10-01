/**
 * #636 — the lc_decks row is inserted BEFORE the render runs, so a terminal render
 * failure (PDF over the page cap, or a PPTX whose Gotenberg conversion dies) left a
 * row behind. The Switch-deck dialog renders any non-ready deck as a disabled
 * "Preparing…" with no delete affordance, so every failed upload added a permanent
 * dead entry and a professor mid-class couldn't tell one from a deck still
 * processing.
 *
 * The oracle is the DELETE and its filters. Two things must hold, and the second is
 * the dangerous one:
 *   1. a failed render removes its own never-rendered row,
 *   2. it is scoped `.is('deck_url', null)` — a failed RE-render must never delete a
 *      deck that already rendered, or it would destroy slides being presented.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getUser = vi.fn()
const renderDeckToStorage = vi.fn()

class RenderDeckError extends Error {
  clientMessage: string
  httpStatus: number
  constructor(clientMessage: string, httpStatus = 400) {
    super(clientMessage)
    this.clientMessage = clientMessage
    this.httpStatus = httpStatus
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser } }),
}))
vi.mock('@/lib/live-classroom/render-deck', () => ({
  renderDeckToStorage: (...a: unknown[]) => renderDeckToStorage(...a),
  RenderDeckError,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const ROOM = '33333333-3333-4333-8333-333333333333'
const DECK = '44444444-4444-4444-8444-444444444444'
const PROF = '55555555-5555-4555-8555-555555555555'

interface DeleteCall {
  eq: Record<string, unknown>
  is: Record<string, unknown>
}

const deletes: DeleteCall[] = []

/** adminDb double: resolves the room, and records the shape of any lc_decks delete. */
function makeAdmin() {
  return {
    from(table: string) {
      if (table === 'lc_rooms') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: ROOM, prof_id: PROF, section_id: 'sec-1', status: 'live' },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'lc_decks') {
        const call: DeleteCall = { eq: {}, is: {} }
        const chain: Record<string, unknown> = {}
        Object.assign(chain, {
          eq: (col: string, val: unknown) => {
            call.eq[col] = val
            return chain
          },
          is: (col: string, val: unknown) => {
            call.is[col] = val
            deletes.push(call)
            return Promise.resolve({ error: null })
          },
        })
        return { delete: () => chain }
      }
      throw new Error(`unexpected table ${table}`)
    },
    rpc: async () => ({ data: null, error: null }),
  }
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeAdmin() }))

async function post() {
  // Imported lazily so the module-level mutex is fresh per import graph.
  const { POST } = await import('@/app/api/live-classroom/render-deck/route')
  const req = {
    json: async () => ({ roomId: ROOM, deckId: DECK, activate: true }),
  } as unknown as Parameters<typeof POST>[0]
  return POST(req)
}

describe('#636 — a failed render rolls back its own deck row', () => {
  beforeEach(() => {
    deletes.length = 0
    getUser.mockReset().mockResolvedValue({ data: { user: { id: PROF } } })
    renderDeckToStorage.mockReset()
    vi.resetModules()
  })

  it('deletes the never-rendered row when the render fails terminally', async () => {
    renderDeckToStorage.mockRejectedValue(new RenderDeckError('This PDF has too many pages.', 413))

    const res = await post()

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toMatchObject({ error: 'This PDF has too many pages.' })

    expect(deletes).toHaveLength(1)
    expect(deletes[0].eq).toMatchObject({ id: DECK, room_id: ROOM })
    // The guard that stops a failed re-render destroying a working deck.
    expect(deletes[0].is).toMatchObject({ deck_url: null })
  })

  it('does NOT delete anything when the render succeeds', async () => {
    renderDeckToStorage.mockResolvedValue({ deckUrl: 'https://example/deck.pdf', pageCount: 12 })

    const res = await post()

    expect(res.status).toBe(200)
    expect(deletes).toHaveLength(0)
  })
})
