// Tests for the unified Live Classroom interactions server actions.

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let actions: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  actions = await import('@/lib/live-classroom/interactions/actions')
})

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const SECTION_ID = '7f8d8c0e-1234-4abc-8def-0123456789ab'
const PROF_ID = '12345678-1234-4abc-89ef-0123456789ab'
const STUDENT_ID = '87654321-4321-4cba-9def-0123456789ab'
const INTERACTION_ID = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa'

interface FakeDbState {
  room?: { id: string; section_id: string; prof_id: string; status: string } | null
  interaction?: { id: string; room_id: string; kind: 'poll' | 'quiz' | 'question'; payload: Record<string, unknown>; status: 'draft' | 'open' | 'closed'; created_by: string } | null
  enrolled?: boolean
  insertResult?: { id: string }
  insertError?: { message: string } | null
  updateError?: { message: string } | null
  upsertError?: { message: string } | null
  // deleteInteraction: rows-affected count drives the concurrency branch.
  deleteError?: { message: string } | null
  deleteCount?: number
  // listPreparedInteractions: draft rows the room's select returns.
  draftInteractions?: Array<{ id: string; kind: 'poll' | 'quiz'; payload: Record<string, unknown>; created_at: string }>
  listError?: { message: string } | null
  // listReusableInteractions: the section's rooms, and the launched rows.
  sectionRooms?: Array<{ id: string }>
  launchedInteractions?: Array<{ id: string; kind: 'poll' | 'quiz'; payload: Record<string, unknown>; created_at: string }>
}

function buildAdminDb(state: FakeDbState) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = []
  const updated: Array<{ table: string; patch: Record<string, unknown> }> = []
  const upserted: Array<{ table: string; row: Record<string, unknown> }> = []

  const adminDb = {
    inserted,
    updated,
    upserted,
    from(table: string) {
      if (table === 'lc_rooms') {
        // Two callers: loadRoom (.eq().single()) and listReusableInteractions
        // (.eq().eq(), awaited for the section's rooms).
        const roomChain: Record<string, unknown> = {}
        roomChain.eq = () => roomChain
        roomChain.single = async () => ({
          data: state.room ?? null,
          error: state.room ? null : { message: 'no rows' },
        })
        roomChain.then = (resolve: (v: unknown) => unknown) =>
          resolve({ data: state.sectionRooms ?? [], error: null })
        return { select: () => roomChain }
      }
      if (table === 'lc_interactions') {
        // select() serves two callers: loadInteraction (.eq().single()) and
        // listPreparedInteractions (.eq().eq().in().order(), awaited). One
        // chainable object carries both — .single() resolves the single row,
        // awaiting the chain resolves the draft list.
        const listResult = {
          data: state.launchedInteractions ?? state.draftInteractions ?? [],
          error: state.listError ?? null,
        }
        const selectChain: Record<string, unknown> = {}
        selectChain.eq = () => selectChain
        selectChain.in = () => selectChain
        selectChain.order = () => selectChain
        selectChain.limit = () => selectChain
        selectChain.single = async () => ({
          data: state.interaction ?? null,
          error: state.interaction ? null : { message: 'no rows' },
        })
        selectChain.then = (resolve: (v: unknown) => unknown) => resolve(listResult)
        return {
          select: () => selectChain,
          // .delete({ count }).eq().eq() — awaited, returns { error, count }.
          delete: () => {
            const deleteChain: Record<string, unknown> = {}
            deleteChain.eq = () => deleteChain
            deleteChain.then = (resolve: (v: unknown) => unknown) =>
              resolve({ error: state.deleteError ?? null, count: state.deleteCount ?? 0 })
            return deleteChain
          },
          insert: (row: Record<string, unknown>) => {
            inserted.push({ table, row })
            return {
              select: () => ({
                single: async () => ({
                  data: state.insertError ? null : (state.insertResult ?? { id: INTERACTION_ID }),
                  error: state.insertError ?? null,
                }),
              }),
            }
          },
          update: (patch: Record<string, unknown>) => {
            updated.push({ table, patch })
            return {
              eq: async () => ({ error: state.updateError ?? null }),
            }
          },
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
      if (table === 'lc_responses') {
        return {
          upsert: (row: Record<string, unknown>) => {
            upserted.push({ table, row })
            return Promise.resolve({ error: state.upsertError ?? null })
          },
        }
      }
      if (table === 'profiles') {
        // askQuestion looks up the asker's display name to embed in the
        // payload (skipped for anonymous). Tests don't care about the
        // value; just hand back a plausible profile.
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { name: 'Test User', email: 'test@example.com' },
                error: null,
              }),
            }),
          }),
        }
      }
      throw new Error(`Unexpected table ${table}`)
    },
    rpc: async () => ({ error: null }),
  }

  return adminDb
}

