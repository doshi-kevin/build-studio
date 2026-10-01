// Tests for Live Classroom server actions — room lifecycle management and
// the "Pick from Modules" flow (getModuleDeckItems, applyModuleItemAsDeck).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-Level Mock References ─────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockFrom = vi.fn()
const mockStorage = vi.fn()
const mockIsPptxEnabled = vi.fn(() => true)
const mockEnqueue = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
/* `verifyRoomOwnership` re-checks that the room's section really belongs to the
   caller (a forged row can carry the attacker's prof_id and a victim's
   section_id). That read is pure authorization plumbing — every test below
   mocks the tables its ACTION touches, so rather than teach ~20 inline mocks
   about `course_sections`, the admin client is wrapped once here: the section
   lookup answers "yes, yours" by default, and `sectionOwned(false)` makes it
   answer "no" for the test that asserts the guard bites.
   The wrap is transparent — every other table falls through to the test's own
   mock untouched. */
let sectionOwnedByCaller = true
const sectionOwned = (owned: boolean) => {
  sectionOwnedByCaller = owned
}
const courseSectionsStub = () => {
  const row = sectionOwnedByCaller ? { id: 'sec-1', institution_id: 'inst-1' } : null
  const leaf = {
    maybeSingle: async () => ({ data: row, error: null }),
    single: async () => ({ data: row, error: null }),
  }
  return { select: () => ({ eq: () => ({ ...leaf, eq: () => leaf }) }) }
}
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => {
    const db = mockAdminClient(...args)
    if (!db || typeof db.from !== 'function') return db
    const inner = db.from.bind(db)
    return { ...db, from: (table: string) => (table === 'course_sections' ? courseSectionsStub() : inner(table)) }
  },
}))
// removeDeck erases the deck's transcript vectors with the same call (N1).
vi.mock('@/lib/pinecone/data', () => ({ deleteTranscriptVectors: vi.fn().mockResolvedValue(0) }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: vi.fn(),
  canWriteAsProfessor: vi.fn((role: string) => role === 'professor'),
}))
vi.mock('@/lib/live-classroom/deck-converter', () => ({
  isPptxEnabled: () => mockIsPptxEnabled(),
}))
// `after` runs its callback synchronously so we can assert the recompute kick.
vi.mock('next/server', () => ({ after: (fn: () => void | Promise<void>) => fn() }))
vi.mock('@/lib/extraction/enqueue', () => ({
  enqueueMasteryRecompute: (...a: unknown[]) => mockEnqueue(...a),
}))

// ── Action references ────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createRoomDraft: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let advanceSlide: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setScreenBlank: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let endRoom: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createDeckUploadUrl: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getModuleDeckItems: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let applyModuleItemAsDeck: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let closeQuizWithReport: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getInteractionNonResponders: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let verifySectionAccess: any

beforeEach(async () => {
  vi.resetModules()
  sectionOwnedByCaller = true // the room's section is the caller's unless a test says otherwise
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockFrom.mockReset()
  mockStorage.mockReset()
  mockEnqueue.mockReset()
  mockIsPptxEnabled.mockReturnValue(true) // converter enabled by default; tests opt out

  const mod = await import(
    '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
  )
  createRoomDraft = mod.createRoomDraft
  advanceSlide = mod.advanceSlide
  setScreenBlank = mod.setScreenBlank
  endRoom = mod.endRoom
  createDeckUploadUrl = mod.createDeckUploadUrl
  getModuleDeckItems = mod.getModuleDeckItems
  applyModuleItemAsDeck = mod.applyModuleItemAsDeck
  closeQuizWithReport = mod.closeQuizWithReport
  getInteractionNonResponders = mod.getInteractionNonResponders

  const accessMod = await import('@/lib/auth/section-access')
  verifySectionAccess = accessMod.verifySectionAccess
})

// ── createRoomDraft ──────────────────────────────────

describe('createRoomDraft', () => {
  it('returns error when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

    const result = await createRoomDraft({
      sectionId: '123e4567-e89b-12d3-a456-426614174000',
    })
    expect(result.error).toBe('Not authenticated')
  })

  it('returns error for invalid sectionId', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const result = await createRoomDraft({ sectionId: 'not-a-uuid' })
    expect(result.error).toContain('Invalid input')
  })

  it('returns error when user lacks professor access', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    // Mock section access check to deny
    vi.mocked(verifySectionAccess).mockResolvedValue({
      ok: false,
      adminDb: mockAdminClient(),
    })

    const result = await createRoomDraft({
      sectionId: '123e4567-e89b-12d3-a456-426614174000',
    })
    expect(result.error).toBe('You do not have access to this section')
  })

  it('returns error when TA tries to create room', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    // Mock section access check for TA
    vi.mocked(verifySectionAccess).mockResolvedValue({
      ok: true,
      role: 'ta',
      adminDb: mockAdminClient(),
    })

    const result = await createRoomDraft({
      sectionId: '123e4567-e89b-12d3-a456-426614174000',
    })
    expect(result.error).toBe('Only professors can start live classroom sessions')
  })

  it('creates room successfully for professor', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const mockDb = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'room-1' }, error: null }),
      storage: {
        from: vi.fn().mockReturnValue({
          list: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      },
    }

    // Mock stale rooms query to return empty
    mockDb.from.mockImplementation((table: string) => {
      if (table === 'lc_rooms') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          lt: vi.fn().mockResolvedValue({ data: [], error: null }),
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'room-1' }, error: null }),
            }),
          }),
        }
      }
      return mockDb
    })

    vi.mocked(verifySectionAccess).mockResolvedValue({
      ok: true,
      role: 'professor',
      adminDb: mockDb,
    })

    const result = await createRoomDraft({
      sectionId: '123e4567-e89b-12d3-a456-426614174000',
    })

    expect(result.roomId).toBe('room-1')
    expect(result.error).toBeUndefined()
  })
})

