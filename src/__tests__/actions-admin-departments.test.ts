// Tests for admin department server actions — error handling and business logic.
// Auth gate tests removed (tautological). Kept: error fallback for getDepartmentCascadeCounts.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-Level Mock References ─────────────────────────────

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockGetProfileById = vi.fn()

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
vi.mock('@/lib/supabase/queries', () => ({
  profileQueries: {
    getProfileById: (...args: unknown[]) => mockGetProfileById(...args),
  },
  departmentQueries: {
    getByCode: vi.fn().mockResolvedValue(null),
  },
}))

// ── Lazily-imported action references ────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getDepartmentCascadeCounts: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockGetProfileById.mockReset()

  const mod = await import('@/app/(dashboard)/admin/departments/actions')
  getDepartmentCascadeCounts = mod.getDepartmentCascadeCounts
})

// ── getDepartmentCascadeCounts ────────────────────────────────
// This action does NOT call verifyAdmin — it uses the admin client directly.
// We verify it handles unexpected errors gracefully (no auth wall to test here).

describe('getDepartmentCascadeCounts', () => {
  /* Zeros were the bug (#715). The delete dialog renders a zeroed result as "nothing will
     be affected", so returning zeros for a lookup that FAILED reassured the admin that a
     populated department was empty, immediately before an unrecoverable cascade. null is
     the only honest answer to "I could not check", and the dialog renders it as a warning
     that does not claim to know. */
  it('returns null, not zeroed counts, when the admin client throws', async () => {
    mockAdminClient.mockImplementation(() => {
      throw new Error('client error')
    })
    const result = await getDepartmentCascadeCounts('dept-1')
    expect(result).toBeNull()
  })
})
