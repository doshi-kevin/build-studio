// updateAssignmentMeta edits the assignment's due date + total points from the detail header.
// The rubric is the single source of the total, so when a rubric exists the header points field
// is read-only and the server must IGNORE any points the client sends — otherwise a stale or
// crafted client call would overwrite the rubric-derived total (the "points loophole"). These
// assert the branch: rubric present -> points dropped from the write; no rubric -> points written.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain } from './helpers/mock-supabase'

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
vi.mock('@/lib/events/content-change', () => ({ emitContentChange: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockVerifySectionAccess.mockReset()
  mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
})

const A_RUBRIC = { rubric: { questions: [{ label: 'Q1', points: 50, criteria: [{ description: 'c', points: 50 }] }] } }

/** adminDb whose assignments row carries `settings` + a draft status (no publish-notify branch). */
function accessWith(settings: Record<string, unknown>) {
  const chain = buildFullChain({
    data: { id: 'asg-1', section_id: 'sec-1', status: 'draft', title: 'HW1', due_at: null, settings },
    error: null,
  })
  const adminDb = { from: vi.fn(() => chain) }
  mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
  return chain
}

describe('updateAssignmentMeta — points loophole', () => {
  it('DROPS points from the write when a rubric exists (rubric defines the total)', async () => {
    const chain = accessWith(A_RUBRIC)
    // Client sends a bogus points value; the server must ignore it because a rubric owns the total.
    const res = await mod.updateAssignmentMeta('sec-1', 'asg-1', { dueAt: null, points: 999 })
    expect(res).toEqual({ success: true })
    expect(chain.update).toHaveBeenCalledTimes(1)
    const payload = chain.update.mock.calls[0][0] as Record<string, unknown>
    expect('points' in payload).toBe(false) // the loophole is closed
    expect(payload.due_at).toBe(null) // due date still written
  })

  it('WRITES points when there is no rubric (points still editable for a plain assignment)', async () => {
    const chain = accessWith({})
    const res = await mod.updateAssignmentMeta('sec-1', 'asg-1', { dueAt: null, points: 40 })
    expect(res).toEqual({ success: true })
    const payload = chain.update.mock.calls[0][0] as { points?: number }
    expect(payload.points).toBe(40)
  })
})

// updateAssignment is the SIBLING points writer (the plain-assignment edit dialog). It writes via
// the merge RPC and must apply the same rubric guard — a stale edit form must not clobber the
// rubric-derived total (which would then make the max-points guard reject full-rubric grades).
describe('updateAssignment — points loophole (the sibling writer)', () => {
  const runUpdate = (settings: Record<string, unknown>, points: number) => {
    const chain = buildFullChain({
      data: { id: 'asg-1', section_id: 'sec-1', status: 'draft', title: 'HW', due_at: null, description: '', settings },
      error: null,
    })
    const rpc = vi.fn().mockResolvedValue({ error: null })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: { from: vi.fn(() => chain), rpc } })
    return { rpc, call: () => mod.updateAssignment('sec-1', 'asg-1', { title: 'HW', points, fileTypes: [] }) }
  }
  const pCols = (rpc: ReturnType<typeof vi.fn>) => {
    expect(rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = rpc.mock.calls[0]
    expect(fn).toBe('merge_assignment_settings')
    return args.p_cols as { points?: number }
  }

  it('DROPS points when a rubric exists', async () => {
    const { rpc, call } = runUpdate(A_RUBRIC, 999)
    expect(await call()).toEqual({ success: true })
    expect('points' in pCols(rpc)).toBe(false)
  })

  it('WRITES points when there is no rubric', async () => {
    const { rpc, call } = runUpdate({}, 40)
    expect(await call()).toEqual({ success: true })
    expect(pCols(rpc).points).toBe(40)
  })
})
