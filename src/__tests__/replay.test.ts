// Tests for getEventsSince — the replay buffer reader called on every
// (re)subscribe and on every visibility-change → visible.

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
let getEventsSince: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  const mod = await import('@/lib/live-classroom/replay')
  getEventsSince = mod.getEventsSince
})

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const SECTION_ID = '7f8d8c0e-1234-4abc-8def-0123456789ab'
const PROF_ID = '12345678-1234-4abc-89ef-0123456789ab'
const STUDENT_ID = '87654321-4321-4cba-9def-0123456789ab'

function buildAdminDb(opts: {
  room?: { section_id: string; prof_id: string } | null
  enrollment?: { id: string } | null
  events?: Array<{ seq: number; event_type: string; payload: Record<string, unknown>; created_at: string }>
}) {
  const room = opts.room ?? null
  const enrollment = opts.enrollment ?? null
  const events = opts.events ?? []

  return {
    from(table: string) {
      if (table === 'lc_rooms') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: room, error: room ? null : { message: 'not found' } }),
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
              gt: () => ({
                order: () => ({
                  limit: async () => ({ data: events, error: null }),
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

describe('getEventsSince', () => {
  it('rejects negative lastSeq', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    const result = await getEventsSince(ROOM_ID, -1)
    expect(result.error).toMatch(/Invalid input/)
  })

  it('rejects unauthenticated requests', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const result = await getEventsSince(ROOM_ID, 0)
    expect(result.error).toBe('Not authenticated')
  })

  it('returns Forbidden when user is neither prof nor enrolled', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { section_id: SECTION_ID, prof_id: PROF_ID },
        enrollment: null,
      }),
    )
    const result = await getEventsSince(ROOM_ID, 0)
    expect(result.error).toBe('Forbidden')
  })

  it('returns events for the professor', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { section_id: SECTION_ID, prof_id: PROF_ID },
        events: [
          { seq: 5, event_type: 'slide_changed', payload: { slideIndex: 1 }, created_at: '2026-04-28T00:00:00Z' },
          { seq: 6, event_type: 'slide_changed', payload: { slideIndex: 2 }, created_at: '2026-04-28T00:00:01Z' },
        ],
      }),
    )
    const result = await getEventsSince(ROOM_ID, 4)
    expect(result.events).toHaveLength(2)
    expect(result.events?.[0].type).toBe('slide_changed')
    expect(result.events?.[0].seq).toBe(5)
    expect(result.events?.[1].seq).toBe(6)
  })

  it('returns events for an enrolled student', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { section_id: SECTION_ID, prof_id: PROF_ID },
        enrollment: { id: 'e-1' },
        events: [
          { seq: 1, event_type: 'slide_changed', payload: { slideIndex: 0 }, created_at: '2026-04-28T00:00:00Z' },
        ],
      }),
    )
    const result = await getEventsSince(ROOM_ID, 0)
    expect(result.events).toHaveLength(1)
  })

  it('returns Room not found when room does not exist', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({ room: null }))
    const result = await getEventsSince(ROOM_ID, 0)
    expect(result.error).toBe('Room not found')
  })
})
