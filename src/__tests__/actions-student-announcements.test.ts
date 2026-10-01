// Cross-section isolation tests for student announcement actions (security
// review Vuln 17). Each action verified enrollment in sectionId but never
// bound announcementId to it — letting an enrolled student read another
// section's comment thread (incl. commenter name + email) and inject
// comments/reactions. The announcementInSection bind must block that.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockAdminClient } from './helpers/mock-supabase'

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'student-1' } }, error: null })
  mockAdminClient.mockReset()
  mod = await import('@/app/(dashboard)/student/courses/[sectionId]/announcements/actions')
})

/** Enrolled in the section, but the announcement is NOT in it (announcements -> null). */
function setupForeignAnnouncement(extra: Record<string, { data: unknown; error: unknown }> = {}) {
  const client = createMockAdminClient({
    enrollments: { data: { id: 'enroll-1' }, error: null },
    announcements: { data: null, error: null },
    ...extra,
  })
  mockAdminClient.mockReturnValue(client)
  return client
}

describe('student announcement actions reject cross-section announcements', () => {
  it('getAnnouncementComments — returns no comments (no PII leak)', async () => {
    const client = setupForeignAnnouncement()
    const res = await mod.getAnnouncementComments('ann-B', 'sec-A')
    expect(res).toEqual({ data: [] })
    expect(client._tableCalls).not.toContain('announcement_comments')
  })

  it('getAnnouncementReactions — returns no reactions', async () => {
    const client = setupForeignAnnouncement()
    const res = await mod.getAnnouncementReactions('ann-B', 'sec-A')
    expect(res).toEqual({ data: [] })
    expect(client._tableCalls).not.toContain('announcement_reactions')
  })

  it('createComment — rejected, never inserts', async () => {
    const client = setupForeignAnnouncement()
    const res = await mod.createComment('ann-B', 'sec-A', 'injected comment')
    expect(res.error).toBe('Announcement not found')
    expect(client._tableCalls).not.toContain('announcement_comments')
  })

  it('toggleReaction — rejected, never inserts', async () => {
    const client = setupForeignAnnouncement()
    const res = await mod.toggleReaction('ann-B', 'sec-A', '👍')
    expect(res.error).toBe('Announcement not found')
    expect(client._tableCalls).not.toContain('announcement_reactions')
  })

  it('markAnnouncementRead — rejected, never writes read receipt', async () => {
    const client = setupForeignAnnouncement()
    const res = await mod.markAnnouncementRead('ann-B', 'sec-A')
    expect(res.error).toBe('Announcement not found')
    expect(client._tableCalls).not.toContain('announcement_reads')
  })
})

describe('acknowledgeAnnouncement', () => {
  it('rejects a student not enrolled in the section', async () => {
    const client = createMockAdminClient({ enrollments: { data: null, error: null } })
    mockAdminClient.mockReturnValue(client)
    const res = await mod.acknowledgeAnnouncement('ann-1', 'sec-A')
    expect(res.error).toBe('Not enrolled in this course')
    expect(client._tableCalls).not.toContain('announcement_reads')
  })

  it('rejects when the announcement does not require acknowledgement (no write)', async () => {
    const client = createMockAdminClient({
      enrollments: { data: { id: 'enroll-1' }, error: null },
      announcements: { data: { requires_acknowledgement: false }, error: null },
    })
    mockAdminClient.mockReturnValue(client)
    const res = await mod.acknowledgeAnnouncement('ann-1', 'sec-A')
    expect(res.error).toBe('This announcement does not require acknowledgement')
    expect(client._tableCalls).not.toContain('announcement_reads')
  })

  it('rejects a cross-section announcement', async () => {
    const client = createMockAdminClient({
      enrollments: { data: { id: 'enroll-1' }, error: null },
      announcements: { data: null, error: null },
    })
    mockAdminClient.mockReturnValue(client)
    const res = await mod.acknowledgeAnnouncement('ann-B', 'sec-A')
    expect(res.error).toBe('Announcement not found')
    expect(client._tableCalls).not.toContain('announcement_reads')
  })
})

describe('markAllAnnouncementsRead', () => {
  it('rejects a student not enrolled in the section', async () => {
    const client = createMockAdminClient({ enrollments: { data: null, error: null } })
    mockAdminClient.mockReturnValue(client)
    const res = await mod.markAllAnnouncementsRead('sec-A')
    expect(res.error).toBe('Not enrolled in this course')
    expect(client._tableCalls).not.toContain('announcement_reads')
  })
})
