// Tests the call-site contract introduced by issue #104: when feedback is
// successfully inserted, submitFeedback must schedule a Slack notification
// via Next's after() using the DB-returned id/created_at; if the Slack call
// throws or returns false, the feedback action must still report success
// to the user; and if the DB insert fails, after() must NOT schedule a
// Slack call (which would crash on undefined inserted.id).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-Level Mocks ───────────────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockPostFeedbackToSlack = vi.fn()
const afterCallbacks: Array<() => Promise<void> | void> = []

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/server', () => ({
  // Capture every callback `after()` receives so tests can invoke it
  // synchronously and assert on the Slack side-effect.
  after: (cb: () => Promise<void> | void) => {
    afterCallbacks.push(cb)
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: { role: 'student', institution_id: 'inst-test-1' }, error: null }),
        })),
      })),
    })),
  })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/slack', () => ({
  postFeedbackToSlack: (...args: unknown[]) => mockPostFeedbackToSlack(...args),
}))

// ── Test Setup ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let submitFeedback: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockPostFeedbackToSlack.mockReset()
  afterCallbacks.length = 0

  const mod = await import('@/app/(dashboard)/feedback/actions')
  submitFeedback = mod.submitFeedback
})

// ── Helpers ──────────────────────────────────────────────────

const validInput = {
  rating: 2 as const,
  category: 'bug' as const,
  message: 'Quiz timer froze',
  page_url: '/student/courses/abc/quizzes',
  page_context: {
    pagePath: '/student/courses/abc/quizzes',
    pageTitle: 'Quizzes',
    role: 'student',
    sectionId: 'abc',
    featureName: 'quizzes',
    browser: 'Chrome',
    timestamp: '2026-05-05T14:00:00.000Z',
  },
}

/**
 * Build an admin client where:
 *   .from('feedbacks').insert(...).select(...).single() resolves to insertResult
 */
function buildAdminFor(insertResult: { data: unknown; error: unknown }) {
  const single = vi.fn().mockResolvedValue(insertResult)
  const select = vi.fn(() => ({ single }))
  const insert = vi.fn(() => ({ select }))
  const from = vi.fn(() => ({ insert }))
  return { from, _internals: { insert, select, single } }
}

function authenticate(userId = 'user-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

// ── Tests ────────────────────────────────────────────────────

describe('submitFeedback — Slack notification call site (issue #104)', () => {
  it('schedules postFeedbackToSlack via after() using DB-returned id and created_at', async () => {
    authenticate('user-1')
    const admin = buildAdminFor({
      data: { id: 'fb-from-db-42', created_at: '2026-05-05T14:00:00.000Z' },
      error: null,
    })
    mockAdminClient.mockReturnValue(admin)
    mockPostFeedbackToSlack.mockResolvedValue(true)

    const result = await submitFeedback(validInput)

    expect(result).toEqual({ success: true })
    // after() should have been given exactly one callback.
    expect(afterCallbacks).toHaveLength(1)
    // Slack call only happens once we drain the after() queue.
    expect(mockPostFeedbackToSlack).not.toHaveBeenCalled()

    await afterCallbacks[0]()

    expect(mockPostFeedbackToSlack).toHaveBeenCalledTimes(1)
    const payload = mockPostFeedbackToSlack.mock.calls[0][0]
    // The diff's whole point: the new .select('id, created_at').single() result
    // must flow through to Slack rather than the caller fabricating an id.
    expect(payload.feedbackId).toBe('fb-from-db-42')
    expect(payload.createdAt).toBe('2026-05-05T14:00:00.000Z')
    expect(payload.userId).toBe('user-1')
    expect(payload.userRole).toBe('student')
    expect(payload.rating).toBe(2)
    expect(payload.category).toBe('bug')
    expect(payload.pageUrl).toBe('/student/courses/abc/quizzes')
    // Bug reports rely on pageContext flowing through for Slack diagnostics.
    expect(payload.pageContext).toMatchObject({
      featureName: 'quizzes',
      sectionId: 'abc',
      pageTitle: 'Quizzes',
    })
  })

  it('still returns { success: true } when Slack POST throws inside after()', async () => {
    authenticate('user-1')
    mockAdminClient.mockReturnValue(
      buildAdminFor({
        data: { id: 'fb-1', created_at: '2026-05-05T14:00:00.000Z' },
        error: null,
      }),
    )
    mockPostFeedbackToSlack.mockRejectedValue(new Error('slack down'))

    const result = await submitFeedback(validInput)

    // The action returns BEFORE the after() callback runs; the user sees success.
    expect(result).toEqual({ success: true })

    // The after() callback wraps the Slack call in try/catch so a regression
    // in postFeedbackToSlack can never surface as an unhandled rejection in
    // serverless logs. Draining the queue must therefore NOT throw, even
    // when the underlying helper rejects.
    await expect(afterCallbacks[0]()).resolves.toBeUndefined()
    expect(mockPostFeedbackToSlack).toHaveBeenCalledTimes(1)
    // Critically: the user-facing return value did NOT depend on Slack.
  })

  it('does NOT schedule a Slack notification when the DB insert fails', async () => {
    authenticate('user-1')
    mockAdminClient.mockReturnValue(
      buildAdminFor({ data: null, error: { message: 'unique violation' } }),
    )

    const result = await submitFeedback(validInput)

    expect(result).toEqual({ error: 'Failed to submit feedback. Please try again.' })
    // No after() callback registered — otherwise it would crash on inserted.id.
    expect(afterCallbacks).toHaveLength(0)
    expect(mockPostFeedbackToSlack).not.toHaveBeenCalled()
  })

  it('falls back to current time when DB returns no created_at', async () => {
    authenticate('user-1')
    mockAdminClient.mockReturnValue(
      buildAdminFor({ data: { id: 'fb-no-ts', created_at: null }, error: null }),
    )
    mockPostFeedbackToSlack.mockResolvedValue(true)

    await submitFeedback(validInput)
    await afterCallbacks[0]()

    const payload = mockPostFeedbackToSlack.mock.calls[0][0]
    expect(payload.feedbackId).toBe('fb-no-ts')
    // Fallback should yield a parseable ISO timestamp, not null/undefined.
    expect(typeof payload.createdAt).toBe('string')
    expect(Number.isNaN(new Date(payload.createdAt).getTime())).toBe(false)
  })
})