// ── advanceSlide ─────────────────────────────────────

describe('advanceSlide', () => {
  it('returns error when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

    const result = await advanceSlide({
      roomId: '123e4567-e89b-12d3-a456-426614174000',
      slideIndex: 5,
    })
    expect(result.error).toBe('Not authenticated')
  })

  it('returns error for negative slideIndex', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const result = await advanceSlide({
      roomId: '123e4567-e89b-12d3-a456-426614174000',
      slideIndex: -1,
    })
    expect(result.error).toContain('Invalid input')
  })

  it('returns error when room not found', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
          }),
        }),
      }),
    })

    const result = await advanceSlide({
      roomId: '123e4567-e89b-12d3-a456-426614174000',
      slideIndex: 0,
    })
    expect(result.error).toBe('Room not found or you do not own this room')
  })

  it('returns error when user does not own room', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'room-1',
                prof_id: 'user-2', // Different user
                status: 'live',
                deck_page_count: 10,
              },
              error: null,
            }),
          }),
        }),
      }),
    })

    const result = await advanceSlide({
      roomId: '123e4567-e89b-12d3-a456-426614174000',
      slideIndex: 0,
    })
    expect(result.error).toBe('Room not found or you do not own this room')
  })

  /* A forged room carries the ATTACKER's prof_id (so the prof_id check passes)
     and a VICTIM's section_id. RLS now refuses to create one
     (20260806193123), but a pre-existing row must stay inert: driving it would
     feed attacker-authored slides and transcript into the victim section's
     surfaces — including "what the professor said in class". */
  it('rejects a room whose section belongs to someone else, even when prof_id matches', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    sectionOwned(false)
    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'room-1', prof_id: 'user-1', section_id: 'victim-section', status: 'live', deck_page_count: 10 },
              error: null,
            }),
          }),
        }),
      }),
    })

    const result = await advanceSlide({
      roomId: '123e4567-e89b-12d3-a456-426614174000',
      slideIndex: 0,
    })
    expect(result.error).toBe('Room not found or you do not own this room')
  })

  it('returns error when slide index out of range', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'room-1',
                prof_id: 'user-1',
                status: 'live',
                deck_page_count: 5,
              },
              error: null,
            }),
          }),
        }),
      }),
    })

    const result = await advanceSlide({
      roomId: '123e4567-e89b-12d3-a456-426614174000',
      slideIndex: 10, // Out of range (max is 4)
    })
    expect(result.error).toBe('Slide index out of range')
  })
})


// ── setScreenBlank ───────────────────────────────────

describe('setScreenBlank', () => {
  const roomId = '123e4567-e89b-12d3-a456-426614174000'

  it('returns error when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

    const result = await setScreenBlank({ roomId, isBlanked: true })
    expect(result.error).toBe('Not authenticated')
  })

  it('returns error for invalid input', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const result = await setScreenBlank({ roomId: 'not-a-uuid', isBlanked: true })
    expect(result.error).toContain('Invalid input')
  })

  it('returns error when user does not own room', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'room-1',
                prof_id: 'user-2', // Different user
                status: 'live',
              },
              error: null,
            }),
          }),
        }),
      }),
    })

    const result = await setScreenBlank({ roomId, isBlanked: true })
    expect(result.error).toBe('Room not found or you do not own this room')
  })

  it('returns error when room has ended', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'room-1',
                prof_id: 'user-1',
                status: 'ended',
              },
              error: null,
            }),
          }),
        }),
      }),
    })

    const result = await setScreenBlank({ roomId, isBlanked: true })
    expect(result.error).toBe('Room has ended')
  })

  it('updates is_blanked on the owned live room', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const mockUpdateEq = vi.fn().mockResolvedValue({ error: null })
    const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEq })
    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'room-1',
                prof_id: 'user-1',
                status: 'live',
              },
              error: null,
            }),
          }),
        }),
        update: mockUpdate,
      }),
    })

    const result = await setScreenBlank({ roomId, isBlanked: true })
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(mockUpdate).toHaveBeenCalledWith({ is_blanked: true })
    expect(mockUpdateEq).toHaveBeenCalledWith('id', roomId)
  })
})

// ── endRoom ──────────────────────────────────────────

describe('endRoom', () => {
  it('returns error when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

    const result = await endRoom({
      roomId: '123e4567-e89b-12d3-a456-426614174000',
    })
    expect(result.error).toBe('Not authenticated')
  })

  it('returns error for invalid roomId', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const result = await endRoom({ roomId: 'not-a-uuid' })
    expect(result.error).toContain('Invalid input')
  })

  it('returns error when room not found', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
          }),
        }),
      }),
    })

    const result = await endRoom({
      roomId: '123e4567-e89b-12d3-a456-426614174000',
    })
    expect(result.error).toBe('Room not found or you do not own this room')
  })

  it('returns error when room already ended', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'room-1',
                prof_id: 'user-1',
                status: 'ended', // Already ended
                section_id: 'section-1',
              },
              error: null,
            }),
          }),
        }),
      }),
    })

    const result = await endRoom({
      roomId: '123e4567-e89b-12d3-a456-426614174000',
    })
    expect(result.error).toBe('Room has already ended')
  })
})

// ── createDeckUploadUrl ──────────────────────────────

