// Tests for the student project chat server actions. Focus on the
// new gates added in this redesign: ensureDefaultChannel project-shape
// checks, mention-id team-scoping inside sendMessage, and the HTML →
// plaintext excerpt used by getDocPreview for hover cards.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown; count?: number }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.is = vi.fn().mockReturnValue(chain)
  chain.filter = vi.fn().mockReturnValue(chain)
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
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))

// ── Action Handles ───────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let ensureDefaultChannel: any
let createChannel: any
let sendMessage: any
let getDocPreview: any
let deleteMessage: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import(
    '@/app/(dashboard)/student/courses/[sectionId]/projects/chat-actions'
  )
  ensureDefaultChannel = mod.ensureDefaultChannel
  createChannel = mod.createChannel
  sendMessage = mod.sendMessage
  getDocPreview = mod.getDocPreview
  deleteMessage = mod.deleteMessage
})

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

function mockAuthenticated(userId = 'user-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

// ── ensureDefaultChannel ─────────────────────────────────────

describe('ensureDefaultChannel', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await ensureDefaultChannel('team-1', 'section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects users not enrolled in the section', async () => {
    mockAuthenticated('user-1')
    // verifyEnrollment → no enrollment row
    const admin = { from: vi.fn(() => buildChain({ data: null, error: null })) }
    mockAdminClient.mockReturnValue(admin)
    const result = await ensureDefaultChannel('team-1', 'section-1')
    expect(result.error).toBe('Not enrolled in this course')
  })

  it('rejects non-members of the team', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null }) // enrollments
        // project_members → no role
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await ensureDefaultChannel('team-1', 'section-1')
    expect(result.error).toBe('Not a member of this team')
  })

  it('rejects solo projects (max_team_size <= 1)', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        if (call === 2) return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        // project_teams → solo project
        return buildChain({
          data: { id: 'team-1', project: { allow_team_workspace: true, max_team_size: 1 } },
          error: null,
        })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await ensureDefaultChannel('team-1', 'section-1')
    expect(result.error).toBe('Team chat is only available for group projects')
  })

  it('rejects projects with allow_team_workspace disabled', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        if (call === 2) return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        return buildChain({
          data: { id: 'team-1', project: { allow_team_workspace: false, max_team_size: 5 } },
          error: null,
        })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await ensureDefaultChannel('team-1', 'section-1')
    expect(result.error).toBe('Team chat is disabled for this project')
  })

  it('returns an error when the team has no linked project row', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        if (call === 2) return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        return buildChain({ data: { id: 'team-1', project: null }, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await ensureDefaultChannel('team-1', 'section-1')
    expect(result.error).toBe('Team not found')
  })
})

// ── deleteMessage (team chat) ────────────────────────────────

