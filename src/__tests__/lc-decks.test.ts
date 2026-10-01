// Tests for multi-deck switching (#8) server actions: switchDeck (mirror +
// ownership/IDOR + room-not-live + unrendered guards) and the deck-scoped
// appendTranscription (accepts a valid-but-inactive deck of the room — the
// in-flight-switch case — but rejects a deck from another room).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: vi.fn(),
  canWriteAsProfessor: vi.fn((role: string) => role === 'professor'),
}))
vi.mock('@/lib/live-classroom/deck-converter', () => ({ isPptxEnabled: () => true }))
// removeDeck erases the deck's transcript vectors alongside its rows (N1). The
// wrapper talks to Pinecone, so it is stubbed — the assertion that it is CALLED
// with the deck grain lives in the deck-removal test below.
const deleteTranscriptVectors = vi.fn().mockResolvedValue(0)
vi.mock('@/lib/pinecone/data', () => ({
  deleteTranscriptVectors: (...a: unknown[]) => deleteTranscriptVectors(...a),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let switchDeck: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let removeDeck: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let appendTranscription: any

const ROOM_ID = '11111111-1111-4111-8111-111111111111'
const DECK_ID = '22222222-2222-4222-8222-222222222222'
const PROF = { id: 'prof-1' }

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  const mod = await import(
    '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
  )
  switchDeck = mod.switchDeck
  removeDeck = mod.removeDeck
  appendTranscription = mod.appendTranscription
})

function authAs(user: { id: string } | null) {
  mockGetUser.mockResolvedValue({ data: { user }, error: null })
}

/**
 * Table-aware admin mock. `deck` is what lc_decks lookups resolve to (null =
 * deck not found / not in this room). Exposes spies for the room update and
 * the transcription RPC.
 */
function buildAdmin({
  room = { id: ROOM_ID, prof_id: PROF.id, status: 'live', section_id: 'sec-1' } as Record<string, unknown> | null,
  deck = { id: DECK_ID, room_id: ROOM_ID, deck_url: 'live-classroom-decks/r/d/v', page_count: 8, current_slide: 3 } as Record<string, unknown> | null,
  updateError = null as { message: string } | null,
  rpcError = null as { message: string } | null,
  /** The room's section, as owned by the caller. `null` models a room whose
   *  section_id points at a section this professor does NOT teach — the forged
   *  row verifyRoomOwnership rejects (see the section check there). */
  section = { id: 'sec-1' } as Record<string, unknown> | null,
} = {}) {
  const roomUpdateEq = vi.fn().mockResolvedValue({ error: updateError })
  const roomUpdate = vi.fn().mockReturnValue({ eq: roomUpdateEq })
  const rpc = vi.fn().mockResolvedValue({ error: rpcError })

  const db = {
    rpc,
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'lc_rooms') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: room, error: room ? null : { message: 'nf' } }) }) }),
          update: roomUpdate,
        }
      }
      if (table === 'lc_decks') {
        // switchDeck: .select().eq(id).eq(room_id).maybeSingle()
        // deckBelongsToRoom: .select('id').eq(id).eq(room_id).maybeSingle()
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: deck, error: null }) }) }) }),
        }
      }
      if (table === 'course_sections') {
        // Two shapes read this table:
        //   verifyRoomOwnership .select('id').eq(id).eq(professor_id).maybeSingle()
        //   removeDeck's vector cleanup .select('institution_id').eq(id).single()
        const row = section ? { institution_id: 'inst-1', ...section } : null
        const leaf = {
          maybeSingle: async () => ({ data: section, error: null }),
          single: async () => ({ data: row, error: null }),
        }
        return { select: () => ({ eq: () => ({ ...leaf, eq: () => leaf }) }) }
      }
      throw new Error(`buildAdmin: unexpected table ${table}`)
    }),
  }
  mockAdminClient.mockReturnValue(db)
  return { roomUpdate, roomUpdateEq, rpc }
}

// ── switchDeck ───────────────────────────────────────────────────────