// ── createInteraction ────────────────────────────────────────────────

describe('createInteraction', () => {
  it('rejects unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const result = await actions.createInteraction({
      roomId: ROOM_ID,
      kind: 'poll',
      payload: { question: 'q', choices: [{ id: '1', text: 'a' }, { id: '2', text: 'b' }] },
    })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-prof callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
    }))
    const result = await actions.createInteraction({
      roomId: ROOM_ID,
      kind: 'poll',
      payload: { question: 'q', choices: [{ id: '1', text: 'a' }, { id: '2', text: 'b' }] },
    })
    expect(result.error).toBe('Only the room professor can create interactions')
  })

  it('creates a poll for the prof', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
    }))
    const result = await actions.createInteraction({
      roomId: ROOM_ID,
      kind: 'poll',
      payload: { question: 'q', choices: [{ id: '1', text: 'a' }, { id: '2', text: 'b' }] },
    })
    expect(result.interactionId).toBe(INTERACTION_ID)
  })

  it('rejects when room has ended', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'ended' },
    }))
    const result = await actions.createInteraction({
      roomId: ROOM_ID,
      kind: 'poll',
      payload: { question: 'q', choices: [{ id: '1', text: 'a' }, { id: '2', text: 'b' }] },
    })
    expect(result.error).toBe('Room has ended')
  })
})

// ── openInteraction / closeInteraction ───────────────────────────────

describe('openInteraction', () => {
  it('rejects when interaction is already open', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'open', created_by: PROF_ID },
    }))
    const result = await actions.openInteraction({ interactionId: INTERACTION_ID })
    expect(result.error).toBe('Interaction is already open')
  })

  it('opens a draft interaction', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'draft', created_by: PROF_ID },
    }))
    const result = await actions.openInteraction({ interactionId: INTERACTION_ID })
    expect(result.success).toBe(true)
  })
})

describe('closeInteraction', () => {
  it('rejects when interaction is not open', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'closed', created_by: PROF_ID },
    }))
    const result = await actions.closeInteraction({ interactionId: INTERACTION_ID })
    expect(result.error).toBe('Interaction is not open')
  })

  it('closes an open interaction', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'open', created_by: PROF_ID },
    }))
    const result = await actions.closeInteraction({ interactionId: INTERACTION_ID })
    expect(result.success).toBe(true)
  })
})

// ── submitResponse ───────────────────────────────────────────────────

describe('submitResponse', () => {
  it('rejects when not enrolled', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'open', created_by: PROF_ID },
      enrolled: false,
    }))
    const result = await actions.submitResponse({
      interactionId: INTERACTION_ID,
      response: { choiceIds: ['1'] },
    })
    expect(result.error).toBe('You are not enrolled in this section')
  })

  it('rejects when interaction is closed', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'closed', created_by: PROF_ID },
      enrolled: true,
    }))
    const result = await actions.submitResponse({
      interactionId: INTERACTION_ID,
      response: { choiceIds: ['1'] },
    })
    expect(result.error).toBe('Interaction is not open')
  })

  it('upserts the response when valid', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    const adminDb = buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'open', created_by: PROF_ID },
      enrolled: true,
    })
    mockAdminClient.mockReturnValue(adminDb)
    const result = await actions.submitResponse({
      interactionId: INTERACTION_ID,
      response: { choiceIds: ['1'] },
    })
    expect(result.success).toBe(true)
    expect(adminDb.upserted).toHaveLength(1)
    expect(adminDb.upserted[0].row.student_id).toBe(STUDENT_ID)
  })
})

// ── askQuestion + upvote + markAnswered ──────────────────────────────

describe('askQuestion', () => {
  it('inserts a question for an enrolled student', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      enrolled: true,
    }))
    const result = await actions.askQuestion({
      roomId: ROOM_ID,
      text: 'Can you repeat slide 4?',
      anonymous: false,
    })
    expect(result.interactionId).toBe(INTERACTION_ID)
  })

  it('rejects students who are not enrolled', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      enrolled: false,
    }))
    const result = await actions.askQuestion({
      roomId: ROOM_ID,
      text: 'A question',
      anonymous: false,
    })
    expect(result.error).toBe('You are not enrolled in this section')
  })
})

