// Tests for the student-side course/team discussion server actions.
// Covers the two non-obvious gates that don't live in the professor
// variant: (1) the team-scope membership check inside sendDiscussionMessage,
// and (2) the author-only soft-delete — including the second team
// membership re-check that runs even for the original author so a
// student who left the team can't reach through to its messages.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown; count?: number }) {
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
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(finalResult).then(onFulfilled)
  return chain
}

// ── Module-Level Mocks ───────────────────────────────────────

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

// ── Action Handles ───────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let sendDiscussionMessage: any
let deleteDiscussionMessage: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import(
    '@/app/(dashboard)/student/courses/[sectionId]/discussions/actions'
  )
  sendDiscussionMessage = mod.sendDiscussionMessage
  deleteDiscussionMessage = mod.deleteDiscussionMessage
})

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

function mockAuthenticated(userId = 'student-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

// ── sendDiscussionMessage ────────────────────────────────────

describe('student.sendDiscussionMessage', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const r = await sendDiscussionMessage('ch-1', 'section-1', { content: 'hi' })
    expect(r.error).toBe('Not authenticated')
  })

  it('rejects callers not enrolled in the section', async () => {
    mockAuthenticated('student-1')
    // verifyEnrollment → no enrollment row
    const admin = { from: vi.fn(() => buildChain({ data: null, error: null })) }
    mockAdminClient.mockReturnValue(admin)
    const r = await sendDiscussionMessage('ch-1', 'section-1', { content: 'hi' })
    expect(r.error).toBe('Not enrolled in this course')
  })

  it('rejects channels that belong to a different section (defense-in-depth)', async () => {
    mockAuthenticated('student-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        // channel belongs to a DIFFERENT section
        return buildChain({
          data: {
            id: 'ch-1',
            section_id: 'section-OTHER',
            team_id: null,
            scope: 'course',
            status: 'active',
          },
          error: null,
        })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await sendDiscussionMessage('ch-1', 'section-1', { content: 'hi' })
    expect(r.error).toBe('Channel not in this section')
  })

  it('rejects messages into archived channels', async () => {
    mockAuthenticated('student-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        return buildChain({
          data: {
            id: 'ch-1',
            section_id: 'section-1',
            team_id: null,
            scope: 'course',
            status: 'archived',
          },
          error: null,
        })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await sendDiscussionMessage('ch-1', 'section-1', { content: 'hi' })
    expect(r.error).toBe('This channel is archived and read-only')
  })

  it('blocks non-team-members from writing to a team-scope channel', async () => {
    // An enrolled student who is NOT on the team should not be able to
    // speak in a team-scope discussion channel even if they know its id.
    mockAuthenticated('enrolled-but-not-on-team')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        if (call === 2) {
          return buildChain({
            data: {
              id: 'ch-1',
              section_id: 'section-1',
              team_id: 'team-A',
              scope: 'team',
              status: 'active',
            },
            error: null,
          })
        }
        // project_members → no membership
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await sendDiscussionMessage('ch-1', 'section-1', { content: 'hi' })
    expect(r.error).toBe('Not a member of this team')
  })
})

// ── deleteDiscussionMessage ─────────────────────────────────

describe('student.deleteDiscussionMessage', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const r = await deleteDiscussionMessage('msg-1', 'section-1')
    expect(r.error).toBe('Not authenticated')
  })

  it('rejects missing message id', async () => {
    mockAuthenticated('student-1')
    const r = await deleteDiscussionMessage('', 'section-1')
    expect(r.error).toBe('Missing message id')
  })

  it('rejects callers not enrolled in the section', async () => {
    mockAuthenticated('student-1')
    const admin = { from: vi.fn(() => buildChain({ data: null, error: null })) }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteDiscussionMessage('msg-1', 'section-1')
    expect(r.error).toBe('Not enrolled in this course')
  })

  it('returns Message not found when the id does not resolve', async () => {
    mockAuthenticated('student-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteDiscussionMessage('missing-id', 'section-1')
    expect(r.error).toBe('Message not found')
  })

  it('rejects messages whose channel belongs to a different section', async () => {
    mockAuthenticated('student-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        return buildChain({
          data: {
            id: 'msg-1',
            author_id: 'student-1',
            channel_id: 'ch-1',
            deleted_at: null,
            // channel lives in a different section — defence-in-depth
            discussion_channels: {
              section_id: 'section-OTHER',
              team_id: null,
              scope: 'course',
            },
          },
          error: null,
        })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteDiscussionMessage('msg-1', 'section-1')
    expect(r.error).toBe('Message not in this section')
  })

  it('blocks a student from deleting someone else\u2019s message (no moderation)', async () => {
    mockAuthenticated('not-the-author')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        return buildChain({
          data: {
            id: 'msg-1',
            author_id: 'another-student',
            channel_id: 'ch-1',
            deleted_at: null,
            discussion_channels: {
              section_id: 'section-1',
              team_id: null,
              scope: 'course',
            },
          },
          error: null,
        })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteDiscussionMessage('msg-1', 'section-1')
    expect(r.error).toBe('You can only delete your own messages')
  })

  it('is idempotent when the message is already soft-deleted', async () => {
    mockAuthenticated('student-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        return buildChain({
          data: {
            id: 'msg-1',
            author_id: 'student-1',
            channel_id: 'ch-1',
            deleted_at: '2026-04-10T00:00:00Z',
            discussion_channels: {
              section_id: 'section-1',
              team_id: null,
              scope: 'course',
            },
          },
          error: null,
        })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteDiscussionMessage('msg-1', 'section-1')
    expect(r.success).toBe(true)
  })

  it('blocks the original author from deleting a team-scope message after leaving the team', async () => {
    // Edge case unique to the student deleter: even if the row's
    // author_id matches the caller, we re-check team membership for
    // team-scope channels. A student who authored a message and later
    // left the team should lose the ability to retract it.
    mockAuthenticated('student-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        if (call === 2) {
          return buildChain({
            data: {
              id: 'msg-1',
              author_id: 'student-1', // still the author
              channel_id: 'ch-1',
              deleted_at: null,
              discussion_channels: {
                section_id: 'section-1',
                team_id: 'team-A',
                scope: 'team',
              },
            },
            error: null,
          })
        }
        // verifyTeamAccess → no membership (they left the team)
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteDiscussionMessage('msg-1', 'section-1')
    expect(r.error).toBe('Not a member of this team')
  })

  it('soft-deletes an author\u2019s own course-scope message and records deleted_by_id', async () => {
    const AUTHOR = 'student-1'
    mockAuthenticated(AUTHOR)
    let call = 0
    let updatedRow: Record<string, unknown> | null = null
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        if (call === 2) {
          return buildChain({
            data: {
              id: 'msg-1',
              author_id: AUTHOR,
              channel_id: 'ch-1',
              deleted_at: null,
              discussion_channels: {
                section_id: 'section-1',
                team_id: null,
                scope: 'course',
              },
            },
            error: null,
          })
        }
        const chain = buildChain({ data: null, error: null })
        chain.update = vi.fn((row: Record<string, unknown>) => {
          updatedRow = row
          return chain
        })
        return chain
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const r = await deleteDiscussionMessage('msg-1', 'section-1')
    expect(r.success).toBe(true)
    expect(updatedRow).not.toBeNull()
    expect(typeof updatedRow!.deleted_at).toBe('string')
    expect(updatedRow!.deleted_by_id).toBe(AUTHOR)
  })
})