describe('deleteMessage (team chat)', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const r = await deleteMessage('msg-1', 'section-1')
    expect(r.error).toBe('Not authenticated')
  })

  it('rejects missing message id', async () => {
    mockAuthenticated()
    const r = await deleteMessage('', 'section-1')
    expect(r.error).toBe('Missing message id')
  })

  it('rejects callers not enrolled in the section', async () => {
    mockAuthenticated('user-1')
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteMessage('msg-1', 'section-1')
    expect(r.error).toBe('Not enrolled in this course')
  })

  it('blocks a non-author member from deleting a teammate\u2019s message', async () => {
    mockAuthenticated('member-id')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        // enrollments → enrolled
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        // message lookup with channel join
        if (call === 2) {
          return buildChain({
            data: {
              id: 'msg-1',
              author_id: 'teammate-id',
              channel_id: 'ch-1',
              deleted_at: null,
              project_chat_channels: { team_id: 'team-1' },
            },
            error: null,
          })
        }
        // project_members (verifyTeamAccess) → regular member
        return buildChain({ data: { id: 'm', role: 'member' }, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteMessage('msg-1', 'section-1')
    expect(r.error).toBe('You can only delete your own messages')
  })

  it('lets the author retract their own message', async () => {
    const AUTHOR = 'member-id'
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
              project_chat_channels: { team_id: 'team-1' },
            },
            error: null,
          })
        }
        if (call === 3) return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        const chain = buildChain({ data: null, error: null })
        chain.update = vi.fn((row: Record<string, unknown>) => {
          updatedRow = row
          return chain
        })
        return chain
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteMessage('msg-1', 'section-1')
    expect(r.success).toBe(true)
    expect(updatedRow).not.toBeNull()
    expect(updatedRow!.deleted_by_id).toBe(AUTHOR)
  })

  it('lets a team lead moderate a teammate\u2019s message', async () => {
    const LEAD = 'lead-id'
    mockAuthenticated(LEAD)
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
              author_id: 'teammate-id',
              channel_id: 'ch-1',
              deleted_at: null,
              project_chat_channels: { team_id: 'team-1' },
            },
            error: null,
          })
        }
        if (call === 3) return buildChain({ data: { id: 'm', role: 'lead' }, error: null })
        const chain = buildChain({ data: null, error: null })
        chain.update = vi.fn((row: Record<string, unknown>) => {
          updatedRow = row
          return chain
        })
        return chain
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteMessage('msg-1', 'section-1')
    expect(r.success).toBe(true)
    expect(updatedRow!.deleted_by_id).toBe(LEAD)
    // Soft-delete must scrub the body + attachments so a "deleted" message
    // is not recoverable by teammates via the REST payload or realtime
    // broadcast; deleted_at/deleted_by_id stay as the tombstone + audit.
    expect(updatedRow!.deleted_at).toEqual(expect.any(String))
    expect(updatedRow!.content).toBe('')
    expect(updatedRow!.attachment_url).toBeNull()
    expect(updatedRow!.attachment_path).toBeNull()
    expect(updatedRow!.attachment_name).toBeNull()
    expect(updatedRow!.attachment_size).toBeNull()
    expect(updatedRow!.attachment_type).toBeNull()
  })

  it('cascade-deletes chat_mention notifications by message_id', async () => {
    const AUTHOR = 'member-id'
    mockAuthenticated(AUTHOR)
    let deleteCall: { kind?: unknown; messageId?: unknown } | null = null
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') {
          return buildChain({ data: { id: 'enr' }, error: null })
        }
        if (table === 'project_chat_messages') {
          // Both the SELECT lookup and the UPDATE soft-delete go through
          // this branch; the action reads from `data` on the SELECT and
          // discards the response on the UPDATE.
          return buildChain({
            data: {
              id: 'msg-1',
              author_id: AUTHOR,
              channel_id: 'ch-1',
              deleted_at: null,
              project_chat_channels: { team_id: 'team-1' },
            },
            error: null,
          })
        }
        if (table === 'project_members') {
          return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        }
        // app_notifications \u2014 capture the cascade-delete filter args.
        const chain = buildChain({ data: null, error: null })
        chain.delete = vi.fn(() => {
          deleteCall = {}
          return chain
        })
        chain.eq = vi.fn((col: string, val: unknown) => {
          if (col === 'kind') deleteCall = { ...(deleteCall ?? {}), kind: val }
          return chain
        })
        chain.filter = vi.fn((col: string, op: string, val: unknown) => {
          if (col === 'metadata->>message_id' && op === 'eq') {
            deleteCall = { ...(deleteCall ?? {}), messageId: val }
          }
          return chain
        })
        return chain
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteMessage('msg-1', 'section-1')
    expect(r.success).toBe(true)
    expect(deleteCall).not.toBeNull()
    expect(deleteCall!.kind).toBe('chat_mention')
    expect(deleteCall!.messageId).toBe('msg-1')
  })

  it('still reports success when notification cleanup fails', async () => {
    const AUTHOR = 'member-id'
    mockAuthenticated(AUTHOR)
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') {
          return buildChain({ data: { id: 'enr' }, error: null })
        }
        if (table === 'project_chat_messages') {
          return buildChain({
            data: {
              id: 'msg-1',
              author_id: AUTHOR,
              channel_id: 'ch-1',
              deleted_at: null,
              project_chat_channels: { team_id: 'team-1' },
            },
            error: null,
          })
        }
        if (table === 'project_members') {
          return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        }
        return buildChain({ data: null, error: { message: 'simulated cleanup failure' } })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteMessage('msg-1', 'section-1')
    expect(r.success).toBe(true)
    expect(r.error).toBeUndefined()
  })
})

