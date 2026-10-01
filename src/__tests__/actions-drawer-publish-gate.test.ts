// getNodeAssignmentContent's publish gate.
//
// The action is shared by the professor and student roadmaps, and staff may
// legitimately read unreleased work — so the gate lives in the branch, not at
// the door. Its quiz twin (getNodeQuizQuestions) has always refused a student a
// non-published quiz's question text; this one shipped without the equivalent
// check and handed out the description, guidelines and grading RUBRIC of
// assignments the professor had not released.
//
// Worth pinning because the asymmetry is invisible at the call site: both
// actions are bound identically on both pages, so nothing about the wiring
// hints that one is gated and the other is not.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockGetAssignmentContent = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...a: unknown[]) => mockVerifySectionAccess(...a),
}))
vi.mock('@/lib/supabase/queries', () => ({
  roadmapQueries: {
    getAssignmentContent: (...a: unknown[]) => mockGetAssignmentContent(...a),
    getSessionContent: vi.fn(),
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let getNodeAssignmentContent: any
/* eslint-enable @typescript-eslint/no-explicit-any */

const SECTION = 'sec-1'
const ASSIGNMENT = 'asg-1'
const BRIEF = { description: 'Do the thing', guidelines: 'Cite sources', criteria: ['Correctness'] }

/**
 * An admin client that RESPECTS the filters it is given.
 *
 * A chain of `vi.fn().mockReturnValue(chain)` would make `.eq()` a no-op, and
 * then the section-scoping case below would pass even with
 * `.eq('section_id', …)` deleted from the action — which is the IDOR half of
 * this gate. So the row is only returned when the query actually asked for
 * THIS assignment in THIS section.
 */
function adminClient({ status, enrolled }: { status: string | null; enrolled: boolean }) {
  const filters: Array<[string, string, unknown]> = []
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn().mockReturnValue(chain)
    chain.eq = vi.fn((col: string, val: unknown) => { filters.push([table, col, val]); return chain })
    chain.in = vi.fn((col: string, val: unknown) => { filters.push([table, col, val]); return chain })
    chain.maybeSingle = vi.fn(async () => {
      const asked = (col: string, val: unknown) => filters.some(([t, c, v]) => t === table && c === col && v === val)
      if (table === 'assignments') {
        if (status === null) return { data: null }
        // Unscoped or mis-scoped read → the row is not found, exactly as
        // Postgres would answer for another section's id.
        if (!asked('id', ASSIGNMENT) || !asked('section_id', SECTION)) return { data: null }
        return { data: { status } }
      }
      return { data: enrolled ? { id: 'e1' } : null }
    })
    return chain
  })
  return { from, filters }
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockVerifySectionAccess.mockReset()
  mockGetAssignmentContent.mockReset()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
  mockGetAssignmentContent.mockResolvedValue(BRIEF)
  ;({ getNodeAssignmentContent } = await import('@/lib/roadmap/drawer-actions'))
})

describe('getNodeAssignmentContent — publish gate', () => {
  it('refuses a student a DRAFT assignment, without reading its content', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: false, adminDb: adminClient({ status: 'draft', enrolled: true }) })

    const res = await getNodeAssignmentContent(SECTION, ASSIGNMENT)

    expect(res.data).toBeUndefined()
    expect(res.error).toBeTruthy()
    // The rubric must never be fetched, let alone returned.
    expect(mockGetAssignmentContent).not.toHaveBeenCalled()
  })

  it('gives a student a PUBLISHED assignment', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: false, adminDb: adminClient({ status: 'published', enrolled: true }) })

    const res = await getNodeAssignmentContent(SECTION, ASSIGNMENT)

    expect(res.data).toEqual(BRIEF)
  })

  it('gives STAFF a draft — they are the ones writing it', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, adminDb: adminClient({ status: 'draft', enrolled: false }) })

    const res = await getNodeAssignmentContent(SECTION, ASSIGNMENT)

    expect(res.data).toEqual(BRIEF)
  })

  it('still refuses someone with no access to the section at all', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: false, adminDb: adminClient({ status: 'published', enrolled: false }) })

    const res = await getNodeAssignmentContent(SECTION, ASSIGNMENT)

    expect(res.data).toBeUndefined()
    expect(mockGetAssignmentContent).not.toHaveBeenCalled()
  })

  it('gives a student a CLOSED (past-due) assignment — closed is not withheld', async () => {
    // The assignments table's own student policy allows published AND closed.
    // Gating on 'published' alone hid every past-due brief in the modal while
    // the same student could still open it from the assignments page.
    mockVerifySectionAccess.mockResolvedValue({ ok: false, adminDb: adminClient({ status: 'closed', enrolled: true }) })

    expect((await getNodeAssignmentContent(SECTION, ASSIGNMENT)).data).toEqual(BRIEF)
  })

  it.each(['scheduled', 'archived'])('still refuses a student a %s assignment', async (status) => {
    mockVerifySectionAccess.mockResolvedValue({ ok: false, adminDb: adminClient({ status, enrolled: true }) })

    const res = await getNodeAssignmentContent(SECTION, ASSIGNMENT)

    expect(res.data).toBeUndefined()
    expect(mockGetAssignmentContent).not.toHaveBeenCalled()
  })

  it('scopes the status read to this section, so another section\'s id cannot be probed', async () => {
    const db = adminClient({ status: 'published', enrolled: true })
    mockVerifySectionAccess.mockResolvedValue({ ok: false, adminDb: db })

    const res = await getNodeAssignmentContent(SECTION, ASSIGNMENT)

    // The mock only yields the row when BOTH filters were applied, so a gate
    // that forgot section_id would fail here rather than silently pass.
    expect(res.data).toEqual(BRIEF)
    expect(db.filters).toContainEqual(['assignments', 'section_id', SECTION])
  })
})
