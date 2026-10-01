/**
 * `unpublishGrades` — the way back from a mistaken grade release.
 *
 * The oracle that matters is the VALUE written, not that a write happened. This action's
 * whole job is flipping one boolean the student's page reads; a patch that sent
 * `gradesPublished: true` (or omitted the key) would return `{ success: true }`, toast
 * "Grades hidden from students", and leave every score still visible. Every other
 * assertion here is worthless next to that one.
 *
 * The rest guards the reasons this action can refuse. It is a mutation reachable by
 * assignment id, so the section binding is an authz boundary, not a lookup detail:
 * `.eq('id', assignmentId)` alone matches an assignment in ANY section, and only the
 * explicit `section_id !== sectionId` comparison stops a professor un-publishing another
 * course's grades.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockCanWriteAsStaff = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...a: unknown[]) => mockVerifySectionAccess(...a),
  canWriteAsStaff: (...a: unknown[]) => mockCanWriteAsStaff(...a),
  canWriteAsProfessor: () => true,
  canGrade: () => true,
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({ emitEvent: vi.fn(), markFeedItemDone: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let unpublishGrades: any
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Chain covering the single `assignments` read: .select().eq().maybeSingle(). */
function assignmentChain(row: unknown) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null })
  return chain
}

/** verifySectionAccess grants a staff role over an adminDb serving `row` from assignments. */
function accessWith(row: unknown) {
  const rpc = vi.fn().mockResolvedValue({ error: null })
  const adminDb = { from: vi.fn(() => assignmentChain(row)), rpc }
  mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb })
  return rpc
}

/** The single merge_assignment_settings patch, or undefined if nothing was written. */
function patchFrom(rpc: ReturnType<typeof vi.fn>) {
  const call = rpc.mock.calls.find((c) => c[0] === 'merge_assignment_settings')
  return call?.[1]?.p_patch as Record<string, unknown> | undefined
}

const PUBLISHED = { id: 'asg-1', section_id: 'sec-1', settings: { gradesPublished: true } }

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
  mockVerifySectionAccess.mockReset()
  mockCanWriteAsStaff.mockReset().mockReturnValue(true)
  const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions')
  unpublishGrades = mod.unpublishGrades
})

describe('unpublishGrades', () => {
  it('hides the grades by writing gradesPublished: false', async () => {
    const rpc = accessWith(PUBLISHED)

    const res = await unpublishGrades('sec-1', 'asg-1')

    expect(res).toEqual({ success: true })
    // The one assertion that distinguishes a working withdraw from a no-op that claims success.
    expect(patchFrom(rpc)?.gradesPublished).toBe(false)
  })

  it('patches only the publish keys, so a concurrent settings write is not clobbered', async () => {
    const rpc = accessWith(PUBLISHED)

    await unpublishGrades('sec-1', 'asg-1')

    // A patch carrying the whole settings object would restore whatever this request read
    // and silently undo a rubric/instructions save made in between.
    expect(Object.keys(patchFrom(rpc) ?? {}).sort()).toEqual([
      'gradesPublished',
      'gradesUnpublishedAt',
    ])
  })

  it('refuses an assignment belonging to another section', async () => {
    const rpc = accessWith({ ...PUBLISHED, section_id: 'someone-elses-section' })

    const res = await unpublishGrades('sec-1', 'asg-1')

    expect(res).toEqual({ error: 'Assignment not found.' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses a role without staff write access', async () => {
    const rpc = accessWith(PUBLISHED)
    mockCanWriteAsStaff.mockReturnValue(false)

    const res = await unpublishGrades('sec-1', 'asg-1')

    expect(res).toEqual({ error: expect.stringContaining('permission') })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('is a no-op when the grades were never published', async () => {
    // Reports success (the caller's goal — grades are private — already holds) but must not
    // write, or a double-click would log a withdraw of something that was never released.
    const rpc = accessWith({ ...PUBLISHED, settings: {} })

    const res = await unpublishGrades('sec-1', 'asg-1')

    expect(res).toEqual({ success: true })
    expect(rpc).not.toHaveBeenCalled()
  })
})
