// Tests for student challenge server actions — auth and enrollment checks.
// Covers claimChallenge, withdrawClaim, submitSolution, and proposeChallenge.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.is = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(finalResult)
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.delete = vi.fn().mockReturnValue(chain)
  chain.upsert = vi.fn().mockReturnValue(chain)
  chain.then = undefined
  return chain
}

// ── Module-Level Mock References ─────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))

// ── Test Setup ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let claimChallenge: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let withdrawClaim: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let submitSolution: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let proposeChallenge: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import(
    '@/app/(dashboard)/student/courses/[sectionId]/challenges/actions'
  )
  claimChallenge = mod.claimChallenge
  withdrawClaim = mod.withdrawClaim
  submitSolution = mod.submitSolution
  proposeChallenge = mod.proposeChallenge
})

// ── Helpers ──────────────────────────────────────────────────

function mockAuthenticated(userId = 'student-123') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
}

function mockNotEnrolled() {
  const admin = {
    from: vi.fn(() => buildChain({ data: null, error: null })),
  }
  mockAdminClient.mockReturnValue(admin)
}

// ── claimChallenge ───────────────────────────────────────────

describe('claimChallenge', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await claimChallenge('challenge-1', 'section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    mockNotEnrolled()
    const result = await claimChallenge('challenge-1', 'section-1')
    expect(result.error).toBe('Not enrolled in this section')
  })
})

// ── withdrawClaim ─────────────────────────────────────────────

describe('withdrawClaim', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await withdrawClaim('claim-1', 'section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    mockNotEnrolled()
    const result = await withdrawClaim('claim-1', 'section-1')
    expect(result.error).toBe('Not enrolled in this section')
  })
})

// ── submitSolution ────────────────────────────────────────────

describe('submitSolution', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await submitSolution('claim-1', 'section-1', {
      submission_type: 'text',
      content: 'My answer',
    })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects invalid input before checking auth/enrollment', async () => {
    mockAuthenticated()
    // submission_type is required — omitting it causes schema validation failure
    const result = await submitSolution('claim-1', 'section-1', {})
    expect(result.error).toBe('Invalid input: Invalid option: expected one of "text"|"link"|"file"|"github"')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    mockNotEnrolled()
    const result = await submitSolution('claim-1', 'section-1', {
      submission_type: 'text',
      content: 'My answer',
    })
    expect(result.error).toBe('Not enrolled in this section')
  })
})

// ── proposeChallenge ──────────────────────────────────────────

describe('proposeChallenge', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await proposeChallenge('section-1', {
      title: 'My Challenge Idea',
    })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects invalid input before checking auth/enrollment', async () => {
    mockAuthenticated()
    // title is required — omitting it causes schema validation failure
    const result = await proposeChallenge('section-1', {})
    expect(result.error).toBe('Invalid input: Invalid input: expected string, received undefined')
  })

  it('rejects non-enrolled students', async () => {
    mockAuthenticated()
    mockNotEnrolled()
    const result = await proposeChallenge('section-1', {
      title: 'My Challenge Idea',
    })
    expect(result.error).toBe('Not enrolled in this section')
  })
})

/**
 * submitSolution inserted the submission and THEN flipped the claim to 'submitted' (#701).
 *
 * The `claim.status !== 'claimed'` check sat an await away from the write, so two parallel
 * calls both saw an unflipped claim and both proceeded — the professor's review panel then
 * showed two competing submissions under one claim with nothing to say which was
 * authoritative. Proven live with Promise.all.
 *
 * The fix claims the transition FIRST with the guard in the WHERE. These pin the three
 * things that make that correct, because the ordering is the whole fix and it is invisible
 * from the outside:
 *
 *   1. the guarded update runs BEFORE the insert
 *   2. zero rows from it means "someone else won" and nothing is written
 *   3. a failed insert REVERTS the claim, or it is stranded in 'submitted' with nothing
 *      attached and the student can never retry
 */
describe('submitSolution — one submission per claim (#701)', () => {
  const CLAIM = { id: 'claim-1', user_id: 'student-1', status: 'claimed' }
  const input = { submission_type: 'text' as const, content: 'my answer' }

  /** Routes challenge_claims and challenge_submissions to separate chains we can inspect. */
  function harness(opts: { claimWon: boolean; insertError?: unknown }) {
    const claims = buildChain({ data: opts.claimWon ? { id: 'claim-1' } : null, error: null })
    // The first read of challenge_claims is the ownership/status fetch via .single().
    claims.single = vi.fn().mockResolvedValue({ data: CLAIM, error: null })
    const submissions = buildChain({ data: null, error: opts.insertError ?? null })
    // The insert is awaited directly, so the chain has to be thenable.
    submissions.then = (res: (v: unknown) => void) =>
      Promise.resolve({ data: null, error: opts.insertError ?? null }).then(res)

    const order: string[] = []
    mockAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        order.push(table)
        return table === 'challenge_submissions' ? submissions : claims
      }),
    })
    return { claims, submissions, order }
  }

  beforeEach(() => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'student-1' } }, error: null })
  })

  it('claims the status transition BEFORE writing the submission', async () => {
    const { claims, order } = harness({ claimWon: true })
    await submitSolution('claim-1', 'section-1', input)

    /* The guard must ride in the WHERE, not be a prior read. */
    expect(claims.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'submitted' }),
    )
    expect(claims.eq).toHaveBeenCalledWith('status', 'claimed')

    /* Ordering is the fix: the claims table is touched before submissions. */
    expect(order.indexOf('challenge_submissions')).toBeGreaterThan(order.indexOf('challenge_claims'))
  })

  it('refuses and writes nothing when a concurrent submission already won', async () => {
    const { submissions } = harness({ claimWon: false })
    const res = await submitSolution('claim-1', 'section-1', input)

    expect(res.error).toMatch(/already has a submission/i)
    expect(submissions.insert).not.toHaveBeenCalled()
  })

  it('reverts the claim when the insert fails, so the student can retry', async () => {
    const { claims } = harness({ claimWon: true, insertError: { message: 'boom' } })
    const res = await submitSolution('claim-1', 'section-1', input)

    expect(res.error).toBeTruthy()
    /* Without this the claim is stranded in 'submitted' with no submission attached. */
    expect(claims.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'claimed' }))
  })
})