describe('createDeckUploadUrl', () => {
  const validRoomId = '123e4567-e89b-12d3-a456-426614174000'

  it('returns error when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

    const result = await createDeckUploadUrl({ roomId: validRoomId })
    expect(result.error).toBe('Not authenticated')
  })

  it('returns error for invalid roomId', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const result = await createDeckUploadUrl({ roomId: 'not-a-uuid' })
    expect(result.error).toContain('Invalid input')
  })

  it('returns error when room not found', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
          }),
        }),
      }),
    })

    const result = await createDeckUploadUrl({ roomId: validRoomId })
    expect(result.error).toBe('Room not found or you do not own this room')
  })

  it('returns error when prof does not own the room', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'room-1', prof_id: 'someone-else', status: 'live' },
              error: null,
            }),
          }),
        }),
      }),
    })

    const result = await createDeckUploadUrl({ roomId: validRoomId })
    expect(result.error).toBe('Room not found or you do not own this room')
  })

  it('returns error when room is not live', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'room-1', prof_id: 'user-1', status: 'ended' },
              error: null,
            }),
          }),
        }),
      }),
    })

    const result = await createDeckUploadUrl({ roomId: validRoomId })
    expect(result.error).toBe('Room has ended')
  })

  const DECK_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

  // Table-aware admin mock for the deck-creation flow: lc_rooms (ownership),
  // lc_decks (next position + insert), and storage (signed upload URL).
  function deckUploadAdmin({
    room = { id: 'room-1', prof_id: 'user-1', status: 'live' },
    deckInsertError = null as { message: string } | null,
    createSignedUploadUrl,
  }: {
    room?: unknown
    deckInsertError?: { message: string } | null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSignedUploadUrl: any
  }) {
    return {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'lc_rooms') {
          return {
            select: () => ({ eq: () => ({ single: async () => ({ data: room, error: room ? null : { message: 'nf' } }) }) }),
          }
        }
        if (table === 'lc_decks') {
          return {
            select: () => ({
              eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { position: 0 }, error: null }) }) }) }),
            }),
            insert: () => ({
              select: () => ({
                single: async () => ({ data: deckInsertError ? null : { id: DECK_ID }, error: deckInsertError }),
              }),
            }),
            // source_file_path is recorded on the deck after the path is known.
            update: () => ({ eq: async () => ({ error: null }) }),
          }
        }
        throw new Error(`deckUploadAdmin: unexpected table ${table}`)
      }),
      storage: { from: vi.fn().mockReturnValue({ createSignedUploadUrl }) },
    }
  }

  it('returns deckId + signed URL on happy path with upsert:true and {roomId}/{deckId}/source.pdf', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const expectedPath = `${validRoomId}/${DECK_ID}/source.pdf`
    const createSignedUploadUrl = vi.fn().mockResolvedValue({
      data: {
        signedUrl: 'https://example.supabase.co/storage/v1/object/upload/sign/...',
        token: 'tok-123',
        path: expectedPath,
      },
      error: null,
    })

    mockAdminClient.mockReturnValue(deckUploadAdmin({ createSignedUploadUrl }))

    const result = await createDeckUploadUrl({ roomId: validRoomId, title: 'lecture.pdf' })

    expect(result.error).toBeUndefined()
    expect(result.deckId).toBe(DECK_ID)
    expect(result.signedUrl).toMatch(/^https:\/\//)
    expect(result.token).toBe('tok-123')
    expect(result.path).toBe(expectedPath)
    expect(createSignedUploadUrl).toHaveBeenCalledWith(expectedPath, { upsert: true })
  })

  it('returns error when signed URL minting fails', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue(
      deckUploadAdmin({
        createSignedUploadUrl: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'storage offline' },
        }),
      }),
    )

    const result = await createDeckUploadUrl({ roomId: validRoomId })
    expect(result.error).toBe('Failed to prepare upload')
  })
})

// ── getModuleDeckItems ──────────────────────────────────────