// ── createChannel ────────────────────────────────────────────

describe('createChannel', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await createChannel('team-1', 'section-1', { name: 'tips' })
    expect(result.error).toBe('Not authenticated')
  })

  it('allows any team member to create a channel (no role gating)', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const insertChain = buildChain({ data: { id: 'ch-new', name: 'tips' }, error: null })
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        // Even the lowest project-role should not be blocked here.
        if (call === 2) return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        // count query → below cap
        if (call === 3) return buildChain({ data: null, error: null, count: 1 })
        // duplicate-name check → no dup
        if (call === 4) return buildChain({ data: null, error: null })
        // insert
        return insertChain
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await createChannel('team-1', 'section-1', { name: 'tips' })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ id: 'ch-new', name: 'tips' })
  })

  it('rejects when the channel count has hit MAX_CHANNELS_PER_TEAM', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        if (call === 2) return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        // already at cap
        return buildChain({ data: null, error: null, count: 10 })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await createChannel('team-1', 'section-1', { name: 'tips' })
    expect(result.error).toBe('Maximum 10 channels per team')
  })

  it('rejects duplicate channel names within a team', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'enr' }, error: null })
        if (call === 2) return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        if (call === 3) return buildChain({ data: null, error: null, count: 1 })
        // duplicate found
        return buildChain({ data: { id: 'existing' }, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await createChannel('team-1', 'section-1', { name: 'tips' })
    expect(result.error).toBe('A channel with this name already exists')
  })
})

// ── sendMessage — mention team-scoping ───────────────────────

