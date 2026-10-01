// saveAssessmentProctoringSnapshot lets the client supply violationType / timestampOffset /
// faceCount, and timestampOffset flows into the storage object key. The bounds run right after
// auth and BEFORE the admin client is created, so an out-of-range value must be rejected before
// any DB/storage call. A regression here would let unbounded client input reach the storage path.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdmin = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mockAdmin() }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({ markFeedItemDone: vi.fn(), emitEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

type Mod = typeof import('@/app/(dashboard)/student/courses/[sectionId]/assignments/assessment-actions')
let mod: Mod

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'stu-1' } }, error: null })
  mockAdmin.mockReset()
  mod = await import('@/app/(dashboard)/student/courses/[sectionId]/assignments/assessment-actions')
})

describe('saveAssessmentProctoringSnapshot — input bounds (before any admin/storage call)', () => {
  const call = (violationType: string, timestampOffset: number, faceCount: number) =>
    mod.saveAssessmentProctoringSnapshot('sub-1', violationType, 'aGVsbG8=', timestampOffset, faceCount)

  it('rejects an unknown violationType (only mf/ph/bl are valid)', async () => {
    expect(await call('foo', 10, 1)).toEqual({ error: 'Invalid snapshot.' })
    expect(mockAdmin).not.toHaveBeenCalled()
  })

  it('accepts mf, ph, and bl violationTypes (admin client is reached)', async () => {
    // The admin client is called — validation passes and processing begins.
    // mockAdmin returns undefined so the DB query throws, but validation itself passed.
    // We assert that mockAdmin WAS called (i.e. the guard did not reject early).
    mockAdmin.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    })
    await call('mf', 10, 1)
    expect(mockAdmin).toHaveBeenCalled()
    mockAdmin.mockReset()

    mockAdmin.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    })
    await call('ph', 10, 1)
    expect(mockAdmin).toHaveBeenCalled()
    mockAdmin.mockReset()

    mockAdmin.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    })
    await call('bl', 10, 1)
    expect(mockAdmin).toHaveBeenCalled()
  })

  it('rejects a negative, non-integer, or too-large timestampOffset', async () => {
    expect(await call('mf', -1, 1)).toEqual({ error: 'Invalid snapshot.' })
    expect(await call('mf', 1.5, 1)).toEqual({ error: 'Invalid snapshot.' })
    // 86_400_001 ms is just over 24 h — rejected
    expect(await call('mf', 86_400_001, 1)).toEqual({ error: 'Invalid snapshot.' })
    expect(mockAdmin).not.toHaveBeenCalled()
  })

  it('accepts a mid-exam ms offset like 1_800_000 (30 min) — admin client is reached', async () => {
    // 86_401 ms (~86 s) was previously rejected due to the seconds-not-ms bug.
    // Both 86_401 and 1_800_000 must now pass validation.
    mockAdmin.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    })
    await call('mf', 86_401, 1)
    expect(mockAdmin).toHaveBeenCalled()
    mockAdmin.mockReset()

    mockAdmin.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    })
    await call('mf', 1_800_000, 1)
    expect(mockAdmin).toHaveBeenCalled()
  })

  it('rejects an out-of-range faceCount', async () => {
    expect(await call('ph', 10, -1)).toEqual({ error: 'Invalid snapshot.' })
    expect(await call('ph', 10, 101)).toEqual({ error: 'Invalid snapshot.' })
    expect(mockAdmin).not.toHaveBeenCalled()
  })
})
