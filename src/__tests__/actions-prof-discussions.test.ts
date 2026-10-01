// Tests for professor/TA discussion server actions — authorization gating
// for the TA access model. TAs can manage course channels and send
// messages; graders are read-only for v1.

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
  chain.gt = vi.fn().mockReturnValue(chain)
  chain.then = undefined
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
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))

// ── Test Setup ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sendDiscussionMessage: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createCourseChannel: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let renameCourseChannel: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deleteCourseChannel: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deleteDiscussionMessage: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import(
    '@/app/(dashboard)/professor/courses/[sectionId]/discussions/actions'
  )
  sendDiscussionMessage = mod.sendDiscussionMessage
  createCourseChannel = mod.createCourseChannel
  renameCourseChannel = mod.renameCourseChannel
  deleteCourseChannel = mod.deleteCourseChannel
  deleteDiscussionMessage = mod.deleteDiscussionMessage
})

// ── Auth + Role helpers ──────────────────────────────────────

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'No user' } })
}

function mockAuthenticated(userId = 'prof-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

/** Stranger — section exists but caller is neither professor nor active staff. */
function mockNonAccessAdmin() {
  const admin = {
    from: vi.fn(() =>
      buildChain({ data: { id: 'section-1', professor_id: 'real-prof-id' }, error: null }),
    ),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

/** Caller is an active TA. */
function mockActiveTaAdmin() {
  let call = 0
  const admin = {
    from: vi.fn(() => {
      call++
      if (call === 1) {
        return buildChain({ data: { id: 'section-1', professor_id: 'real-prof-id' }, error: null })
      }
      if (call === 2) {
        return buildChain({ data: { role: 'ta' }, error: null })
      }
      // Subsequent calls (channel lookups, counts, etc.) return empty data
      // so the action reaches a benign end-state — we're only asserting
      // that the access gate didn't reject.
      return buildChain({ data: null, error: null, count: 0 })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

/** Caller is an active grader — read-only for v1. */
function mockActiveGraderAdmin() {
  let call = 0
  const admin = {
    from: vi.fn(() => {
      call++
      if (call === 1) {
        return buildChain({ data: { id: 'section-1', professor_id: 'real-prof-id' }, error: null })
      }
      return buildChain({ data: { role: 'grader' }, error: null })
    }),
  }
  mockAdminClient.mockReturnValue(admin)
  return admin
}

// ── sendDiscussionMessage ────────────────────────────────────

describe('sendDiscussionMessage', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await sendDiscussionMessage('chan-1', 'section-1', { content: 'hi' })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users without section access', async () => {
    mockAuthenticated('attacker-id')
    mockNonAccessAdmin()
    const result = await sendDiscussionMessage('chan-1', 'section-1', { content: 'hi' })
    expect(result.error).toBe('You do not have access to this section')
  })

  it('allows an active TA to send a message', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await sendDiscussionMessage('chan-1', 'section-1', { content: 'hi' })
    expect(result.error).not.toBe('You do not have access to this section')
    expect(result.error).not.toBe('You do not have permission to perform this action')
  })

  it('blocks a grader from sending messages', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await sendDiscussionMessage('chan-1', 'section-1', { content: 'hi' })
    expect(result.error).toBe('You do not have permission to perform this action')
  })
})

// ── createCourseChannel ──────────────────────────────────────

describe('createCourseChannel', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await createCourseChannel('section-1', { name: 'general' })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users without section access', async () => {
    mockAuthenticated('attacker-id')
    mockNonAccessAdmin()
    const result = await createCourseChannel('section-1', { name: 'general' })
    expect(result.error).toBe('You do not have access to this section')
  })

  it('allows an active TA to create a channel', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await createCourseChannel('section-1', { name: 'study-group' })
    expect(result.error).not.toBe('You do not have access to this section')
    expect(result.error).not.toBe('You do not have permission to perform this action')
  })

  it('blocks a grader from creating a channel', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await createCourseChannel('section-1', { name: 'general' })
    expect(result.error).toBe('You do not have permission to perform this action')
  })
})

// ── renameCourseChannel + deleteCourseChannel ────────────────

