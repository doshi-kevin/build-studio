// Membership-isolation tests for shared chat-reaction actions (security
// review Vuln 9). A user may only react on a message whose channel they
// belong to: discussion = section enrollment OR professor/staff; project
// chat = team membership. Without it any authenticated user could react on
// any message in any tenant.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockAdminClient } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockVerifySectionAccess = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...args: unknown[]) => mockVerifySectionAccess(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockAdminClient.mockReset()
  mockVerifySectionAccess.mockReset().mockResolvedValue({ ok: false })
  mod = await import('@/app/(dashboard)/chat-reactions/actions')
})

describe('toggleDiscussionReaction — channel membership', () => {
  it('rejects a course-channel non-member (not enrolled, not professor/staff) and never writes', async () => {
    const client = createMockAdminClient({
      discussion_messages: { data: { id: 'm1', channel_id: 'c1', discussion_channels: { scope: 'course', section_id: 'sec-X' } }, error: null },
      enrollments: { data: null, error: null },
    })
    mockAdminClient.mockReturnValue(client)

    const res = await mod.toggleDiscussionReaction('m1', '👍')
    expect(res).toEqual({ error: 'Message not found' })
    expect(client._tableCalls).not.toContain('discussion_message_reactions')
  })

  it('rejects a team-channel non-team-member (even if section-enrolled) and never writes', async () => {
    const client = createMockAdminClient({
      discussion_messages: { data: { id: 'm1', channel_id: 'c1', discussion_channels: { scope: 'team', team_id: 'team-X' } }, error: null },
      project_members: { data: null, error: null },
      enrollments: { data: { id: 'e1' }, error: null }, // enrolled, but not on the team
    })
    mockAdminClient.mockReturnValue(client)

    const res = await mod.toggleDiscussionReaction('m1', '👍')
    expect(res).toEqual({ error: 'Message not found' })
    expect(client._tableCalls).not.toContain('discussion_message_reactions')
  })
})

describe('toggleProjectChatReaction — team membership', () => {
  it('rejects a non-team-member and never writes', async () => {
    const client = createMockAdminClient({
      project_chat_messages: { data: { id: 'm1', channel_id: 'c1', project_chat_channels: { team_id: 'team-X' } }, error: null },
      project_members: { data: null, error: null },
    })
    mockAdminClient.mockReturnValue(client)

    const res = await mod.toggleProjectChatReaction('m1', '👍')
    expect(res).toEqual({ error: 'Message not found' })
    expect(client._tableCalls).not.toContain('project_chat_message_reactions')
  })
})