describe('switchDeck', () => {
  it('rejects unauthenticated callers', async () => {
    authAs(null)
    const result = await switchDeck({ roomId: ROOM_ID, deckId: DECK_ID })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects when the caller does not own the room', async () => {
    authAs(PROF)
    buildAdmin({ room: { id: ROOM_ID, prof_id: 'someone-else', status: 'live', section_id: 'sec-1' } })
    const result = await switchDeck({ roomId: ROOM_ID, deckId: DECK_ID })
    expect(result.error).toBe('Room not found or you do not own this room')
  })

  it('rejects when the room has ended', async () => {
    authAs(PROF)
    buildAdmin({ room: { id: ROOM_ID, prof_id: PROF.id, status: 'ended', section_id: 'sec-1' } })
    const result = await switchDeck({ roomId: ROOM_ID, deckId: DECK_ID })
    expect(result.error).toBe('Room has ended')
  })

  it('rejects a deck that does not belong to the room (IDOR)', async () => {
    authAs(PROF)
    const { roomUpdate } = buildAdmin({ deck: null })
    const result = await switchDeck({ roomId: ROOM_ID, deckId: DECK_ID })
    expect(result.error).toBe('Deck not found')
    expect(roomUpdate).not.toHaveBeenCalled()
  })

  it('rejects a deck that has not finished rendering', async () => {
    authAs(PROF)
    const { roomUpdate } = buildAdmin({
      deck: { id: DECK_ID, room_id: ROOM_ID, deck_url: null, page_count: null, current_slide: 0 },
    })
    const result = await switchDeck({ roomId: ROOM_ID, deckId: DECK_ID })
    expect(result.error).toContain('still preparing')
    expect(roomUpdate).not.toHaveBeenCalled()
  })

  it('mirrors the deck onto the room (active_deck_id + url/page_count + resumed slide)', async () => {
    authAs(PROF)
    const { roomUpdate } = buildAdmin()
    const result = await switchDeck({ roomId: ROOM_ID, deckId: DECK_ID })
    expect(result.success).toBe(true)
    expect(roomUpdate).toHaveBeenCalledWith({
      active_deck_id: DECK_ID,
      deck_url: 'live-classroom-decks/r/d/v',
      deck_page_count: 8,
      current_slide: 3, // resumes where the deck was left
    })
  })
})

// ── removeDeck ───────────────────────────────────────────────────────

/**
 * Admin mock for removeDeck: deck-belongs check, the delete, the
 * remaining-deck lookup, storage cleanup, room update, and broadcast RPC.
 */
function buildRemoveAdmin({
  room = { id: ROOM_ID, prof_id: PROF.id, status: 'live', section_id: 'sec-1', active_deck_id: DECK_ID } as Record<string, unknown> | null,
  deck = { id: DECK_ID } as Record<string, unknown> | null,
  remaining = null as Record<string, unknown> | null,
} = {}) {
  const deckDeleteEq = vi.fn().mockResolvedValue({ error: null })
  const deckDelete = vi.fn().mockReturnValue({ eq: deckDeleteEq })
  const roomUpdateEq = vi.fn().mockResolvedValue({ error: null })
  const roomUpdate = vi.fn().mockReturnValue({ eq: roomUpdateEq })
  const rpc = vi.fn().mockResolvedValue({ error: null })
  const storageRemove = vi.fn().mockResolvedValue({ error: null })
  const storageList = vi.fn().mockResolvedValue({ data: [] }) // empty folder

  const db = {
    rpc,
    storage: { from: () => ({ list: storageList, remove: storageRemove }) },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'lc_rooms') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: room, error: room ? null : { message: 'nf' } }) }) }),
          update: roomUpdate,
        }
      }
      if (table === 'lc_decks') {
        return {
          select: () => ({
            eq: () => ({
              // deckBelongsToRoom: .eq(id).eq(room_id).maybeSingle()
              eq: () => ({ maybeSingle: async () => ({ data: deck, error: null }) }),
              // remaining: .eq(room_id).not(deck_url).order().limit().maybeSingle()
              // (no .neq(id) — the row is deleted before this lookup runs)
              not: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: remaining, error: null }) }) }) }),
            }),
          }),
          delete: deckDelete,
        }
      }
      if (table === 'course_sections') {
        // verifyRoomOwnership's section check, then the vector cleanup's
        // institution lookup (see the shapes noted in buildAdmin).
        const leaf = {
          maybeSingle: async () => ({ data: { id: 'sec-1' }, error: null }),
          single: async () => ({ data: { id: 'sec-1', institution_id: 'inst-1' }, error: null }),
        }
        return { select: () => ({ eq: () => ({ ...leaf, eq: () => leaf }) }) }
      }
      throw new Error(`buildRemoveAdmin: unexpected table ${table}`)
    }),
  }
  mockAdminClient.mockReturnValue(db)
  return { deckDelete, roomUpdate, rpc }
}