describe('upvoteQuestion', () => {
  it('is idempotent for the same upvoter', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: {
        id: INTERACTION_ID, room_id: ROOM_ID, kind: 'question',
        payload: { upvotes: 1, upvotedBy: [STUDENT_ID] }, status: 'open', created_by: STUDENT_ID,
      },
      enrolled: true,
    }))
    const result = await actions.upvoteQuestion({ interactionId: INTERACTION_ID })
    expect(result.success).toBe(true)
  })

  it('rejects upvotes on non-question interactions', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'open', created_by: PROF_ID },
      enrolled: true,
    }))
    const result = await actions.upvoteQuestion({ interactionId: INTERACTION_ID })
    expect(result.error).toBe('Only questions can be upvoted')
  })
})

describe('markQuestionAnswered', () => {
  it('rejects non-prof callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'question', payload: {}, status: 'open', created_by: STUDENT_ID },
    }))
    const result = await actions.markQuestionAnswered({ interactionId: INTERACTION_ID })
    expect(result.error).toBe('Forbidden')
  })

  it('marks a question answered for the prof', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'question', payload: {}, status: 'open', created_by: STUDENT_ID },
    }))
    const result = await actions.markQuestionAnswered({ interactionId: INTERACTION_ID })
    expect(result.success).toBe(true)
  })
})

// ── deleteInteraction (prof, draft-only) ─────────────────────────────

describe('deleteInteraction', () => {
  it('rejects unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const result = await actions.deleteInteraction({ interactionId: INTERACTION_ID })
    expect(result.error).toBe('Not authenticated')
  })

  it('returns not found when the interaction is missing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: null,
    }))
    const result = await actions.deleteInteraction({ interactionId: INTERACTION_ID })
    expect(result.error).toBe('Interaction not found')
  })

  it('rejects a prof who does not own the room', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'draft', created_by: PROF_ID },
    }))
    const result = await actions.deleteInteraction({ interactionId: INTERACTION_ID })
    expect(result.error).toBe('Forbidden')
  })

  it('refuses to delete a launched (non-draft) interaction', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'open', created_by: PROF_ID },
    }))
    const result = await actions.deleteInteraction({ interactionId: INTERACTION_ID })
    expect(result.error).toBe('Only unlaunched interactions can be deleted')
  })

  it('deletes a draft interaction for the owning prof', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'draft', created_by: PROF_ID },
      deleteCount: 1,
    }))
    const result = await actions.deleteInteraction({ interactionId: INTERACTION_ID })
    expect(result.success).toBe(true)
  })

  it('bails out when a concurrent open launched it (0 rows deleted)', async () => {
    // Read saw a draft, but the status-guarded DELETE affected no rows —
    // someone opened it in the gap. Must not report success.
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { id: INTERACTION_ID, room_id: ROOM_ID, kind: 'poll', payload: {}, status: 'draft', created_by: PROF_ID },
      deleteCount: 0,
    }))
    const result = await actions.deleteInteraction({ interactionId: INTERACTION_ID })
    expect(result.error).toBe('This interaction is already live')
    expect(result.success).toBeUndefined()
  })
})

// ── listPreparedInteractions (prof, draft read) ──────────────────────

describe('listPreparedInteractions', () => {
  it('rejects unauthenticated callers', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const result = await actions.listPreparedInteractions({ roomId: ROOM_ID })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects a prof who does not own the room', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
    }))
    const result = await actions.listPreparedInteractions({ roomId: ROOM_ID })
    expect(result.error).toBe('Forbidden')
  })

  it('returns the draft interactions for the owning prof', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      draftInteractions: [
        { id: INTERACTION_ID, kind: 'poll', payload: { question: 'q' }, created_at: '2026-07-03T00:00:00Z' },
      ],
    }))
    const result = await actions.listPreparedInteractions({ roomId: ROOM_ID })
    expect(result.error).toBeUndefined()
    expect(result.interactions).toHaveLength(1)
    expect(result.interactions[0].kind).toBe('poll')
  })
})

// ── replyToQuestion (prof, #129) ─────────────────────────────────────

