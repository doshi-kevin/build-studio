// Auth / tenant-isolation + settings-merge tests for the document-assignment actions.
// The cross-section case is the IDOR guard (a valid professor passing another section's id);
// the merge case guards against an autosave clobbering sibling settings keys — now done atomically
// via the merge_assignment_settings RPC (the writer sends only its own key; sibling-key
// preservation is the SQL `settings || p_patch` merge's job, covered at the DB layer).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockAdminClient, createTableRouter, buildFullChain } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...args: unknown[]) => mockVerifySectionAccess(...args),
  canWriteAsStaff: (role: string) => role === 'professor' || role === 'ta',
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

const VALID_DOC = { version: 1, doc: { type: 'doc', content: [{ type: 'paragraph' }] } }

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockVerifySectionAccess.mockReset()
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
})

describe('saveAssignmentDocument', () => {
  it('rejects an unauthenticated caller before any authorization', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const res = await mod.saveAssignmentDocument('sec-1', 'asg-1', VALID_DOC)
    expect(res).toEqual({ error: expect.stringContaining('sign in') })
    expect(mockVerifySectionAccess).not.toHaveBeenCalled()
  })

  it('rejects a non-staff caller', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'student', adminDb: createMockAdminClient({}) })
    const res = await mod.saveAssignmentDocument('sec-1', 'asg-1', VALID_DOC)
    expect(res).toEqual({ error: expect.stringContaining('permission') })
  })

  it('rejects a cross-section assignment id (IDOR) and never writes', async () => {
    // Assignment belongs to sec-2, but the caller is acting on sec-1.
    const admin = createMockAdminClient({
      assignments: { data: { id: 'asg-1', section_id: 'sec-2', settings: {} }, error: null },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: admin })
    const res = await mod.saveAssignmentDocument('sec-1', 'asg-1', VALID_DOC)
    expect(res).toEqual({ error: 'Assignment not found.' })
    // Only the ownership lookup touched the table — no update.
    expect(admin._tableCalls.filter((t) => t === 'assignments')).toHaveLength(1)
  })

  it('rejects a malformed document', async () => {
    const admin = createMockAdminClient({
      assignments: { data: { id: 'asg-1', section_id: 'sec-1', settings: {} }, error: null },
    })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: admin })
    const res = await mod.saveAssignmentDocument('sec-1', 'asg-1', { version: 1, doc: { type: 'paragraph' } })
    expect(res).toEqual({ error: expect.stringContaining('could not be saved') })
  })

  it('patches only settings.document via the merge RPC (siblings preserved by the atomic merge)', async () => {
    const assignments = buildFullChain({ data: { id: 'asg-1', section_id: 'sec-1' }, error: null })
    const adminDb = createTableRouter({ assignments })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.saveAssignmentDocument('sec-1', 'asg-1', VALID_DOC)
    expect(res).toEqual({ success: true })

    expect(adminDb.rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = adminDb.rpc.mock.calls[0]
    expect(fn).toBe('merge_assignment_settings')
    // Only this writer's key is patched — kind/accepts survive via the SQL merge, not a client spread.
    expect(Object.keys(args.p_patch)).toEqual(['document'])
    expect(args.p_patch.document).toEqual(VALID_DOC)
  })
})

describe('createDocumentAssignment', () => {
  it('inserts a draft document with the tenant institution_id and document settings', async () => {
    const course_sections = buildFullChain({ data: { institution_id: 'inst-1' }, error: null })
    const assignments = buildFullChain({ data: { id: 'asg-new' }, error: null })
    mockVerifySectionAccess.mockResolvedValue({
      ok: true, role: 'professor', adminDb: createTableRouter({ course_sections, assignments }),
    })

    const res = await mod.createDocumentAssignment('sec-1', 'My Doc')
    expect(res).toEqual({ success: true, assignmentId: 'asg-new' })

    const row = assignments.insert.mock.calls[0][0]
    expect(row.institution_id).toBe('inst-1') // multi-tenant field from verified context
    expect(row.section_id).toBe('sec-1')
    expect(row.title).toBe('My Doc')
    expect(row.status).toBe('draft')
    expect(row.settings.kind).toBe('document')
    expect(row.settings.document).toBeTruthy()
  })

  it('rejects a non-staff caller', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'student', adminDb: createMockAdminClient({}) })
    const res = await mod.createDocumentAssignment('sec-1', 'X')
    expect(res).toEqual({ error: expect.stringContaining('permission') })
  })
})
