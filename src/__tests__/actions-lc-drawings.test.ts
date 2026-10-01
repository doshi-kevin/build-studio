// Tests for the Live Classroom drawings server actions.
// Covers persistStrokes (auth + enrollment + rate limit + authorId
// overwrite + bulk insert) and clearSlideAnnotations (prof-only delete).

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
  actions = await import('@/lib/live-classroom/drawings/actions')
})

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const DECK_ID = 'd1d1d1d1-58cc-4372-a567-0e02b2c3d479'
const SECTION_ID = '7f8d8c0e-1234-4abc-8def-0123456789ab'
const PROF_ID = '12345678-1234-4abc-89ef-0123456789ab'
const STUDENT_ID = '87654321-4321-4cba-9def-0123456789ab'
const SPOOFED_AUTHOR_ID = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa'

interface FakeDbState {
  room?: { id?: string; section_id?: string; prof_id: string } | null
  enrolled?: boolean
  /** Whether the deck belongs to the room (default true). */
  deckExists?: boolean
  insertError?: { message: string } | null
  deleteError?: { message: string } | null
  /** false → rate limit active; true (default) → permitted; null → null result */
  rateLimitAllowed?: boolean | null
}

interface CapturedInsert {
  table: string
  rows: Array<Record<string, unknown>>
}
interface CapturedDelete {
  table: string
  filters: Record<string, unknown>
}

function buildAdminDb(state: FakeDbState) {
  const inserted: CapturedInsert[] = []
  const deleted: CapturedDelete[] = []

  const adminDb = {
    inserted,
    deleted,
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
      if (table === 'lc_decks') {
        // deckBelongsToRoom: .select('id').eq('id').eq('room_id').maybeSingle()
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: state.deckExists === false ? null : { id: DECK_ID },
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'lc_slide_annotations') {
        return {
          insert: (rows: Array<Record<string, unknown>>) => {
            inserted.push({ table, rows })
            return Promise.resolve({ error: state.insertError ?? null })
          },
          delete: () => {
            const filters: Record<string, unknown> = {}
            const builder = {
              eq(col: string, val: unknown) {
                filters[col] = val
                return builder
              },
              then(
                onFulfilled?: (val: { error: { message: string } | null }) => unknown,
              ) {
                deleted.push({ table, filters })
                return Promise.resolve({ error: state.deleteError ?? null }).then(
                  onFulfilled,
                )
              },
            }
            return builder
          },
        }
      }
      throw new Error(`Unexpected table ${table}`)
    },
    rpc: vi.fn(async () => ({
      data: state.rateLimitAllowed === undefined ? true : state.rateLimitAllowed,
      error: null,
    })),
  }

  return adminDb
}

function buildStrokeInput(overrides: Partial<{ id: string; slideIndex: number; authorId: string }> = {}) {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    slideIndex: overrides.slideIndex ?? 0,
    points: [{ x: 0, y: 0, t: 0 }],
    color: '#000000',
    width: 2,
    authorId: overrides.authorId ?? SPOOFED_AUTHOR_ID,
  }
}

// ── persistStrokes ───────────────────────────────────────────────────

