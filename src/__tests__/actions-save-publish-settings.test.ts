// savePublishSettings is the writer the 800ms studio autosave calls — the exact writer the
// merge_assignment_settings RPC exists to protect. It must send a KEY-SCOPED merge: p_patch
// carries only the keys this tab owns (accepts + optional assessment), and p_cols carries the
// scalar columns (due_at, is_graded), so a concurrent Rubrics-tab autosave is never clobbered.

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

describe('savePublishSettings — key-scoped merge via the RPC', () => {
  it('patches only accepts + assessment and sends due_at + is_graded as scalar cols', async () => {
    const chain = buildFullChain({ data: { id: 'asg-1', section_id: 'sec-1' }, error: null })
    const rpc = vi.fn().mockResolvedValue({ error: null })
    const adminDb = { from: vi.fn(() => chain), rpc }
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.savePublishSettings('sec-1', 'asg-1', {
      dueAt: '2026-08-01T00:00:00.000Z',
      fileTypes: ['pdf'],
      assessment: undefined,
      isGraded: true,
    })

    expect(res).toEqual({ success: true })
    expect(rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = rpc.mock.calls[0]
    expect(fn).toBe('merge_assignment_settings')
    // Only this tab's keys are patched — no rubric/rubricDraft/studio keys ride along.
    expect(Object.keys(args.p_patch).sort()).toEqual(['accepts'])
    expect(args.p_patch.accepts).toEqual({ fileTypes: ['pdf'] })
    // Scalars go through p_cols, not the JSONB patch.
    expect(args.p_cols).toEqual({ due_at: '2026-08-01T00:00:00.000Z', is_graded: true })
  })

  // The notebook and document studios render no Ungraded control, so their panel has no real value
  // for it. Sending its local default (true) silently re-added an ungraded assignment to the
  // gradebook on the next unrelated autosave (a deadline tweak, a file type).
  it('omits is_graded entirely when the caller does not supply it', async () => {
    const chain = buildFullChain({ data: { id: 'asg-1', section_id: 'sec-1' }, error: null })
    const rpc = vi.fn().mockResolvedValue({ error: null })
    const adminDb = { from: vi.fn(() => chain), rpc }
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.savePublishSettings('sec-1', 'asg-1', {
      dueAt: '2026-08-01T00:00:00.000Z',
      fileTypes: ['pdf'],
      assessment: undefined,
      // no isGraded key at all
    })

    expect(res).toEqual({ success: true })
    const [, args] = rpc.mock.calls[0]
    expect('is_graded' in args.p_cols).toBe(false)
    expect(args.p_cols).toEqual({ due_at: '2026-08-01T00:00:00.000Z' })
  })

  it('still writes is_graded: false when the caller explicitly sends it', async () => {
    const chain = buildFullChain({ data: { id: 'asg-1', section_id: 'sec-1' }, error: null })
    const rpc = vi.fn().mockResolvedValue({ error: null })
    const adminDb = { from: vi.fn(() => chain), rpc }
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    await mod.savePublishSettings('sec-1', 'asg-1', {
      dueAt: null,
      fileTypes: ['pdf'],
      assessment: undefined,
      isGraded: false,
    })

    const [, args] = rpc.mock.calls[0]
    expect(args.p_cols.is_graded).toBe(false)
  })

  it('refuses to autosave a PUBLISHED assignment (no silent live mutation) and never writes', async () => {
    // On a live assignment this debounced autosave would move the deadline with no student
    // notification and could drop it from the gradebook — so the server rejects it outright;
    // edits to a live assignment must go through the explicit Publish button instead.
    const chain = buildFullChain({ data: { id: 'asg-1', section_id: 'sec-1', status: 'published' }, error: null })
    const rpc = vi.fn().mockResolvedValue({ error: null })
    const adminDb = { from: vi.fn(() => chain), rpc }
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })

    const res = await mod.savePublishSettings('sec-1', 'asg-1', {
      dueAt: null, fileTypes: ['pdf'], assessment: undefined, isGraded: true,
    })

    expect(res).toEqual({ error: expect.stringContaining('live') })
    expect(rpc).not.toHaveBeenCalled() // nothing written
  })
})