describe('renameCourseChannel / deleteCourseChannel', () => {
  it('blocks graders from renaming', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await renameCourseChannel('chan-1', 'section-1', { name: 'newname' })
    expect(result.error).toBe('You do not have permission to perform this action')
  })

  it('blocks graders from deleting', async () => {
    mockAuthenticated('grader-user-id')
    mockActiveGraderAdmin()
    const result = await deleteCourseChannel('chan-1', 'section-1')
    expect(result.error).toBe('You do not have permission to perform this action')
  })

  it('allows an active TA to rename', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await renameCourseChannel('chan-1', 'section-1', { name: 'renamed' })
    expect(result.error).not.toBe('You do not have permission to perform this action')
  })

  it('allows an active TA to delete', async () => {
    mockAuthenticated('ta-user-id')
    mockActiveTaAdmin()
    const result = await deleteCourseChannel('chan-1', 'section-1')
    expect(result.error).not.toBe('You do not have permission to perform this action')
  })

  // IDOR regression: a professor of section-1 must not rename/delete a channel
  // that belongs to another section (cross-tenant), even with valid access to
  // their own section. Guard: channel.section_id !== sectionId.
  it('blocks renaming a channel from another section (IDOR) and does not write', async () => {
    const PROF = 'prof-1'
    mockAuthenticated(PROF)
    let wrote = false
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        // call 1: verifySectionAccess → caller owns section-1
        if (call === 1) {
          return buildChain({ data: { id: 'section-1', professor_id: PROF }, error: null })
        }
        // call 2: channel lookup → channel belongs to a DIFFERENT section
        const chain = buildChain({
          data: { id: 'chan-1', section_id: 'section-OTHER', scope: 'course', is_default: false, name: 'x' },
          error: null,
        })
        chain.update = vi.fn(() => { wrote = true; return chain })
        chain.delete = vi.fn(() => { wrote = true; return chain })
        return chain
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await renameCourseChannel('chan-1', 'section-1', { name: 'renamed' })
    expect(result.error).toBe('Channel not found')
    expect(wrote).toBe(false)
  })

  it('blocks deleting a channel from another section (IDOR) and does not write', async () => {
    const PROF = 'prof-1'
    mockAuthenticated(PROF)
    let wrote = false
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) {
          return buildChain({ data: { id: 'section-1', professor_id: PROF }, error: null })
        }
        const chain = buildChain({
          data: { id: 'chan-1', section_id: 'section-OTHER', scope: 'course', is_default: false, name: 'x' },
          error: null,
        })
        chain.update = vi.fn(() => { wrote = true; return chain })
        chain.delete = vi.fn(() => { wrote = true; return chain })
        return chain
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await deleteCourseChannel('chan-1', 'section-1')
    expect(result.error).toBe('Channel not found')
    expect(wrote).toBe(false)
  })
})

// ── deleteDiscussionMessage (professor moderation) ───────────

describe('deleteDiscussionMessage (professor)', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const r = await deleteDiscussionMessage('msg-1', 'section-1')
    expect(r.error).toBe('Not authenticated')
  })

  it('rejects missing message id', async () => {
    mockAuthenticated()
    const r = await deleteDiscussionMessage('', 'section-1')
    expect(r.error).toBe('Missing message id')
  })

  it('rejects callers without section access', async () => {
    mockAuthenticated('attacker-id')
    mockNonAccessAdmin()
    const r = await deleteDiscussionMessage('msg-1', 'section-1')
    expect(r.error).toBe('You do not have access to this section')
  })

  it('lets a professor moderate another user\u2019s message', async () => {
    // verifySectionAccess → section → caller is professor_id; then the
    // action looks up the message; we want the delete to reach update.
    const PROF = 'prof-1'
    mockAuthenticated(PROF)
    let call = 0
    let updatedRow: Record<string, unknown> | null = null
    const admin = {
      from: vi.fn(() => {
        call++
        // verifySectionAccess: fetch section row
        if (call === 1) {
          return buildChain({ data: { id: 'section-1', professor_id: PROF }, error: null })
        }
        // message lookup with channel join
        if (call === 2) {
          return buildChain({
            data: {
              id: 'msg-1',
              author_id: 'student-id',
              channel_id: 'chan-1',
              deleted_at: null,
              discussion_channels: { section_id: 'section-1' },
            },
            error: null,
          })
        }
        // update
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
    expect(updatedRow!.deleted_by_id).toBe(PROF)
  })

  it('rejects messages from a different section (defense-in-depth)', async () => {
    const PROF = 'prof-1'
    mockAuthenticated(PROF)
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) {
          return buildChain({ data: { id: 'section-1', professor_id: PROF }, error: null })
        }
        return buildChain({
          data: {
            id: 'msg-1',
            author_id: 'student-id',
            channel_id: 'chan-1',
            deleted_at: null,
            // Channel belongs to a DIFFERENT section.
            discussion_channels: { section_id: 'section-OTHER' },
          },
          error: null,
        })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const r = await deleteDiscussionMessage('msg-1', 'section-1')
    expect(r.error).toBe('Message not in this section')
  })
})

