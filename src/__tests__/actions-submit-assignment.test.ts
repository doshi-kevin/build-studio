// submitAssignment reorders to upsert-before-cleanup (PR #198 review): old files must be
// removed ONLY after the row safely points at the new ones, and only the stale paths
// (not the freshly-uploaded ones). A regression here passes typecheck + the full suite
// but corrupts student submissions in prod, so it's worth pinning.

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

const OLD_PATH = 'sec-1/asg-1/stu-1/111-old.txt'
const FUTURE = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
const PAST = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

/** Admin client with the three table reads submitAssignment makes + storage spies.
 *  `existingSubmission` overrides the default submitted row (used for graded-guard tests). */
function makeAdmin(
  upsertError: { message: string } | null,
  existingSubmission?: Record<string, unknown>,
) {
  const remove = vi.fn().mockResolvedValue({ error: null })
  const upload = vi.fn().mockResolvedValue({ error: null })
  const upsert = vi.fn().mockResolvedValue({ error: upsertError })

  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.in = () => c
    // supersedeAiSuggestions (resubmit invalidation) does .update().eq()...; the terminal
    // await on the chain yields { error: undefined } (best-effort, so a no-op is fine here).
    c.update = () => c
    c.maybeSingle = () => Promise.resolve({ data: result, error: null })
    c.upsert = upsert
    return c
  }

  const defaultSubmission = {
    status: 'submitted',
    files: [{ path: OLD_PATH, name: 'old.txt', size: 1, type: 'text/plain' }],
    resubmit_until: null,
  }

  const client = {
    from: (t: string) => {
      if (t === 'assignments') {
        return chain({
          id: 'asg-1',
          section_id: 'sec-1',
          status: 'published',
          settings: { accepts: { fileTypes: ['txt'] } },
          institution_id: 'inst-1',
        })
      }
      if (t === 'enrollments') return chain({ id: 'enr-1' })
      // assignment_submissions: existing row has one prior file + supports upsert
      return chain(existingSubmission ?? defaultSubmission)
    },
    storage: { from: () => ({ upload, remove }) },
  }
  return { client, remove, upload, upsert }
}

function formDataWith(fileName: string) {
  const fd = new FormData()
  fd.append('text', '')
  fd.append('files', new File([new Uint8Array([1, 2, 3])], fileName, { type: 'text/plain' }))
  return fd
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'stu-1' } }, error: null })
  mockAdmin.mockReset()
  mod = await import('@/app/(dashboard)/student/courses/[sectionId]/assignments/actions')
})

describe('submitAssignment — upsert-before-cleanup', () => {
  it('does NOT remove old files if the upsert fails (no orphaned submission)', async () => {
    const { client, remove } = makeAdmin({ message: 'boom' })
    mockAdmin.mockReturnValue(client)
    const res = await mod.submitAssignment('sec-1', 'asg-1', formDataWith('new.txt'))
    expect('error' in res).toBe(true)
    expect(remove).not.toHaveBeenCalled()
  })

  it('removes only the stale path after a successful upsert (keeps the new file)', async () => {
    const { client, remove } = makeAdmin(null)
    mockAdmin.mockReturnValue(client)
    const res = await mod.submitAssignment('sec-1', 'asg-1', formDataWith('new.txt'))
    expect(res).toEqual({ success: true })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith([OLD_PATH])
  })
})

describe('submitAssignment — graded-guard with active reopen window', () => {
  it('13. graded + active resubmit_until: allowed through the graded guard (proceeds to submit)', async () => {
    // A graded submission with a future resubmit_until must NOT be blocked by the graded guard;
    // the professor explicitly reopened the window, so the student should be able to resubmit.
    const { client } = makeAdmin(null, {
      status: 'graded',
      files: [{ path: OLD_PATH, name: 'old.txt', size: 1, type: 'text/plain' }],
      resubmit_until: FUTURE,
    })
    mockAdmin.mockReturnValue(client)
    const res = await mod.submitAssignment('sec-1', 'asg-1', formDataWith('new.txt'))
    // Passes the graded guard → reaches the upsert → succeeds
    expect(res).toEqual({ success: true })
  })

  it('14. graded + expired/null resubmit_until: still returns the graded-guard error', async () => {
    // Without an active window, a graded submission must not be changeable.
    const { client } = makeAdmin(null, {
      status: 'graded',
      files: [{ path: OLD_PATH, name: 'old.txt', size: 1, type: 'text/plain' }],
      resubmit_until: PAST,
    })
    mockAdmin.mockReturnValue(client)
    const res = await mod.submitAssignment('sec-1', 'asg-1', formDataWith('new.txt'))
    expect(res).toEqual({
      error: "This submission can't be changed right now. Contact your instructor if you need to update it.",
    })
  })
})
