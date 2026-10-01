// Auth mock helpers for server action tests.
// Provides reusable functions for mocking authenticated/unauthenticated users,
// and batch auth-rejection test generators to reduce duplication.

import { vi, it, expect, describe } from 'vitest'

// ── Mock References ───────────────────────────────────────────
// These must be set up before any server action module is imported.
// Call setupAuthMocks() to get the mock function references.

export const mockGetUser = vi.fn()
export const mockAdminClient = vi.fn()

// ── Standard vi.mock() Calls ──────────────────────────────────
// These must be called at the top level of each test file that
// tests server actions. They cannot be inside a function because
// vi.mock() is hoisted.

export const AUTH_MOCKS = {
  /** Copy these vi.mock() calls to the top of your test file */
  serverClient: `vi.mock('@/lib/supabase/server', () => ({
    createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
  }))`,
  adminClient: `vi.mock('@/lib/supabase/admin', () => ({
    createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
  }))`,
  logger: `vi.mock('@/lib/logger', () => ({
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  }))`,
  nextCache: `vi.mock('next/cache', () => ({
    revalidatePath: vi.fn(),
  }))`,
} as const

// ── Auth State Helpers ────────────────────────────────────────

export function mockAuthenticatedUser(id = 'user-123') {
  mockGetUser.mockResolvedValue({
    data: { user: { id } },
    error: null,
  })
}

export function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({
    data: { user: null },
    error: { message: 'Not authenticated' },
  })
}

// ── Role-Specific Helpers ─────────────────────────────────────
// These set the auth user ID to a conventional value per role.

export function mockAdminUser(id = 'admin-user-id') {
  mockAuthenticatedUser(id)
}

export function mockProfessorUser(id = 'professor-user-id') {
  mockAuthenticatedUser(id)
}

export function mockStudentUser(id = 'student-user-id') {
  mockAuthenticatedUser(id)
}

// ── Reset Helper ──────────────────────────────────────────────

export function resetAuthMocks() {
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
}

// ── Batch Auth-Rejection Test Generators ──────────────────────
// Use these to test the standard auth guard pattern across many
// functions without repeating the same 2 tests for each one.

/**
 * Generates "rejects unauthenticated" + "rejects non-owner" tests for
 * professor/student actions that use verifyOwnership or verifyEnrollment.
 *
 * @param fnName  Display name for the describe block
 * @param callFn  Function that calls the action (receives no args, mock state is set before)
 * @param setupNotOwned  Function that mocks the admin client to simulate non-ownership/non-enrollment
 * @param opts.unauthError  Expected error message for unauthenticated users (default: 'Not authenticated')
 * @param opts.unauthorizedError  Expected error for non-owner (default: 'You do not own this course section')
 */
export function testAuthAndOwnership(
  fnName: string,
  callFn: () => Promise<{ error?: string }>,
  setupNotOwned: () => void,
  opts?: { unauthError?: string; unauthorizedError?: string },
) {
  const unauthMsg = opts?.unauthError ?? 'Not authenticated'
  const unauthorizedMsg = opts?.unauthorizedError ?? 'You do not own this course section'

  describe(fnName, () => {
    it('rejects unauthenticated users', async () => {
      mockUnauthenticated()
      const result = await callFn()
      expect(result.error).toBe(unauthMsg)
    })

    it('rejects non-owner', async () => {
      mockAuthenticatedUser('attacker-id')
      setupNotOwned()
      const result = await callFn()
      expect(result.error).toBe(unauthorizedMsg)
    })
  })
}

/**
 * Generates "rejects unauthenticated" + "rejects non-admin" tests for
 * admin actions that use verifyAdmin().
 */
export function testAdminAuth(
  fnName: string,
  callFn: () => Promise<{ error?: string }>,
  setupNonAdmin: () => void,
) {
  describe(fnName, () => {
    it('rejects unauthenticated users', async () => {
      mockUnauthenticated()
      const result = await callFn()
      expect(result.error).toBe('Not authenticated')
    })

    it('rejects non-admin role', async () => {
      setupNonAdmin()
      const result = await callFn()
      expect(result.error).toBe('Unauthorized — admin access required')
    })
  })
}

/**
 * Generates "rejects unauthenticated" + "rejects non-enrolled" tests for
 * student actions that use verifyEnrollment().
 */
export function testEnrollmentAuth(
  fnName: string,
  callFn: () => Promise<{ error?: string }>,
  setupNotEnrolled: () => void,
  opts?: { unauthError?: string; enrollmentError?: string },
) {
  const unauthMsg = opts?.unauthError ?? 'Not authenticated'
  const enrollMsg = opts?.enrollmentError ?? 'Not enrolled in this section'

  describe(fnName, () => {
    it('rejects unauthenticated users', async () => {
      mockUnauthenticated()
      const result = await callFn()
      expect(result.error).toBe(unauthMsg)
    })

    it('rejects non-enrolled students', async () => {
      mockAuthenticatedUser('student-123')
      setupNotEnrolled()
      const result = await callFn()
      expect(result.error).toBe(enrollMsg)
    })
  })
}
