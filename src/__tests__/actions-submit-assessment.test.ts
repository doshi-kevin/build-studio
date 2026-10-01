// submitAssessment is the student's final assessment submit. The guard under test is the
// stale-tab defense (the reopen-race fix): after a professor reopen, assessment_started_at is
// nulled, so a tab still open with an old countdown must NOT be able to auto-submit stale files
// onto the fresh attempt. The server rejects when the row's assessment_started_at IS NULL —
// this is the last line of defense and had no coverage. A happy-path case guards the guard
// (a genuinely-in-window submit still writes).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain } from './helpers/mock-supabase'

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

// Assessment with proctoring OFF so submitAssessment skips the proctoring-summary aggregation
// (keeps the mock to the three tables the guard path touches).
const ASSIGNMENT = {
  id: 'asg-1',
  section_id: 'sec-1',
  status: 'published',
  institution_id: 'inst-1',
  due_at: null,
  settings: { assessment: { enabled: true, workMinutes: 30, uploadMinutes: 5, proctoring: { activity: false, fullscreen: false, video: false } } },
}

/** adminDb routing assignments (context), enrollments (enrolment), assignment_submissions (read+update). */
function makeAdmin(sub: unknown) {
  const subChain = buildFullChain({ data: sub, error: null })
  const adminDb = {
    from: vi.fn((t: string) => {
      if (t === 'assignments') return buildFullChain({ data: ASSIGNMENT, error: null })
      if (t === 'enrollments') return buildFullChain({ data: { id: 'enr-1' }, error: null })
      if (t === 'assignment_submissions') return subChain
      return buildFullChain({ data: null, error: null })
    }),
  }
  return { adminDb, subChain }
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'stu-1' } }, error: null })
  mockAdmin.mockReset()
  mod = await import('@/app/(dashboard)/student/courses/[sectionId]/assignments/assessment-actions')
})

describe('submitAssessment — stale-tab (reopened attempt) guard', () => {
  it('rejects when assessment_started_at is null (attempt was reset) and performs NO write', async () => {
    const { adminDb, subChain } = makeAdmin({
      id: 'sub-1', status: 'draft', files: [], assessment_started_at: null, assessment_work_ended_at: null, resubmit_until: null,
    })
    mockAdmin.mockReturnValue(adminDb)

    const res = await mod.submitAssessment('sec-1', 'asg-1', new FormData())

    expect(res).toEqual({ error: expect.stringContaining('reset') })
    expect(subChain.update).not.toHaveBeenCalled() // no stale auto-submit onto the fresh attempt
  })

  it('still submits a genuinely in-window attempt (guards the guard)', async () => {
    // Started 31 min ago: the 30-min work window is over, so we are in the 5-min upload window.
    const startedAt = new Date(Date.now() - 31 * 60_000).toISOString()
    const { adminDb, subChain } = makeAdmin({
      id: 'sub-1', status: 'draft', files: [], assessment_started_at: startedAt, assessment_work_ended_at: null, resubmit_until: null,
    })
    mockAdmin.mockReturnValue(adminDb)

    const res = await mod.submitAssessment('sec-1', 'asg-1', new FormData())

    expect(res).toEqual({ success: true })
    expect(subChain.update).toHaveBeenCalledTimes(1)
    expect((subChain.update.mock.calls[0][0] as { status: string }).status).toBe('submitted')
  })
})