describe('persistStrokes', () => {
  it('rejects unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const result = await actions.persistStrokes(ROOM_ID, DECK_ID, [buildStrokeInput()])
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects when the room does not exist', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({ room: null }))
    const result = await actions.persistStrokes(ROOM_ID, DECK_ID, [buildStrokeInput()])
    expect(result.error).toBe('Room not found')
  })

  it('rejects students who are not enrolled in the section', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID },
        enrolled: false,
      }),
    )
    const result = await actions.persistStrokes(ROOM_ID, DECK_ID, [buildStrokeInput()])
    expect(result.error).toBe('Forbidden')
  })

  it('allows the room professor to persist strokes', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    const adminDb = buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID },
    })
    mockAdminClient.mockReturnValue(adminDb)
    const result = await actions.persistStrokes(ROOM_ID, DECK_ID, [buildStrokeInput()])
    expect(result.success).toBe(true)
    expect(adminDb.inserted).toHaveLength(1)
    expect(adminDb.inserted[0].table).toBe('lc_slide_annotations')
  })

  it('allows enrolled students to persist strokes', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    const adminDb = buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID },
      enrolled: true,
    })
    mockAdminClient.mockReturnValue(adminDb)
    const result = await actions.persistStrokes(ROOM_ID, DECK_ID, [buildStrokeInput()])
    expect(result.success).toBe(true)
    expect(adminDb.inserted).toHaveLength(1)
  })

  it('SECURITY: overwrites the client-provided authorId with the authenticated user id', async () => {
    // A malicious client could otherwise attribute strokes to the prof or
    // another student. The action MUST replace authorId before insert.
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    const adminDb = buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID },
    })
    mockAdminClient.mockReturnValue(adminDb)

    await actions.persistStrokes(ROOM_ID, DECK_ID, [
      buildStrokeInput({ authorId: SPOOFED_AUTHOR_ID }),
    ])

    expect(adminDb.inserted).toHaveLength(1)
    const row = adminDb.inserted[0].rows[0]
    expect(row.author_id).toBe(PROF_ID)
    expect((row.stroke as { authorId: string }).authorId).toBe(PROF_ID)
  })

  it('drops silently when the per-user rate limit is hit (returns success without insert)', async () => {
    // Rate-limit denials must NOT surface as an error toast — the next
    // batch will succeed. We still return success:true and skip the insert.
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    const adminDb = buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID },
      rateLimitAllowed: false,
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await actions.persistStrokes(ROOM_ID, DECK_ID, [buildStrokeInput()])
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(adminDb.inserted).toHaveLength(0)
  })

  it('rejects when the room id is not a valid UUID', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID },
      }),
    )
    const result = await actions.persistStrokes('not-a-uuid', DECK_ID, [buildStrokeInput()])
    expect(result.error).toMatch(/Invalid input/)
  })

  it('rejects empty stroke arrays', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID },
      }),
    )
    const result = await actions.persistStrokes(ROOM_ID, DECK_ID, [])
    expect(result.error).toMatch(/Invalid input/)
  })

  it('returns an error when the bulk insert fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID },
        insertError: { message: 'db down' },
      }),
    )
    const result = await actions.persistStrokes(ROOM_ID, DECK_ID, [buildStrokeInput()])
    expect(result.error).toBe('Failed to persist strokes')
  })

  it('rejects strokes with negative slideIndex', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID },
      }),
    )
    const result = await actions.persistStrokes(ROOM_ID, DECK_ID, [
      buildStrokeInput({ slideIndex: -1 }),
    ])
    expect(result.error).toMatch(/Invalid input/)
  })
})

// ── clearSlideAnnotations ────────────────────────────────────────────

describe('clearSlideAnnotations', () => {
  it('rejects unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const result = await actions.clearSlideAnnotations(ROOM_ID, DECK_ID, 0)
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects when the room does not exist', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({ room: null }))
    const result = await actions.clearSlideAnnotations(ROOM_ID, DECK_ID, 0)
    expect(result.error).toBe('Room not found')
  })

  it('SECURITY: rejects students even when they are enrolled', async () => {
    // Only the room professor may call clear — students must not have
    // delete power on the persisted annotations table.
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID },
        enrolled: true,
      }),
    )
    const result = await actions.clearSlideAnnotations(ROOM_ID, DECK_ID, 0)
    expect(result.error).toBe('Only the professor can clear annotations')
  })

  it('allows the room professor to clear and scopes the delete to the right deck+slide', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    const adminDb = buildAdminDb({
      room: { prof_id: PROF_ID },
    })
    mockAdminClient.mockReturnValue(adminDb)

    const result = await actions.clearSlideAnnotations(ROOM_ID, DECK_ID, 3)
    expect(result.success).toBe(true)
    expect(adminDb.deleted).toHaveLength(1)
    expect(adminDb.deleted[0].table).toBe('lc_slide_annotations')
    // Scoped to the deck (not the whole room) so it can't wipe another deck's
    // strokes that share the same slide index.
    expect(adminDb.deleted[0].filters.deck_id).toBe(DECK_ID)
    expect(adminDb.deleted[0].filters.slide_index).toBe(3)
  })

  it('rejects when the room id is not a valid UUID', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({ room: { prof_id: PROF_ID } }),
    )
    const result = await actions.clearSlideAnnotations('not-a-uuid', DECK_ID, 0)
    expect(result.error).toMatch(/Invalid input/)
  })

  it('rejects negative slide indices', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({ room: { prof_id: PROF_ID } }),
    )
    const result = await actions.clearSlideAnnotations(ROOM_ID, DECK_ID, -1)
    expect(result.error).toMatch(/Invalid input/)
  })

  it('returns an error when the delete fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(
      buildAdminDb({
        room: { prof_id: PROF_ID },
        deleteError: { message: 'db down' },
      }),
    )
    const result = await actions.clearSlideAnnotations(ROOM_ID, DECK_ID, 0)
    expect(result.error).toBe('Failed to clear annotations')
  })
})
