// Pins the entitlement ORDER in getQuizReveal (src/lib/live-classroom/history/actions.ts).
//
// Incident: entitlement was computed as `isProf || interaction.status === 'closed'`, and
// the enrollment lookup only ran when that was false. So for any CLOSED live-classroom
// quiz, the membership check was skipped entirely — anyone authenticated who knew (or
// guessed) an interaction id could pull the full answer key and explanations for a quiz
// in any section of any institution. The admin client is used here specifically to be
// independent of read policies, so the lc_interactions RLS policy that would otherwise
// scope this never applied.
//
// The fix inverts the order: membership FIRST for everyone who is not the room's
// professor, then status decides. "A 'closed' status is a reason to reveal answers to
// the class, not a reason to skip asking who is asking."
//
// This is order-dependent logic with no existing coverage, and a regression is silent —
// the endpoint keeps returning answers, just to the wrong people. Hence the negative
// assertions below check both the error AND that no questions came back, because
// returning `{ error, questions }` together would leak just as effectively.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockAdminClient } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))

const PROF = 'prof-user-id'
const ENROLLED = 'enrolled-student-id'
const OUTSIDER = 'outsider-user-id'

const QUESTIONS = [
  { id: 'q1', prompt: 'Capital of France?', correctChoiceId: 'c2', explanation: 'It is Paris.' },
]

/**
 * Builds the admin double for one scenario.
 * `enrolled` drives the enrollments lookup; `submitted` drives lc_responses.
 */
