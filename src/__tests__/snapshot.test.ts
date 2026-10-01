// Tests for getRoomSnapshot — the single round-trip used by clients to
// hydrate a room view + anchor future replay calls.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getRoomSnapshot: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  const mod = await import('@/lib/live-classroom/snapshot')
  getRoomSnapshot = mod.getRoomSnapshot
})

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const SECTION_ID = '7f8d8c0e-1234-4abc-8def-0123456789ab'
const PROF_ID = '12345678-1234-4abc-89ef-0123456789ab'
const STUDENT_ID = '87654321-4321-4cba-9def-0123456789ab'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InteractionRow = Record<string, any>

// A chainable, awaitable query stub for lc_interactions. The snapshot fires
// three reads off the same table (open polls/quizzes, closed ones, questions)
// distinguished only by their filters — so the builder records the kind/status
// filters and resolves to the matching bucket when awaited.
function interactionsChain(buckets: { open: InteractionRow[]; closed: InteractionRow[]; questions: InteractionRow[] }) {
  const state: { kind?: string; status?: string } = {}
  const builder = {
    select: () => builder,
    eq: (col: string, val: string) => {
      if (col === 'kind') state.kind = val
      if (col === 'status') state.status = val
      return builder
    },
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve: (v: { data: InteractionRow[]; error: null }) => void) => {
      const data =
        state.kind === 'question' ? buckets.questions : state.status === 'closed' ? buckets.closed : buckets.open
      resolve({ data, error: null })
    },
  }
  return builder
}

function buildAdminDb(opts: {
  room?: { id: string; section_id: string; prof_id: string; current_slide: number; status: string } | null
  roomError?: { message: string } | null
  enrollment?: { id: string } | null
  latest?: { seq: number } | null
  openInteractions?: InteractionRow[]
}) {
  const room = opts.room ?? null
  const roomError = opts.roomError ?? null
  const enrollment = opts.enrollment ?? null
  const latest = opts.latest ?? null
  const openInteractions = opts.openInteractions ?? []

  return {
    from(table: string) {
      if (table === 'lc_interactions') {
        return interactionsChain({ open: openInteractions, closed: [], questions: [] })
      }
      if (table === 'lc_decks') {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }
      }
      if (table === 'lc_rooms') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: room, error: roomError }),
            }),
          }),
        }
      }
      if (table === 'enrollments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: () => ({
                  maybeSingle: async () => ({ data: enrollment, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'lc_events') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: latest, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      throw new Error(`Unexpected table ${table}`)
    },
  }
}

describe('getRoomSnapshot', () => {
  it('returns Not authenticated when there is no user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const result = await getRoomSnapshot(ROOM_ID)
    expect(result.error).toBe('Not authenticated')
  })

  it('returns Invalid input for non-UUID roomId', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    const result = await getRoomSnapshot('not-a-uuid')
    expect(result.error).toMatch(/Invalid input/)
  })

  it('returns Room not found when room does not exist', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({ room: null, roomError: { message: 'no rows' } }),
    )
    const result = await getRoomSnapshot(ROOM_ID)
    expect(result.error).toBe('Room not found')
  })

  it('returns Forbidden when user is neither prof nor enrolled', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, current_slide: 0, status: 'live' },
        enrollment: null,
      }),
    )
    const result = await getRoomSnapshot(ROOM_ID)
    expect(result.error).toBe('Forbidden')
  })

  it('returns snapshot for the room professor with lastSeq=0 when no events exist', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, current_slide: 5, status: 'live' },
        latest: null,
      }),
    )
    const result = await getRoomSnapshot(ROOM_ID)
    expect(result.snapshot).toBeDefined()
    expect(result.snapshot?.room.id).toBe(ROOM_ID)
    expect(result.snapshot?.lastSeq).toBe(0)
  })

  it('returns snapshot for an enrolled student with the latest seq', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, current_slide: 0, status: 'live' },
        enrollment: { id: 'e-1' },
        latest: { seq: 42 },
      }),
    )
    const result = await getRoomSnapshot(ROOM_ID)
    expect(result.snapshot?.lastSeq).toBe(42)
  })

  // The no-leak guarantee behind the Projector View: a professor caller is
  // normally trusted with answers, but `viewerSafe: true` must force the same
  // student stripping path so the projected wall never shows the answer key.
  const quizWithAnswers = () => ({
    id: 'q-1',
    room_id: ROOM_ID,
    kind: 'quiz',
    payload: {
      title: 'Quiz',
      questions: [{ id: 'qq1', prompt: '?', choices: [{ id: 'a' }, { id: 'b' }], correctChoiceId: 'a', explanation: 'because a' }],
      report: { totals: 1 },
    },
    status: 'open',
    created_by: PROF_ID,
    created_at: '2026-01-01T00:00:00Z',
    opened_at: '2026-01-01T00:00:00Z',
    closed_at: null,
  })

  it('keeps quiz answers for the professor by default (no viewerSafe)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, current_slide: 0, status: 'live' },
        openInteractions: [quizWithAnswers()],
      }),
    )
    const result = await getRoomSnapshot(ROOM_ID)
    const q = result.snapshot?.openInteractions[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((q?.payload.questions as any)[0].correctChoiceId).toBe('a')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((q?.payload.questions as any)[0].explanation).toBe('because a')
    expect(q?.payload.report).toBeDefined()
  })

  it('strips quiz answers for the professor when viewerSafe is set (Projector View)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, current_slide: 0, status: 'live' },
        openInteractions: [quizWithAnswers()],
      }),
    )
    const result = await getRoomSnapshot(ROOM_ID, { viewerSafe: true })
    const q = result.snapshot?.openInteractions[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((q?.payload.questions as any)[0].correctChoiceId).toBeUndefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((q?.payload.questions as any)[0].explanation).toBeUndefined()
    expect(q?.payload.report).toBeUndefined()
  })
})