describe('replyToQuestion', () => {
  const question = {
    id: INTERACTION_ID,
    room_id: ROOM_ID,
    kind: 'question' as const,
    payload: { text: 'Why does this compile?', upvotes: 2, answered: false },
    status: 'open' as const,
    created_by: STUDENT_ID,
  }

  it('rejects a caller who is not the room professor', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: question,
    }))
    const result = await actions.replyToQuestion({ interactionId: INTERACTION_ID, text: 'because' })
    expect(result.error).toBe('Forbidden')
  })

  it('rejects an empty reply', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: question,
    }))
    const result = await actions.replyToQuestion({ interactionId: INTERACTION_ID, text: '   ' })
    expect(result.success).toBeUndefined()
    expect(result.error).toContain('Invalid input')
  })

  // The load-bearing detail: the reply reaches students ONLY through the
  // trigger's payload-changed branch. Touching `status` in the same UPDATE
  // would take the status branch instead, which carries no payload — the
  // reply text would never be broadcast.
  it('writes the reply and answers the question WITHOUT changing status', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    const db = buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: question,
    })
    mockAdminClient.mockReturnValue(db)

    const result = await actions.replyToQuestion({
      interactionId: INTERACTION_ID,
      text: 'Because the compiler widens the literal type.',
    })

    expect(result.success).toBe(true)
    expect(db.updated).toHaveLength(1)
    const patch = db.updated[0].patch as { payload: Record<string, unknown>; status?: string }
    expect(Object.keys(patch)).toEqual(['payload'])
    expect(patch.payload.reply).toBe('Because the compiler widens the literal type.')
    expect(patch.payload.answered).toBe(true)
    expect(patch.payload.answeredBy).toBe(PROF_ID)
    // Existing payload fields survive the merge.
    expect(patch.payload.upvotes).toBe(2)
  })

  it('refuses to reply to a poll or quiz', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      interaction: { ...question, kind: 'poll' },
    }))
    const result = await actions.replyToQuestion({ interactionId: INTERACTION_ID, text: 'hi' })
    expect(result.error).toBe('Not a question')
  })
})

// ── listReusableInteractions (prof, #133) ────────────────────────────

describe('listReusableInteractions', () => {
  it('rejects a prof who does not own the room', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
    }))
    const result = await actions.listReusableInteractions({ roomId: ROOM_ID })
    expect(result.error).toBe('Forbidden')
  })

  it('maps a past poll onto composer fields', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      sectionRooms: [{ id: ROOM_ID }],
      launchedInteractions: [
        {
          id: INTERACTION_ID,
          kind: 'poll',
          payload: {
            question: 'Confident about big-O?',
            choices: [{ id: 'c1', text: 'Yes' }, { id: 'c2', text: 'Not yet' }],
          },
          created_at: '2026-07-03T00:00:00Z',
        },
      ],
    }))
    const result = await actions.listReusableInteractions({ roomId: ROOM_ID })
    expect(result.error).toBeUndefined()
    expect(result.interactions).toHaveLength(1)
    expect(result.interactions[0]).toMatchObject({
      kind: 'poll',
      question: 'Confident about big-O?',
      choices: ['Yes', 'Not yet'],
      correctIndex: null,
    })
  })

  it('keeps the correct-answer index and drops multi-question quizzes', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    const oneQuestion = {
      id: 'q1',
      prompt: 'Which traversal is depth-first?',
      choices: [{ id: 'a', text: 'BFS' }, { id: 'b', text: 'DFS' }],
      correctChoiceId: 'b',
      explanation: 'DFS goes deep first.',
    }
    mockAdminClient.mockReturnValue(buildAdminDb({
      room: { id: ROOM_ID, section_id: SECTION_ID, prof_id: PROF_ID, status: 'live' },
      sectionRooms: [{ id: ROOM_ID }],
      launchedInteractions: [
        {
          id: INTERACTION_ID,
          kind: 'quiz',
          payload: { title: 'Traversals', timeLimitSeconds: 120, revealAnswers: true, questions: [oneQuestion] },
          created_at: '2026-07-03T00:00:00Z',
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
          kind: 'quiz',
          // The composer authors one question, so a 2-question quiz can't be
          // prefilled without silently dropping the rest — it is left out.
          payload: { title: 'AI quiz', questions: [oneQuestion, { ...oneQuestion, id: 'q2' }] },
          created_at: '2026-07-02T00:00:00Z',
        },
      ],
    }))
    const result = await actions.listReusableInteractions({ roomId: ROOM_ID })
    expect(result.interactions).toHaveLength(1)
    expect(result.interactions[0]).toMatchObject({
      kind: 'quiz',
      question: 'Which traversal is depth-first?',
      correctIndex: 1,
      timeLimitSeconds: 120,
      revealAnswers: true,
    })
  })
})