describe('getModuleDeckItems', () => {
  const validSectionId = '11111111-1111-4111-8111-111111111111'

  it('returns error when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

    const result = await getModuleDeckItems(validSectionId)
    expect(result.error).toBe('Not authenticated')
    expect(result.items).toEqual([])
  })

  it('returns error when user lacks section access', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    vi.mocked(verifySectionAccess).mockResolvedValue({
      ok: false,
      adminDb: mockAdminClient(),
    })

    const result = await getModuleDeckItems(validSectionId)
    expect(result.error).toBe('You do not have access to this section')
    expect(result.items).toEqual([])
  })

  it('returns error when TA tries to access', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    vi.mocked(verifySectionAccess).mockResolvedValue({
      ok: true,
      role: 'ta',
      adminDb: mockAdminClient(),
    })

    const result = await getModuleDeckItems(validSectionId)
    expect(result.error).toBe('Only professors can access this')
    expect(result.items).toEqual([])
  })

  it('returns empty items when no published modules exist', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }

    vi.mocked(verifySectionAccess).mockResolvedValue({
      ok: true,
      role: 'professor',
      adminDb: mockDb,
    })

    const result = await getModuleDeckItems(validSectionId)
    expect(result.error).toBeUndefined()
    expect(result.items).toEqual([])
  })

  it('returns PDF items from published modules, filtering non-PDF lectures', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const moduleId = '22222222-2222-4222-8222-222222222222'

    // Build separate chain instances for modules and module_items queries
    const modulesChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [{ id: moduleId, title: 'Week 1 Lectures' }],
        error: null,
      }),
    }

    const moduleItemsChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'item-pdf-1',
            module_id: moduleId,
            title: 'Intro to CS',
            content: {
              fileType: 'pdf',
              filePath: 'courses/section1/intro.pdf',
              fileName: 'intro.pdf',
              fileSize: '2048000',
            },
          },
          {
            id: 'item-video-1',
            module_id: moduleId,
            title: 'Video Lecture',
            content: { fileType: 'mp4', filePath: 'courses/section1/vid.mp4' },
          },
          {
            id: 'item-pdf-no-path',
            module_id: moduleId,
            title: 'Broken PDF',
            content: { fileType: 'pdf', filePath: '' },
          },
        ],
        error: null,
      }),
    }

    let fromCallCount = 0
    const mockDb = {
      from: vi.fn().mockImplementation(() => {
        fromCallCount++
        // First from() call is for 'modules', second is for 'module_items'
        if (fromCallCount === 1) return modulesChain
        return moduleItemsChain
      }),
    }

    vi.mocked(verifySectionAccess).mockResolvedValue({
      ok: true,
      role: 'professor',
      adminDb: mockDb,
    })

    const result = await getModuleDeckItems(validSectionId)

    expect(result.error).toBeUndefined()
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toEqual({
      id: 'item-pdf-1',
      title: 'Intro to CS',
      moduleName: 'Week 1 Lectures',
      fileName: 'intro.pdf',
      fileSize: '2048000',
      fileType: 'pdf',
    })
  })

  // Shared mock DB for the PPT-gating tests: one PDF + one PPT lecture item.
  function mockDeckItemsDb() {
    const modulesChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [{ id: 'mod-1', title: 'Week 1 Lectures' }],
        error: null,
      }),
    }
    const moduleItemsChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'item-pdf-1',
            module_id: 'mod-1',
            title: 'Intro',
            content: { fileType: 'pdf', filePath: 'c/intro.pdf', fileName: 'intro.pdf', fileSize: '100' },
          },
          {
            id: 'item-ppt-1',
            module_id: 'mod-1',
            title: 'Slides',
            content: { fileType: 'ppt', filePath: 'c/slides.pptx', fileName: 'slides.pptx', fileSize: '200' },
          },
        ],
        error: null,
      }),
    }
    let n = 0
    const mockDb = { from: vi.fn().mockImplementation(() => (++n === 1 ? modulesChain : moduleItemsChain)) }
    vi.mocked(verifySectionAccess).mockResolvedValue({ ok: true, role: 'professor', adminDb: mockDb })
  }

  it('includes PowerPoint items when the converter is enabled', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockIsPptxEnabled.mockReturnValue(true)
    mockDeckItemsDb()

    const result = await getModuleDeckItems(validSectionId)
    expect(result.items).toHaveLength(2)
    expect(result.items.map((i: { fileType: string }) => i.fileType).sort()).toEqual(['pdf', 'ppt'])
  })

  it('hides PowerPoint items when the converter is disabled (graceful degradation)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockIsPptxEnabled.mockReturnValue(false)
    mockDeckItemsDb()

    const result = await getModuleDeckItems(validSectionId)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].fileType).toBe('pdf')
  })
})

// ── applyModuleItemAsDeck ──────────────────────────────────

