// Tests for the professor AI assistant approve actions — specifically the
// approveProjectDraft draft→createProject translation. This mapping is
// load-bearing and silently breakable: the draft is typed `unknown`, so a
// camelCase→snake_case slip (maxTeamSize→max_team_size, dueDate→due_date) or a
// botched empty-string→null coercion would NOT be caught by typecheck, only by
// createProject's runtime re-parse. We assert the exact forwarded payload and
// the auth short-circuit.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-Level Mocks ───────────────────────────────────────
const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockCreateProject = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...a: unknown[]) => mockVerifySectionAccess(...a),
  canWriteAsStaff: (role: string) => role === 'professor' || role === 'ta',
}))
vi.mock('@/app/(dashboard)/professor/courses/[sectionId]/projects/actions', () => ({
  createProject: (...a: unknown[]) => mockCreateProject(...a),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))

const SECTION = 'sec-1'

/**
 * A query stub that records the filters the console's chat list applies. Three
 * Athena surfaces now share athena_conversations (professor console, student
 * dock, and — as of the Studio resume work — the assignment/quiz/grading panel),
 * so which rows this sidebar claims is no longer implied by the table it reads.
 */
function listStub(rows: Array<Record<string, unknown>>) {
  const filters: Record<string, unknown> = {}
  const captured: { limit?: number } = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filters[col] = val
      return chain
    },
    order: () => chain,
    limit: (n: number) => {
      captured.limit = n
      return chain
    },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  }
  return { filters, captured, from: () => chain }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let approveProjectDraft: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listConversations: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockVerifySectionAccess.mockReset()
  mockCreateProject.mockReset()

  mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } } })
  mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: {} })
  mockCreateProject.mockResolvedValue({ success: true, data: { id: 'proj-1' } })

  const mod = await import('@/components/professor/assistant/actions')
  approveProjectDraft = mod.approveProjectDraft
  listConversations = mod.listConversations
})

describe('approveProjectDraft → createProject mapping', () => {
  it('maps camelCase draft fields to the snake_case createProject input', async () => {
    const res = await approveProjectDraft(SECTION, {
      title: 'Recommender System',
      description: 'Build a recommender.',
      guidelines: 'Deliverables and grading.',
      maxTeamSize: 4,
      dueDate: '2026-07-29',
    })

    expect(mockCreateProject).toHaveBeenCalledTimes(1)
    expect(mockCreateProject).toHaveBeenCalledWith(SECTION, {
      title: 'Recommender System',
      description: 'Build a recommender.',
      guidelines: 'Deliverables and grading.',
      status: 'active',
      visibility: 'course',
      max_team_size: 4,
      due_date: '2026-07-29',
      allow_team_workspace: true,
    })
    expect(res.success).toBe(true)
    expect(res.href).toContain(`/projects`)
  })

  it('passes the professor allowTeamWorkspace toggle through to createProject', async () => {
    await approveProjectDraft(
      SECTION,
      { title: 'No-chat project', maxTeamSize: 3 },
      false,
    )
    expect(mockCreateProject).toHaveBeenCalledWith(
      SECTION,
      expect.objectContaining({ allow_team_workspace: false }),
    )
  })

  it('defaults allow_team_workspace to true when the toggle arg is omitted', async () => {
    await approveProjectDraft(SECTION, { title: 'Default project' })
    expect(mockCreateProject).toHaveBeenCalledWith(
      SECTION,
      expect.objectContaining({ allow_team_workspace: true }),
    )
  })

  it('coerces an empty dueDate to null (never posts due_date: "")', async () => {
    await approveProjectDraft(SECTION, { title: 'X', dueDate: '' })
    const payload = mockCreateProject.mock.calls[0][1]
    expect(payload.due_date).toBeNull()
  })

  it('applies defaults for omitted optional fields', async () => {
    await approveProjectDraft(SECTION, { title: 'Only a title' })
    const payload = mockCreateProject.mock.calls[0][1]
    expect(payload.description).toBe('')
    expect(payload.guidelines).toBe('')
    expect(payload.max_team_size).toBe(5) // schema default
    expect(payload.due_date).toBeNull()
  })

  it('rejects unauthenticated callers without touching createProject', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await approveProjectDraft(SECTION, { title: 'X' })
    expect(res.error).toBeTruthy()
    expect(mockCreateProject).not.toHaveBeenCalled()
  })

  it('rejects an incomplete draft (no title) without touching createProject', async () => {
    const res = await approveProjectDraft(SECTION, { description: 'no title' })
    expect(res.error).toBeTruthy()
    expect(mockCreateProject).not.toHaveBeenCalled()
  })
})

describe('listConversations — the console sidebar reads only its own surface', () => {
  it('filters to surface=professor, so student and Studio threads never appear here', async () => {
    const db = listStub([{ id: 'c1', title: 'Rewrite week 3', updated_at: 't1' }])
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: db })

    const res = await listConversations(SECTION)

    expect(res.data).toEqual([{ id: 'c1', title: 'Rewrite week 3', updatedAt: 't1' }])
    // Without the surface filter, a professor who is also enrolled as a student
    // somewhere, or who has used the Studio panel on any assignment, finds those
    // unrelated threads listed in this rail — and opening one loads a transcript
    // the console has no context for.
    expect(db.filters).toMatchObject({
      section_id: SECTION,
      user_id: 'prof-1',
      surface: 'professor',
      is_archived: false,
    })
  })

  it('bounds the read rather than selecting every thread the section ever had', async () => {
    const db = listStub([])
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: db })

    await listConversations(SECTION)

    // The exact ceiling is a product call and may change; an UNBOUNDED read is
    // the regression, since the rail only ever renders the newest handful.
    expect(typeof db.captured.limit).toBe('number')
  })

  it('returns an error and reads nothing when the caller is not staff on the section', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: false })

    const res = await listConversations(SECTION)

    expect(res.error).toBeTruthy()
    expect(res.data).toEqual([])
  })
})
