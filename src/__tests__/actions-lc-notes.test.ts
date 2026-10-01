// Tests for the Live Classroom student notetaker server actions.
//
// These are the IDOR-sensitive surface: getNotes/saveNotes must reject
// unauthenticated and non-enrolled callers, and saveNotes must bind the write
// to the authenticated user's own (room_id, student_id) row — never to anything
// from the caller's input. RLS can't be exercised here (the admin client
// bypasses it), so that write-binding assertion is the load-bearing check.

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
let actions: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  actions = await import('@/lib/live-classroom/notes/actions')
})

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const SECTION_ID = '7f8d8c0e-1234-4abc-8def-0123456789ab'
const PROF_ID = '12345678-1234-4abc-89ef-0123456789ab'
const STUDENT_ID = '87654321-4321-4cba-9def-0123456789ab'

interface FakeDbState {
  room?: { id: string; section_id: string; prof_id: string; status: string } | null
  enrolled?: boolean
  notesRow?: { content: string } | null
  selectError?: { message: string } | null
  upsertError?: { message: string } | null
}

function buildAdminDb(state: FakeDbState) {
  const upserted: Array<{ row: Record<string, unknown>; opts: unknown }> = []

  const adminDb = {
    upserted,
    from(table: string) {
      if (table === 'lc_rooms') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: state.room ?? null,
                error: state.room ? null : { message: 'no rows' },
              }),
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
                  maybeSingle: async () => ({
                    data: state.enrolled ? { id: 'e-1' } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'lc_notes') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: state.selectError ? null : (state.notesRow ?? null),
                  error: state.selectError ?? null,
                }),
              }),
            }),
          }),
          upsert: (row: Record<string, unknown>, opts: unknown) => {
            upserted.push({ row, opts })
            return Promise.resolve({ error: state.upsertError ?? null })
          },
        }
      }
      throw new Error(`Unexpected table ${table}`)
    },
  }

  return adminDb
}

const liveRoom = { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' }

// ── getNotes ─────────────────────────────────────────────────────────

describe('getNotes', () => {
  it('rejects unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    expect((await actions.getNotes(ROOM_ID)).error).toBe('Not authenticated')
  })

  it('rejects an invalid room id', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    expect((await actions.getNotes('not-a-uuid')).error).toBe('Invalid room ID')
  })

  it('rejects when the room does not exist', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({ room: null }))
    expect((await actions.getNotes(ROOM_ID)).error).toBe('Room not found')
  })

  it('rejects a non-enrolled caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({ room: liveRoom, enrolled: false }))
    expect((await actions.getNotes(ROOM_ID)).error).toBe('You are not enrolled in this section')
  })

  it('returns the existing note for an enrolled student', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({ room: liveRoom, enrolled: true, notesRow: { content: 'hello' } }))
    expect((await actions.getNotes(ROOM_ID)).content).toBe('hello')
  })

  it('returns empty string when the student has no note yet', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({ room: liveRoom, enrolled: true, notesRow: null }))
    expect((await actions.getNotes(ROOM_ID)).content).toBe('')
  })
})

// ── saveNotes ────────────────────────────────────────────────────────

describe('saveNotes', () => {
  it('rejects unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    expect((await actions.saveNotes(ROOM_ID, 'x')).error).toBe('Not authenticated')
  })

  it('rejects an invalid room id', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    expect((await actions.saveNotes('not-a-uuid', 'x')).error).toBe('Invalid input')
  })

  it('rejects content over the size cap', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    expect((await actions.saveNotes(ROOM_ID, 'a'.repeat(500_001))).error).toBe('Invalid input')
  })

  it('rejects a non-enrolled caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({ room: liveRoom, enrolled: false }))
    expect((await actions.saveNotes(ROOM_ID, 'x')).error).toBe('You are not enrolled in this section')
  })

  it('upserts the note bound to the caller\'s own (room, student) row', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    const adminDb = buildAdminDb({ room: liveRoom, enrolled: true })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await actions.saveNotes(ROOM_ID, 'my note')
    expect(result.success).toBe(true)
    expect(adminDb.upserted).toHaveLength(1)
    // Security-critical: the write binds to the authenticated user + room,
    // never to anything from caller input.
    expect(adminDb.upserted[0].row.student_id).toBe(STUDENT_ID)
    expect(adminDb.upserted[0].row.room_id).toBe(ROOM_ID)
    expect(adminDb.upserted[0].row.content).toBe('my note')
    expect(adminDb.upserted[0].opts).toEqual({ onConflict: 'room_id,student_id' })
  })

  it('maps a DB upsert error to a save failure', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({ room: liveRoom, enrolled: true, upsertError: { message: 'boom' } }))
    expect((await actions.saveNotes(ROOM_ID, 'x')).error).toBe('Failed to save notes')
  })
})
