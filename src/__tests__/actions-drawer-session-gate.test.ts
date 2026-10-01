// getNodeSessionContent's release gate — the live-session twin of
// actions-drawer-publish-gate.test.ts.
//
// The node modal lists a session's polls and pop quizzes. That read runs on the
// ADMIN client, so lc_interactions' own student SELECT policy (migration
// 20260727144045_lc_interactions_hide_unclosed_quiz_answers.sql: a quiz is
// readable only once CLOSED, because its payload carries the answer key) is not
// there to enforce anything — the gate has to be repeated in the query.
//
// Without it a student got the prompt of every pop quiz staged for their
// section, drafts for a class that had not happened yet included. Reachable
// mid-class once the roadmap's ?node= deep link existed: a live room's tile
// joins the classroom on click, so until then that card could not be opened.
//
// Both halves are pinned, because either alone is a silent no-op: the action
// must pass WHICH kind of caller it is, and the query must act on it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...a: unknown[]) => mockVerifySectionAccess(...a),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let getNodeSessionContent: any
/* The queries module the action under test actually holds. Taken fresh after
   resetModules — a top-level import would be a stale instance, so spying on it
   would patch an object nothing calls. */
let queries: any
/* eslint-enable @typescript-eslint/no-explicit-any */

const SECTION = 'sec-1'
const ROOM = 'room-1'

/** Minimal admin client for the authorize step — the caller is enrolled. */
const authDb = () => ({
  from: vi.fn(() => {
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn().mockReturnValue(chain)
    chain.eq = vi.fn().mockReturnValue(chain)
    chain.in = vi.fn().mockReturnValue(chain)
    chain.maybeSingle = vi.fn(async () => ({ data: { id: 'e1' } }))
    return chain
  }),
})

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockVerifySectionAccess.mockReset()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
  ;({ roadmapQueries: queries } = await import('@/lib/supabase/queries'))
  ;({ getNodeSessionContent } = await import('@/lib/roadmap/drawer-actions'))
})

/* Restore here, not at the end of each test: a failing assertion would skip an
   inline restore and leave the spy installed for the tests below, which then
   silently exercise the mock instead of the real query. */
afterEach(() => { vi.restoreAllMocks() })

describe('getNodeSessionContent — tells the query who is asking', () => {
  it.each([
    ['a student', false],
    ['staff', true],
  ])('passes isStaff for %s', async (_who, isStaff) => {
    mockVerifySectionAccess.mockResolvedValue({ ok: isStaff, adminDb: authDb() })
    const spy = vi.spyOn(queries, 'getSessionContent').mockResolvedValue({ children: [] })

    await getNodeSessionContent(SECTION, ROOM)

    expect(spy).toHaveBeenCalledWith(expect.anything(), SECTION, ROOM, { isStaff })
  })
})

/**
 * A supabase chain that records the filters asked of lc_interactions, so the
 * assertion is about the QUERY SENT rather than about rows a mock chose to
 * hand back.
 */
function interactionsDb() {
  const filters: string[] = []
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn().mockReturnValue(chain)
    chain.eq = vi.fn().mockReturnValue(chain)
    chain.in = vi.fn().mockReturnValue(chain)
    chain.or = vi.fn((expr: string) => { if (table === 'lc_interactions') filters.push(expr); return chain })
    chain.order = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn(async () => ({ data: [] }))
    chain.maybeSingle = vi.fn(async () => ({ data: table === 'lc_rooms' ? { id: ROOM } : null }))
    return chain
  })
  return { db: { from }, filters }
}

describe('roadmapQueries.getSessionContent — the quiz gate itself', () => {
  it('withholds a quiz from a student until it is CLOSED', async () => {
    const { db, filters } = interactionsDb()

    await queries.getSessionContent(db, SECTION, ROOM, { isStaff: false })

    // Same predicate as the table's student policy: any non-quiz, or a closed quiz.
    expect(filters).toEqual(['kind.neq.quiz,status.eq.closed'])
  })

  it('gives staff every staged poll and pop quiz — they wrote them', async () => {
    const { db, filters } = interactionsDb()

    await queries.getSessionContent(db, SECTION, ROOM, { isStaff: true })

    expect(filters).toEqual([])
  })
})
