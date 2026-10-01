// Tests for the professor notification-preferences action. It's a new mutating server
// action, so the security-relevant contract is the authz gate (only a professor may write)
// and that it merges into profiles.settings.notifications without clobbering other settings.

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  profileQueries: { getProfileById: (...args: unknown[]) => mockGetProfileById(...args) },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let updateProfessorNotificationPreferences: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockGetProfileById.mockReset()
  updateProfessorNotificationPreferences = (
    await import('@/app/(dashboard)/professor/preferences/actions')
  ).updateProfessorNotificationPreferences
})

describe('updateProfessorNotificationPreferences', () => {
  it('rejects unauthenticated users', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
    const res = await updateProfessorNotificationPreferences({ mutedTypes: [], digestHour: null })
    expect(res.error).toBe('Not authenticated')
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('rejects a non-professor caller (student) before any DB write', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
    mockGetProfileById.mockResolvedValue({ id: 'u1', role: 'student' })
    const res = await updateProfessorNotificationPreferences({ mutedTypes: [], digestHour: null })
    expect(res.error).toBe('Unauthorized — professor access required')
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it("saves a professor's muted kinds + digest hour, preserving other settings namespaces", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'prof-1' } }, error: null })
    mockGetProfileById.mockResolvedValue({ id: 'prof-1', role: 'professor' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let written: any
    const updateEq = vi.fn().mockResolvedValue({ error: null })
    const admin = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({ data: { settings: { profile: { theme: 'dark' } } }, error: null }),
          }),
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: (payload: any) => {
          written = payload
          return { eq: updateEq }
        },
      })),
    }
    mockAdminClient.mockReturnValue(admin)

    const res = await updateProfessorNotificationPreferences({
      mutedTypes: ['submissions_summary'],
      digestHour: 9,
    })

    expect(res.success).toBe(true)
    // Other settings namespaces are untouched (read-merge-write, not clobber).
    expect(written.settings.profile).toEqual({ theme: 'dark' })
    expect(written.settings.notifications).toEqual({
      mutedTypes: ['submissions_summary'],
      digestHour: 9,
      digestFrequency: 'daily',
    })
  })
})