describe('applyModuleItemAsDeck', () => {
  const validRoomId = '11111111-1111-4111-8111-111111111111'
  const validModuleItemId = '22222222-2222-4222-8222-222222222222'
  const validModuleId = '33333333-3333-4333-8333-333333333333'
  const sectionId = '44444444-4444-4444-8444-444444444444'
  const DECK_ID = 'aaaaaaaa-0000-4000-8000-000000000002'

  // Table-aware admin mock for the module→deck flow: lc_rooms (ownership),
  // module_items, modules (cross-section guard), lc_decks (position + insert),
  // and storage (course-materials download + live-classroom-decks upload).
  function moduleDeckAdmin({
    itemContent = { fileType: 'pdf', filePath: 'courses/section/intro.pdf' } as Record<string, unknown>,
    itemTitle = 'Intro lecture',
    upload,
    deckInsertError = null as { message: string } | null,
  }: {
    itemContent?: Record<string, unknown>
    itemTitle?: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upload: any
    deckInsertError?: { message: string } | null
  }) {
    const fakeBlob = { arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1024)) }
    // Deck-from-module pins the session under the module on the roadmap via a
    // module→resource placement edge — now the atomic place_roadmap_edge RPC
    // (writePlacementEdge). Capture the rpc calls.
    const placementCalls: Array<{ name: string; params: Record<string, unknown> }> = []
    return {
      placementCalls,
      rpc: async (name: string, params: Record<string, unknown>) => {
        placementCalls.push({ name, params })
        return { error: null }
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'lc_rooms') {
          return {
            select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'room-1', prof_id: 'user-1', status: 'live', section_id: sectionId }, error: null }) }) }),
          }
        }
        if (table === 'module_items') {
          return {
            select: () => ({ eq: () => ({ single: async () => ({ data: { id: validModuleItemId, module_id: validModuleId, item_type: 'lecture', title: itemTitle, content: itemContent }, error: null }) }) }),
          }
        }
        if (table === 'modules') {
          return {
            select: () => ({ eq: () => ({ single: async () => ({ data: { id: validModuleId, section_id: sectionId }, error: null }) }) }),
          }
        }
        if (table === 'lc_decks') {
          return {
            select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { position: 0 }, error: null }) }) }) }) }),
            insert: () => ({ select: () => ({ single: async () => ({ data: deckInsertError ? null : { id: DECK_ID }, error: deckInsertError }) }) }),
            // source_file_path recorded after the decks-bucket copy path is known
            update: () => ({ eq: async () => ({ error: null }) }),
            // rollback path when the storage upload fails
            delete: () => ({ eq: async () => ({ error: null }) }),
          }
        }
        throw new Error(`moduleDeckAdmin: unexpected table ${table}`)
      }),
      storage: {
        from: vi.fn().mockImplementation((bucket: string) => {
          if (bucket === 'course-materials') {
            return { download: vi.fn().mockResolvedValue({ data: fakeBlob, error: null }) }
          }
          return { upload }
        }),
      },
    }
  }

  it('returns error when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe('Not authenticated')
  })

  it('returns error for invalid roomId', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const result = await applyModuleItemAsDeck({
      roomId: 'not-a-uuid',
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toContain('Invalid input')
  })

  it('returns error for invalid moduleItemId', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: 'not-a-uuid',
    })
    expect(result.error).toContain('Invalid input')
  })

  it('returns error when room not found', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
          }),
        }),
      }),
    })

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe('Room not found or you do not own this room')
  })

  it('returns error when user does not own room', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'room-1', prof_id: 'user-2', status: 'live', section_id: sectionId },
              error: null,
            }),
          }),
        }),
      }),
    })

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe('Room not found or you do not own this room')
  })

  it('returns error when room has ended', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'room-1', prof_id: 'user-1', status: 'ended', section_id: sectionId },
              error: null,
            }),
          }),
        }),
      }),
    })

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe('Room has ended')
  })

  it('returns error when module item not found', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    // verifyRoomOwnership returns success, then module_items query returns null
    let fromCallCount = 0
    mockAdminClient.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        fromCallCount++
        if (fromCallCount === 1) {
          // lc_rooms query (verifyRoomOwnership)
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'room-1', prof_id: 'user-1', status: 'live', section_id: sectionId },
                  error: null,
                }),
              }),
            }),
          }
        }
        // module_items query — not found
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
            }),
          }),
        }
      }),
    })

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe('Module item not found')
  })

  it('returns error when item is not a lecture type', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    let fromCallCount = 0
    mockAdminClient.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        fromCallCount++
        if (fromCallCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'room-1', prof_id: 'user-1', status: 'live', section_id: sectionId },
                  error: null,
                }),
              }),
            }),
          }
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: validModuleItemId,
                  module_id: validModuleId,
                  item_type: 'assignment', // Not a lecture
                  content: { fileType: 'pdf', filePath: 'path.pdf' },
                },
                error: null,
              }),
            }),
          }),
        }
      }),
    })

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe('Only lecture items can be used as a deck')
  })

  it('returns error when item content is not PDF', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    let fromCallCount = 0
    mockAdminClient.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        fromCallCount++
        if (fromCallCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'room-1', prof_id: 'user-1', status: 'live', section_id: sectionId },
                  error: null,
                }),
              }),
            }),
          }
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: validModuleItemId,
                  module_id: validModuleId,
                  item_type: 'lecture',
                  content: { fileType: 'pptx', filePath: 'slides.pptx' },
                },
                error: null,
              }),
            }),
          }),
        }
      }),
    })

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe('This item does not contain a PDF or PowerPoint file')
  })

  it('returns error when module belongs to a different section (cross-section guard)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const differentSectionId = '55555555-5555-4555-8555-555555555555'
    let fromCallCount = 0
    mockAdminClient.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        fromCallCount++
        if (fromCallCount === 1) {
          // lc_rooms — room belongs to sectionId
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'room-1', prof_id: 'user-1', status: 'live', section_id: sectionId },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (fromCallCount === 2) {
          // module_items — valid lecture PDF
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: validModuleItemId,
                    module_id: validModuleId,
                    item_type: 'lecture',
                    content: { fileType: 'pdf', filePath: 'courses/section/intro.pdf' },
                  },
                  error: null,
                }),
              }),
            }),
          }
        }
        // modules — different section_id
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: validModuleId, section_id: differentSectionId },
                error: null,
              }),
            }),
          }),
        }
      }),
    })

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe('Module item does not belong to this course section')
  })

  it('returns error when source file download fails', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    let fromCallCount = 0
    mockAdminClient.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        fromCallCount++
        if (fromCallCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'room-1', prof_id: 'user-1', status: 'live', section_id: sectionId },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (fromCallCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: validModuleItemId,
                    module_id: validModuleId,
                    item_type: 'lecture',
                    content: { fileType: 'pdf', filePath: 'courses/section/intro.pdf' },
                  },
                  error: null,
                }),
              }),
            }),
          }
        }
        // modules — same section
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: validModuleId, section_id: sectionId },
                error: null,
              }),
            }),
          }),
        }
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'Object not found' },
          }),
        }),
      },
    })

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe(
      'Source file not found in course materials. The file may have been deleted from storage.',
    )
  })

  it('returns error when upload to live-classroom-decks bucket fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(
      moduleDeckAdmin({ upload: vi.fn().mockResolvedValue({ error: { message: 'Bucket full' } }) }),
    )

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe('Failed to prepare deck for live classroom')
  })

  it('returns error when the deck row insert fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(
      moduleDeckAdmin({
        upload: vi.fn().mockResolvedValue({ error: null }),
        deckInsertError: { message: 'DB error' },
      }),
    )

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe('Failed to prepare deck for live classroom')
  })

  it('returns deckId + path on successful copy from modules to live-classroom bucket', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    const mockUpload = vi.fn().mockResolvedValue({ error: null })
    const admin = moduleDeckAdmin({ upload: mockUpload })
    mockAdminClient.mockReturnValue(admin)

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })

    expect(result.error).toBeUndefined()
    expect(result.deckId).toBe(DECK_ID)
    expect(result.path).toBe(`${validRoomId}/${DECK_ID}/source.pdf`)
    // Uploaded to the deck-scoped path.
    expect(mockUpload).toHaveBeenCalledWith(
      `${validRoomId}/${DECK_ID}/source.pdf`,
      expect.anything(),
      expect.objectContaining({ contentType: 'application/pdf', upsert: true }),
    )
    // Picking a deck FROM a module pins the session under that module on the
    // roadmap (module→live_session placement edge, via the atomic RPC).
    expect(admin.placementCalls).toContainEqual(
      expect.objectContaining({
        name: 'place_roadmap_edge',
        params: expect.objectContaining({
          p_module_id: validModuleId,
          p_kind: 'live_session',
          p_resource_id: validRoomId,
        }),
      }),
    )
  })

  it('copies a PowerPoint module item to source.pptx with the pptx content-type', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })

    const mockUpload = vi.fn().mockResolvedValue({ error: null })
    mockAdminClient.mockReturnValue(
      moduleDeckAdmin({
        // fileType is 'ppt' regardless of real extension; the action sniffs the
        // actual ext from fileName.
        itemContent: { fileType: 'ppt', filePath: 'courses/section/lecture.pptx', fileName: 'lecture.pptx' },
        upload: mockUpload,
      }),
    )

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })

    expect(result.error).toBeUndefined()
    expect(result.path).toBe(`${validRoomId}/${DECK_ID}/source.pptx`)
    // Uploaded to the deck-scoped path with the pptx content-type so render-deck converts it.
    expect(mockUpload).toHaveBeenCalledWith(
      `${validRoomId}/${DECK_ID}/source.pptx`,
      expect.anything(),
      expect.objectContaining({
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    )
  })

  it('rejects a PowerPoint module item when the converter is disabled', async () => {
    mockIsPptxEnabled.mockReturnValue(false)
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })

    let fromCallCount = 0
    mockAdminClient.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        fromCallCount++
        if (fromCallCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'room-1', prof_id: 'user-1', status: 'live', section_id: sectionId },
                  error: null,
                }),
              }),
            }),
          }
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: validModuleItemId,
                  module_id: validModuleId,
                  item_type: 'lecture',
                  content: { fileType: 'ppt', filePath: 'courses/section/lecture.pptx', fileName: 'lecture.pptx' },
                },
                error: null,
              }),
            }),
          }),
        }
      }),
    })

    const result = await applyModuleItemAsDeck({
      roomId: validRoomId,
      moduleItemId: validModuleItemId,
    })
    expect(result.error).toBe('PowerPoint conversion is not available right now. Use a PDF lecture instead.')
  })
})