function adminFor(opts: {
  status: 'open' | 'closed'
  revealAnswers?: boolean
  enrolled: boolean
  submitted?: boolean
}) {
  return createMockAdminClient({
    lc_interactions: {
      data: {
        id: 'interaction-1',
        room_id: 'room-1',
        kind: 'quiz',
        status: opts.status,
        payload: { revealAnswers: opts.revealAnswers ?? false, questions: QUESTIONS },
      },
      error: null,
    },
    lc_rooms: { data: { section_id: 'section-1', prof_id: PROF }, error: null },
    enrollments: { data: opts.enrolled ? { id: 'enrollment-1' } : null, error: null },
    lc_responses: { data: opts.submitted ? { id: 'response-1' } : null, error: null },
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getQuizReveal: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  getQuizReveal = (await import('@/lib/live-classroom/history/actions')).getQuizReveal
})

function signInAs(id: string | null) {
  mockGetUser.mockResolvedValue({ data: { user: id ? { id } : null }, error: null })
}

describe('getQuizReveal — a CLOSED quiz still requires membership', () => {
  it('refuses a non-enrolled user on a closed quiz (the regression that mattered)', async () => {
    signInAs(OUTSIDER)
    const admin = adminFor({ status: 'closed', enrolled: false })
    mockAdminClient.mockReturnValue(admin)

    const res = await getQuizReveal('interaction-1')

    expect(res.error).toBe('Forbidden')
    expect(res.questions).toBeUndefined()
    // The answer key must not ride along beside the error.
    expect(JSON.stringify(res)).not.toContain('It is Paris.')
    expect(JSON.stringify(res)).not.toContain('correctChoiceId')
    // Membership was actually consulted — the old code never reached this table
    // for a closed quiz, which is precisely how the leak happened.
    expect(admin._tableCalls).toContain('enrollments')
  })

  it('refuses an unauthenticated caller before touching the admin client', async () => {
    signInAs(null)
    mockAdminClient.mockReturnValue(adminFor({ status: 'closed', enrolled: false }))

    const res = await getQuizReveal('interaction-1')

    expect(res.error).toBe('Not authenticated')
    expect(res.questions).toBeUndefined()
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('reveals to an ENROLLED student once the quiz is closed', async () => {
    // The other half of the invariant: the fix must not break reveal-on-close, which
    // is the normal post-quiz class review.
    signInAs(ENROLLED)
    mockAdminClient.mockReturnValue(adminFor({ status: 'closed', enrolled: true }))

    const res = await getQuizReveal('interaction-1')

    expect(res.error).toBeUndefined()
    expect(res.questions).toEqual(QUESTIONS)
  })

  it('reveals to an enrolled student on a closed quiz even if they never submitted', async () => {
    signInAs(ENROLLED)
    mockAdminClient.mockReturnValue(
      adminFor({ status: 'closed', enrolled: true, submitted: false }),
    )
    expect((await getQuizReveal('interaction-1')).questions).toEqual(QUESTIONS)
  })
})

describe('getQuizReveal — the professor path is unchanged', () => {
  it("reveals to the room's professor without an enrollment row", async () => {
    signInAs(PROF)
    const admin = adminFor({ status: 'open', enrolled: false })
    mockAdminClient.mockReturnValue(admin)

    const res = await getQuizReveal('interaction-1')

    expect(res.questions).toEqual(QUESTIONS)
    expect(admin._tableCalls).not.toContain('enrollments')
  })
})

describe('getQuizReveal — an OPEN quiz keeps the reveal-on-submit rules', () => {
  it('reveals to an enrolled student who submitted, when revealAnswers is on', async () => {
    signInAs(ENROLLED)
    mockAdminClient.mockReturnValue(
      adminFor({ status: 'open', revealAnswers: true, enrolled: true, submitted: true }),
    )
    expect((await getQuizReveal('interaction-1')).questions).toEqual(QUESTIONS)
  })

  it('refuses an enrolled student who has NOT submitted', async () => {
    signInAs(ENROLLED)
    mockAdminClient.mockReturnValue(
      adminFor({ status: 'open', revealAnswers: true, enrolled: true, submitted: false }),
    )
    const res = await getQuizReveal('interaction-1')
    expect(res.error).toBe('Answers are not available yet')
    expect(res.questions).toBeUndefined()
  })

  it('refuses an enrolled student when the professor did not opt into reveal-on-submit', async () => {
    signInAs(ENROLLED)
    mockAdminClient.mockReturnValue(
      adminFor({ status: 'open', revealAnswers: false, enrolled: true, submitted: true }),
    )
    const res = await getQuizReveal('interaction-1')
    expect(res.error).toBe('Answers are not available yet')
    expect(res.questions).toBeUndefined()
  })

  it('refuses a non-enrolled user on an open quiz', async () => {
    signInAs(OUTSIDER)
    mockAdminClient.mockReturnValue(
      adminFor({ status: 'open', revealAnswers: true, enrolled: false, submitted: true }),
    )
    expect((await getQuizReveal('interaction-1')).error).toBe('Forbidden')
  })
})

describe('getQuizReveal — lookup failures', () => {
  it('returns Quiz not found for a missing interaction', async () => {
    signInAs(ENROLLED)
    mockAdminClient.mockReturnValue(
      createMockAdminClient({ lc_interactions: { data: null, error: null } }),
    )
    expect((await getQuizReveal('nope')).error).toBe('Quiz not found')
  })

  it('returns Quiz not found for an interaction that is not a quiz', async () => {
    signInAs(ENROLLED)
    mockAdminClient.mockReturnValue(
      createMockAdminClient({
        lc_interactions: { data: { id: 'i', room_id: 'r', kind: 'poll', status: 'closed', payload: {} }, error: null },
      }),
    )
    expect((await getQuizReveal('interaction-1')).error).toBe('Quiz not found')
  })

  it('returns Quiz not found when the room is missing', async () => {
    signInAs(ENROLLED)
    mockAdminClient.mockReturnValue(
      createMockAdminClient({
        lc_interactions: {
          data: { id: 'i', room_id: 'r', kind: 'quiz', status: 'closed', payload: { questions: QUESTIONS } },
          error: null,
        },
        lc_rooms: { data: null, error: null },
      }),
    )
    expect((await getQuizReveal('interaction-1')).error).toBe('Quiz not found')
  })
})