describe('removeDeck', () => {
  it('rejects unauthenticated callers', async () => {
    authAs(null)
    const result = await removeDeck({ roomId: ROOM_ID, deckId: DECK_ID })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects a deck that does not belong to the room (IDOR), without deleting', async () => {
    authAs(PROF)
    const { deckDelete } = buildRemoveAdmin({ deck: null })
    const result = await removeDeck({ roomId: ROOM_ID, deckId: DECK_ID })
    expect(result.error).toBe('Deck not found')
    expect(deckDelete).not.toHaveBeenCalled()
  })

  it('removes a non-active deck without touching the room mirror, and nudges a re-snapshot', async () => {
    authAs(PROF)
    const { deckDelete, roomUpdate, rpc } = buildRemoveAdmin({
      room: { id: ROOM_ID, prof_id: PROF.id, status: 'live', section_id: 'sec-1', active_deck_id: 'other-active-deck' },
      deck: { id: DECK_ID },
    })
    const result = await removeDeck({ roomId: ROOM_ID, deckId: DECK_ID })
    expect(result.success).toBe(true)
    expect(deckDelete).toHaveBeenCalled()
    expect(roomUpdate).not.toHaveBeenCalled() // not active → room mirror untouched
    // p_persist must be true: a seq=null deck_ready is dropped by the client
    // spoof filter, so the re-snapshot nudge only survives when persisted.
    expect(rpc).toHaveBeenCalledWith(
      'lc_send_event',
      expect.objectContaining({ p_event_type: 'deck_ready', p_persist: true }),
    )
  })

  it('removing the active deck re-activates the most recent remaining deck', async () => {
    authAs(PROF)
    const { roomUpdate } = buildRemoveAdmin({
      deck: { id: DECK_ID },
      remaining: { id: 'deck-prev', deck_url: 'live-classroom-decks/r/prev/v', page_count: 12, current_slide: 5 },
    })
    const result = await removeDeck({ roomId: ROOM_ID, deckId: DECK_ID })
    expect(result.success).toBe(true)
    expect(roomUpdate).toHaveBeenCalledWith({
      active_deck_id: 'deck-prev',
      deck_url: 'live-classroom-decks/r/prev/v',
      deck_page_count: 12,
      current_slide: 5, // resumes the fallback deck where it was left
    })
  })

  it('removing the last deck clears the room back to the no-deck state', async () => {
    authAs(PROF)
    const { roomUpdate } = buildRemoveAdmin({ deck: { id: DECK_ID }, remaining: null })
    const result = await removeDeck({ roomId: ROOM_ID, deckId: DECK_ID })
    expect(result.success).toBe(true)
    expect(roomUpdate).toHaveBeenCalledWith({
      active_deck_id: null,
      deck_url: null,
      deck_page_count: null,
      current_slide: 0,
    })
  })
})

// ── appendTranscription (deck-scoped) ────────────────────────────────

describe('appendTranscription deck binding', () => {
  it('accepts a valid deck of the room even when it is not the active deck (in-flight switch)', async () => {
    authAs(PROF)
    // The room's active deck is some OTHER deck, but the chunk was captured on
    // DECK_ID (still a deck of this room) — it must still be accepted.
    const { rpc } = buildAdmin({
      room: { id: ROOM_ID, prof_id: PROF.id, status: 'live', section_id: 'sec-1', active_deck_id: 'other-deck' },
      deck: { id: DECK_ID, room_id: ROOM_ID },
    })
    const result = await appendTranscription({
      roomId: ROOM_ID,
      deckId: DECK_ID,
      pageNumber: 2,
      text: 'a chunk spoken on the previous deck',
    })
    expect(result.success).toBe(true)
    expect(rpc).toHaveBeenCalledWith(
      'lc_append_transcription',
      expect.objectContaining({ p_room_id: ROOM_ID, p_deck_id: DECK_ID, p_page_number: 2 }),
    )
  })

  it('rejects a deckId that belongs to another room and never writes', async () => {
    authAs(PROF)
    const { rpc } = buildAdmin({ deck: null }) // deck not found in this room
    const result = await appendTranscription({
      roomId: ROOM_ID,
      deckId: DECK_ID,
      pageNumber: 0,
      text: 'should be rejected',
    })
    expect(result.error).toBe('Deck not found')
    expect(rpc).not.toHaveBeenCalled()
  })
})