// ── closeQuizWithReport ────────────────────────────────────

describe('closeQuizWithReport', () => {
  const validInteractionId = '11111111-1111-4111-8111-111111111111'
  const roomId = '22222222-2222-4222-8222-222222222222'
  const sectionId = '33333333-3333-4333-8333-333333333333'

  // A minimal but valid quiz interaction payload: one question, two choices.
  const quizInteraction = {
    id: validInteractionId,
    room_id: roomId,
    kind: 'quiz',
    status: 'open',
    payload: {
      title: 'AI Quiz',
      questions: [
        {
          id: 'q1',
          prompt: 'What is 2+2?',
          concept: 'Arithmetic',
          correctChoiceId: 'c2',
          choices: [
            { id: 'c1', text: '3' },
            { id: 'c2', text: '4' },
          ],
        },
      ],
    },
  }

  // Builds the admin-client mock for the close flow, dispatching by TABLE name
  // (robust to query order). The action touches: lc_interactions (select→single,
  // then update→eq), lc_rooms (select→single), lc_responses (select→eq → report
  // + non-responder lookup), enrollments + profiles (non-responder lookup), then
  // adminDb.rpc(...). `responses` rows carry both `response` (for the report) and
  // `student_id` (for #87 non-responders). `rpcImpl` lets a test make the final
  // best-effort broadcast throw or resolve.
  function buildCloseDb({
    interaction = quizInteraction,
    room = { prof_id: 'user-1', section_id: sectionId },
    responses = [{ student_id: 's1', response: { answers: { q1: 'c2' } } }],
    enrolled = [{ student_id: 's1' }, { student_id: 's2' }],
    profiles = [{ id: 's2', name: 'Bob Student', email: 'bob@example.edu' }],
    updateError = null,
    rpcImpl = vi.fn().mockResolvedValue({ data: null, error: null }),
  }: {
    interaction?: unknown
    room?: unknown
    responses?: Array<{ student_id?: string; response: { answers: Record<string, string> } }>
    enrolled?: Array<{ student_id: string }>
    profiles?: Array<{ id: string; name: string; email: string }>
    updateError?: { message: string } | null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpcImpl?: any
  } = {}) {
    return {
      rpc: rpcImpl,
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'lc_interactions') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: interaction,
                  error: interaction ? null : { message: 'Not found' },
                }),
              }),
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: updateError }),
            }),
          }
        }
        if (table === 'lc_rooms') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: room, error: null }),
              }),
            }),
          }
        }
        if (table === 'lc_responses') {
          // Used by both the report (.select('response').eq) and the
          // non-responder lookup (.select('student_id').eq).
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: responses, error: null }),
            }),
          }
        }
        if (table === 'enrollments') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: enrolled, error: null }),
              }),
            }),
          }
        }
        if (table === 'profiles') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: profiles, error: null }),
            }),
          }
        }
        throw new Error(`buildCloseDb: unexpected table ${table}`)
      }),
    }
  }

  it('returns error when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })

    const result = await closeQuizWithReport(validInteractionId)
    expect(result.error).toBe('Not authenticated')
  })

  it('returns error for invalid interaction ID', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const result = await closeQuizWithReport('not-a-uuid')
    expect(result.error).toBe('Invalid interaction ID')
  })

  it('returns error when interaction not found', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue(buildCloseDb({ interaction: null }))

    const result = await closeQuizWithReport(validInteractionId)
    expect(result.error).toBe('Interaction not found')
  })

  it('returns error when interaction is not a quiz', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue(
      buildCloseDb({ interaction: { ...quizInteraction, kind: 'poll' } }),
    )

    const result = await closeQuizWithReport(validInteractionId)
    expect(result.error).toBe('Not a quiz interaction')
  })

  it('returns error when quiz is not open', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue(
      buildCloseDb({ interaction: { ...quizInteraction, status: 'closed' } }),
    )

    const result = await closeQuizWithReport(validInteractionId)
    expect(result.error).toBe('Quiz is not open')
  })

  it('returns Forbidden when caller does not own the room', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue(
      buildCloseDb({ room: { prof_id: 'someone-else', section_id: sectionId } }),
    )

    const result = await closeQuizWithReport(validInteractionId)
    expect(result.error).toBe('Forbidden')
  })

  it('returns error when the close update fails', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue(
      buildCloseDb({ updateError: { message: 'DB error' } }),
    )

    const result = await closeQuizWithReport(validInteractionId)
    expect(result.error).toBe('Failed to close quiz')
  })

  it('closes the quiz and returns a report with computed accuracy on the happy path', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    // Two students: one correct (c2), one wrong (c1) → 50% accuracy.
    mockAdminClient.mockReturnValue(
      buildCloseDb({
        responses: [
          { response: { answers: { q1: 'c2' } } },
          { response: { answers: { q1: 'c1' } } },
        ],
      }),
    )

    const result = await closeQuizWithReport(validInteractionId)

    expect(result.error).toBeUndefined()
    expect(result.report).toBeDefined()
    expect(result.report.totalStudents).toBe(2)
    expect(result.report.overallAccuracy).toBe(50)
    expect(result.report.concepts).toEqual([
      { concept: 'Arithmetic', correctCount: 1, totalCount: 2, correctRate: 50 },
    ])
    expect(result.report.questions[0]).toMatchObject({
      id: 'q1',
      correctAnswer: '4',
      correctRate: 50,
    })
    // Closing a live quiz folds it into topic mastery immediately (via `after`)
    // instead of waiting for an unrelated grade / sweep.
    expect(mockEnqueue).toHaveBeenCalledWith(sectionId)
  })

  it('#87 — report lists enrolled students who did not answer', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    // s1 answered; s1 + s2 enrolled → s2 didn't answer.
    mockAdminClient.mockReturnValue(
      buildCloseDb({
        responses: [{ student_id: 's1', response: { answers: { q1: 'c2' } } }],
        enrolled: [{ student_id: 's1' }, { student_id: 's2' }],
        profiles: [{ id: 's2', name: 'Bob Student', email: 'bob@example.edu' }],
      }),
    )

    const result = await closeQuizWithReport(validInteractionId)

    expect(result.error).toBeUndefined()
    expect(result.report.nonResponders).toEqual([{ id: 's2', name: 'Bob Student' }])
  })

  it('#87 — report still returns (with empty non-responders) when the lookup fails', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    // enrollments query throws → fetchNonResponders rejects → close must still
    // succeed with nonResponders defaulted to [].
    const db = buildCloseDb()
    const realFrom = db.from.getMockImplementation()!
    db.from.mockImplementation((table: string) => {
      if (table === 'enrollments') throw new Error('enrollments boom')
      return realFrom(table)
    })
    mockAdminClient.mockReturnValue(db)

    const result = await closeQuizWithReport(validInteractionId)

    expect(result.error).toBeUndefined()
    expect(result.report).toBeDefined()
    expect(result.report.nonResponders).toEqual([])
  })

  // Regression guard: the final aggregate broadcast is best-effort. Previously
  // `.rpc(...).catch()` was called on a non-Promise (PostgrestBuilder), which
  // threw synchronously and failed the whole close. The fix wraps it in
  // try/catch — so a throwing rpc must NOT prevent the report from returning.
  it('still returns the report when the final aggregate broadcast throws', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const throwingRpc = vi.fn().mockImplementation(() => {
      throw new Error('rpc is not a promise')
    })
    mockAdminClient.mockReturnValue(buildCloseDb({ rpcImpl: throwingRpc }))

    const result = await closeQuizWithReport(validInteractionId)

    expect(throwingRpc).toHaveBeenCalled()
    expect(result.error).toBeUndefined()
    expect(result.report).toBeDefined()
    expect(result.report.totalStudents).toBe(1)
  })

  // Companion guard: a rejected (async-throwing) rpc must also be swallowed.
  it('still returns the report when the final aggregate broadcast rejects', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    const rejectingRpc = vi.fn().mockRejectedValue(new Error('broadcast offline'))
    mockAdminClient.mockReturnValue(buildCloseDb({ rpcImpl: rejectingRpc }))

    const result = await closeQuizWithReport(validInteractionId)

    expect(result.error).toBeUndefined()
    expect(result.report).toBeDefined()
  })

  it('reports zero accuracy when there are no responses', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })

    mockAdminClient.mockReturnValue(buildCloseDb({ responses: [] }))

    const result = await closeQuizWithReport(validInteractionId)

    expect(result.error).toBeUndefined()
    expect(result.report.totalStudents).toBe(0)
    expect(result.report.overallAccuracy).toBe(0)
    expect(result.report.questions[0].correctRate).toBe(0)
  })
})