describe('sendMessage mention verification', () => {
  /**
   * Simulate: enrollment OK → channel lookup → team-member check →
   * mentioned_user filter query → mentioned_phase filter query →
   * mentioned_doc filter query → insert message → profile lookup →
   * notification fanout.
   *
   * We stub each of these in-order with buildChain so the action
   * reaches the insert step and we can assert what it persisted.
   */
  it('filters mentioned_user_ids to the caller’s team (drops foreign uuids and self-mention)', async () => {
    // Use valid v4 UUIDs — the Zod schema on sendMessageSchema rejects
    // malformed UUIDs at the input-validation step, so we'd never reach
    // the mention-filter logic with fake ids.
    const SELF = '11111111-1111-4111-8111-111111111111'
    const MEMBER_USER = '22222222-2222-4222-8222-222222222222'
    const FOREIGN_USER = '33333333-3333-4333-8333-333333333333'
    mockAuthenticated(SELF)

    const CHANNEL_ID = 'ch-1'
    const TEAM_ID = 'team-1'
    const SECTION_ID = 'section-1'

    const insertChain = buildChain({ data: { id: 'msg-1' }, error: null })
    let call = 0
    const admin = {
      from: vi.fn((table: string) => {
        call++
        if (table === 'enrollments') return buildChain({ data: { id: 'enr' }, error: null })
        if (table === 'project_chat_channels' && call === 2) {
          // channel lookup
          return buildChain({ data: { id: CHANNEL_ID, team_id: TEAM_ID, name: 'general' }, error: null })
        }
        if (table === 'project_members' && call === 3) {
          // verifyTeamAccess
          return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        }
        if (table === 'project_members') {
          // filtered mentioned_user_ids — ONLY the member survives
          return buildChain({ data: [{ user_id: MEMBER_USER }], error: null })
        }
        if (table === 'project_chat_messages') return insertChain
        if (table === 'profiles') {
          return buildChain({ data: { name: 'Alice', email: 'a@a.com' }, error: null })
        }
        if (table === 'app_notifications') return buildChain({ data: null, error: null })
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await sendMessage(CHANNEL_ID, SECTION_ID, {
      content: 'hello',
      mentioned_user_ids: [FOREIGN_USER, MEMBER_USER, SELF],
      mentioned_phase_ids: [],
      mentioned_doc_ids: [],
    })

    expect(result.success).toBe(true)
    const insertFn = insertChain.insert as ReturnType<typeof vi.fn>
    const inserted = insertFn.mock.calls[0][0]
    // Self-mention dropped; foreign UUID dropped; only the real team member remains.
    expect(inserted.mentioned_user_ids).toEqual([MEMBER_USER])
    expect(inserted.mentioned_phase_ids).toEqual([])
    expect(inserted.mentioned_doc_ids).toEqual([])
  })

  it('filters mentioned_phase_ids to phases that belong to the channel team', async () => {
    mockAuthenticated('11111111-1111-4111-8111-111111111111')
    const TEAM_ID = 'team-1'
    const SECTION_ID = 'section-1'
    const REAL_PHASE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001'
    const FOREIGN_PHASE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0999'

    const insertChain = buildChain({ data: { id: 'msg-1' }, error: null })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') return buildChain({ data: { id: 'enr' }, error: null })
        if (table === 'project_chat_channels') {
          return buildChain({ data: { id: 'ch-1', team_id: TEAM_ID, name: 'general' }, error: null })
        }
        if (table === 'project_members') {
          return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        }
        if (table === 'project_phases') {
          // Only REAL_PHASE is in the team
          return buildChain({ data: [{ id: REAL_PHASE }], error: null })
        }
        if (table === 'project_chat_messages') return insertChain
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await sendMessage('ch-1', SECTION_ID, {
      content: 'see @phase',
      mentioned_user_ids: [],
      mentioned_phase_ids: [REAL_PHASE, FOREIGN_PHASE],
      mentioned_doc_ids: [],
    })

    expect(result.success).toBe(true)
    const inserted = (insertChain.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(inserted.mentioned_phase_ids).toEqual([REAL_PHASE])
  })

  it('filters mentioned_doc_ids to docs that belong to the channel team', async () => {
    mockAuthenticated('11111111-1111-4111-8111-111111111111')
    const TEAM_ID = 'team-1'
    const SECTION_ID = 'section-1'
    const REAL_DOC = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffff0001'
    const FOREIGN_DOC = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffff0999'

    const insertChain = buildChain({ data: { id: 'msg-1' }, error: null })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') return buildChain({ data: { id: 'enr' }, error: null })
        if (table === 'project_chat_channels') {
          return buildChain({ data: { id: 'ch-1', team_id: TEAM_ID, name: 'general' }, error: null })
        }
        if (table === 'project_members') {
          return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        }
        if (table === 'project_docs') {
          return buildChain({ data: [{ id: REAL_DOC }], error: null })
        }
        if (table === 'project_chat_messages') return insertChain
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await sendMessage('ch-1', SECTION_ID, {
      content: 'see @doc',
      mentioned_user_ids: [],
      mentioned_phase_ids: [],
      mentioned_doc_ids: [REAL_DOC, FOREIGN_DOC],
    })

    expect(result.success).toBe(true)
    const inserted = (insertChain.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(inserted.mentioned_doc_ids).toEqual([REAL_DOC])
  })

  it('still succeeds when notification fanout fails (best-effort)', async () => {
    mockAuthenticated('11111111-1111-4111-8111-111111111111')
    const TEAM_ID = 'team-1'
    const MEMBER_USER = '22222222-2222-4222-8222-222222222222'

    const insertChain = buildChain({ data: { id: 'msg-1' }, error: null })
    let membersCall = 0
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') return buildChain({ data: { id: 'enr' }, error: null })
        if (table === 'project_chat_channels') {
          return buildChain({ data: { id: 'ch-1', team_id: TEAM_ID, name: 'general' }, error: null })
        }
        if (table === 'project_members') {
          membersCall++
          // 1st hit = verifyTeamAccess (single object expected)
          // 2nd hit = mention filter (array expected)
          if (membersCall === 1) {
            return buildChain({ data: { id: 'm', role: 'member' }, error: null })
          }
          return buildChain({ data: [{ user_id: MEMBER_USER }], error: null })
        }
        if (table === 'project_chat_messages') return insertChain
        if (table === 'profiles') {
          return buildChain({ data: { name: 'Alice', email: 'a@a.com' }, error: null })
        }
        if (table === 'app_notifications') {
          // Notification insert fails — MUST NOT fail the send.
          return buildChain({ data: null, error: { message: 'permission denied' } })
        }
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await sendMessage('ch-1', 'section-1', {
      content: 'hi',
      mentioned_user_ids: [MEMBER_USER],
      mentioned_phase_ids: [],
      mentioned_doc_ids: [],
    })

    // Critical: fanout failure does not surface as an action error.
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })
})

// ── getDocPreview — HTML → plain-text excerpt ────────────────

describe('getDocPreview', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getDocPreview('doc-1', 'section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('strips HTML tags and truncates to the 280-char cap', async () => {
    mockAuthenticated('user-1')
    // 500 chars of text wrapped in tags + a script block that should be stripped
    const filler = 'Lorem ipsum dolor sit amet. '.repeat(30)
    const html = `<script>alert(1)</script><p><strong>${filler}</strong></p>`

    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') return buildChain({ data: { id: 'enr' }, error: null })
        if (table === 'project_docs') {
          return buildChain({
            data: {
              id: 'doc-1',
              team_id: 'team-1',
              title: 'Roadmap',
              content: { format: 'html', html },
              is_pinned: true,
              updated_at: '2026-04-10',
            },
            error: null,
          })
        }
        if (table === 'project_members') {
          return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        }
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await getDocPreview('doc-1', 'section-1')
    expect(result.data).toBeDefined()
    const preview = result.data!
    expect(preview.title).toBe('Roadmap')
    expect(preview.is_pinned).toBe(true)
    // Script content is stripped
    expect(preview.excerpt.toLowerCase()).not.toContain('alert')
    // No raw HTML tags survive
    expect(preview.excerpt).not.toMatch(/<[^>]+>/)
    // Truncated to <=280 chars (with ellipsis suffix allowed)
    expect(preview.excerpt.length).toBeLessThanOrEqual(280)
  })

  it('returns empty excerpt for malformed content', async () => {
    mockAuthenticated('user-1')
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') return buildChain({ data: { id: 'enr' }, error: null })
        if (table === 'project_docs') {
          return buildChain({
            data: {
              id: 'doc-1',
              team_id: 'team-1',
              title: 'Empty',
              content: null,
              is_pinned: false,
              updated_at: '2026-04-10',
            },
            error: null,
          })
        }
        if (table === 'project_members') {
          return buildChain({ data: { id: 'm', role: 'member' }, error: null })
        }
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await getDocPreview('doc-1', 'section-1')
    expect(result.data?.excerpt).toBe('')
  })

  it('rejects non-members even when the doc exists', async () => {
    mockAuthenticated('user-1')
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'enrollments') return buildChain({ data: { id: 'enr' }, error: null })
        if (table === 'project_docs') {
          return buildChain({
            data: {
              id: 'doc-1', team_id: 'team-1', title: 't',
              content: { format: 'html', html: '' }, is_pinned: false, updated_at: 'x',
            },
            error: null,
          })
        }
        // non-member
        if (table === 'project_members') return buildChain({ data: null, error: null })
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await getDocPreview('doc-1', 'section-1')
    expect(result.error).toBe('Not a member of this team')
  })
})