// ── getInteractionNonResponders (#87) ──────────────────────

describe('getInteractionNonResponders', () => {
  const validInteractionId = '11111111-1111-4111-8111-111111111111'
  const roomId = '22222222-2222-4222-8222-222222222222'
  const sectionId = '33333333-3333-4333-8333-333333333333'

  // Mock dispatching by table name. The action issues: lc_interactions
  // (select→eq→single, for room_id), lc_rooms (verifyRoomOwnership select→eq→
  // single), then enrollments / lc_responses / profiles (fetchNonResponders).
  function buildDb({
    interaction = { id: validInteractionId, room_id: roomId },
    room = { prof_id: 'user-1', section_id: sectionId },
    enrolled = [{ student_id: 's1' }, { student_id: 's2' }],
    responses = [{ student_id: 's1' }],
    profiles = [{ id: 's2', name: 'Bob Student', email: 'bob@example.edu' }],
  }: {
    interaction?: unknown
    room?: unknown
    enrolled?: Array<{ student_id: string }>
    responses?: Array<{ student_id: string }>
    profiles?: Array<{ id: string; name?: string; email?: string }>
  } = {}) {
    return {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'lc_interactions') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: interaction,
                  error: interaction ? null : { message: 'Not found' },
                }),
              }),
            }),
          }
        }
        if (table === 'lc_rooms') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: room, error: null }),
              }),
            }),
          }
        }
        if (table === 'enrollments') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: enrolled, error: null }),
              }),
            }),
          }
        }
        if (table === 'lc_responses') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: responses, error: null }),
            }),
          }
        }
        if (table === 'profiles') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: profiles, error: null }),
            }),
          }
        }
        throw new Error(`buildDb: unexpected table ${table}`)
      }),
    }
  }

  it('returns error when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const result = await getInteractionNonResponders(validInteractionId)
    expect(result.error).toBe('Not authenticated')
  })

  it('returns error for an invalid interaction ID', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    const result = await getInteractionNonResponders('not-a-uuid')
    expect(result.error).toBe('Invalid interaction ID')
  })

  it('returns Interaction not found before any ownership check', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(buildDb({ interaction: null }))
    const result = await getInteractionNonResponders(validInteractionId)
    expect(result.error).toBe('Interaction not found')
  })

  it('returns Forbidden when the caller does not own the room (IDOR guard)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(
      buildDb({ room: { prof_id: 'someone-else', section_id: sectionId } }),
    )
    const result = await getInteractionNonResponders(validInteractionId)
    expect(result.error).toBe('Forbidden')
  })

  it('lists non-responders sorted, falling back to email when name is missing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    // s1 answered; s2 + s3 did not. s3 has no name → email fallback.
    mockAdminClient.mockReturnValue(
      buildDb({
        enrolled: [{ student_id: 's1' }, { student_id: 's2' }, { student_id: 's3' }],
        responses: [{ student_id: 's1' }],
        profiles: [
          { id: 's2', name: 'Zoe Last' },
          { id: 's3', email: 'amy@example.edu' },
        ],
      }),
    )
    const result = await getInteractionNonResponders(validInteractionId)
    expect(result.error).toBeUndefined()
    // Alphabetical: 'amy@example.edu' < 'Zoe Last'.
    expect(result.nonResponders).toEqual([
      { id: 's3', name: 'amy@example.edu' },
      { id: 's2', name: 'Zoe Last' },
    ])
  })

  it('returns an empty list when everyone answered', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(
      buildDb({ enrolled: [{ student_id: 's1' }], responses: [{ student_id: 's1' }] }),
    )
    const result = await getInteractionNonResponders(validInteractionId)
    expect(result.error).toBeUndefined()
    expect(result.nonResponders).toEqual([])
  })

  it('returns an empty list when the section has no enrolled students', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    mockAdminClient.mockReturnValue(buildDb({ enrolled: [] }))
    const result = await getInteractionNonResponders(validInteractionId)
    expect(result.error).toBeUndefined()
    expect(result.nonResponders).toEqual([])
  })
})

// ── applyModuleItemAsDeckSchema (Zod) ──────────────────────

describe('applyModuleItemAsDeckSchema', () => {
  let schema: typeof import('@/lib/validations/live-classroom').applyModuleItemAsDeckSchema

  beforeEach(async () => {
    const mod = await import('@/lib/validations/live-classroom')
    schema = mod.applyModuleItemAsDeckSchema
  })

  it('accepts valid UUIDs for both fields', () => {
    const result = schema.safeParse({
      roomId: '11111111-1111-4111-8111-111111111111',
      moduleItemId: '22222222-2222-4222-8222-222222222222',
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-UUID roomId', () => {
    const result = schema.safeParse({
      roomId: 'not-a-uuid',
      moduleItemId: '22222222-2222-4222-8222-222222222222',
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-UUID moduleItemId', () => {
    const result = schema.safeParse({
      roomId: '11111111-1111-4111-8111-111111111111',
      moduleItemId: 'abc123',
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing fields', () => {
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ roomId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false)
    expect(schema.safeParse({ moduleItemId: '22222222-2222-4222-8222-222222222222' }).success).toBe(false)
  })
})
