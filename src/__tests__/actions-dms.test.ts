// Tests for the direct-message server actions. Covers auth, pair
// sorting, self-DM block, target-exists guard, participant gate on
// sendDmMessage, and the access gates for the People pickers.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown; count?: number }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.is = vi.fn().mockReturnValue(chain)
  chain.gt = vi.fn().mockReturnValue(chain)
  chain.or = vi.fn().mockReturnValue(chain)
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
let openOrCreateDm: any
let sendDmMessage: any
let listSectionPeople: any
let listTeamPeople: any
let deleteDmMessage: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import('@/app/(dashboard)/dms/actions')
  openOrCreateDm = mod.openOrCreateDm
  sendDmMessage = mod.sendDmMessage
  listSectionPeople = mod.listSectionPeople
  listTeamPeople = mod.listTeamPeople
  deleteDmMessage = mod.deleteDmMessage
})

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

function mockAuthenticated(userId = 'aaaa0000-0000-0000-0000-000000000001') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

// ── openOrCreateDm ───────────────────────────────────────────

describe('openOrCreateDm', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const r = await openOrCreateDm('bbbb0000-0000-0000-0000-000000000002')
    expect(r.error).toBe('Not authenticated')
  })

  it('rejects missing otherUserId', async () => {
    mockAuthenticated()
    const r = await openOrCreateDm('')
    expect(r.error).toBe('Missing user id')
  })

  it('blocks self-DM', async () => {
    const me = 'aaaa0000-0000-0000-0000-000000000001'
    mockAuthenticated(me)
    const r = await openOrCreateDm(me)
    expect(r.error).toBe('Cannot DM yourself')
  })

  it('rejects when target profile does not exist', async () => {
    mockAuthenticated()
    // profiles lookup returns null
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await openOrCreateDm('cccc0000-0000-0000-0000-000000000003')
    expect(r.error).toBe('User not found')
  })

  it('returns an existing channel when the pair already has one', async () => {
    mockAuthenticated('aaaa0000-0000-0000-0000-000000000001')
    /* Table-aware rather than call-indexed: openOrCreateDm now verifies the pair shares a
       course or team before writing (#679), which adds queries and would shift any
       positional stub. Both users are enrolled in the same section here, i.e. a
       legitimate DM. */
    const SHARED_SECTION = 'sec-shared'
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'profiles') {
          return buildChain({ data: { id: 'cccc0000-0000-0000-0000-000000000003' }, error: null })
        }
        if (table === 'enrollments') {
          return buildChain({ data: [{ section_id: SHARED_SECTION }], error: null })
        }
        if (table === 'course_sections' || table === 'section_staff' || table === 'project_members') {
          return buildChain({ data: [], error: null })
        }
        // dm_channels select → existing row
        return buildChain({ data: { id: 'chan-existing' }, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await openOrCreateDm('cccc0000-0000-0000-0000-000000000003')
    expect(r.error).toBeUndefined()
    expect(r.data?.channelId).toBe('chan-existing')
  })

  it('creates a new channel with sorted pair when none exists', async () => {
    // Caller UUID is larger than target so sorted pair is (target, caller).
    const me = 'zzzz0000-0000-0000-0000-000000000009'
    const target = 'aaaa0000-0000-0000-0000-000000000001'
    mockAuthenticated(me)
    let insertedRow: Record<string, unknown> | null = null
    // Table-aware for the same reason as above (#679) — the eligibility check adds
    // queries. Shared team here rather than a shared course, exercising the other half
    // of the rule.
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'profiles') return buildChain({ data: { id: target }, error: null })
        if (table === 'project_members') return buildChain({ data: [{ team_id: 'team-shared' }], error: null })
        if (table === 'enrollments' || table === 'course_sections' || table === 'section_staff') {
          return buildChain({ data: [], error: null })
        }
        if (table === 'dm_channels') {
          const chain = buildChain({ data: { id: 'chan-new' }, error: null })
          // The select-for-existing must miss, then the insert lands.
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
          chain.insert = vi.fn((row: Record<string, unknown>) => {
            insertedRow = row
            chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'chan-new' }, error: null })
            return chain
          })
          return chain
        }
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const r = await openOrCreateDm(target)
    expect(r.error).toBeUndefined()
    expect(r.data?.channelId).toBe('chan-new')
    expect(insertedRow).not.toBeNull()
    // Sorted so user_a_id < user_b_id regardless of who called.
    expect(insertedRow!.user_a_id).toBe(target)
    expect(insertedRow!.user_b_id).toBe(me)
  })

  it('refuses a target who shares no course or team (#679)', async () => {
    /* The reported exposure: replaying this action with an arbitrary institution user's id
       created a channel — proven against an ADMIN account with zero shared enrollments.
       The read paths (listSectionPeople / listTeamPeople) already scoped who is OFFERED;
       only the write was unguarded, and the client is untrusted. */
    mockAuthenticated('aaaa0000-0000-0000-0000-000000000001')
    let insertAttempted = false
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'profiles') {
          // The target is a REAL user — that is the whole point of the attack.
          return buildChain({ data: { id: 'cccc0000-0000-0000-0000-000000000003' }, error: null })
        }
        if (table === 'dm_channels') {
          const chain = buildChain({ data: null, error: null })
          chain.insert = vi.fn(() => {
            insertAttempted = true
            return chain
          })
          return chain
        }
        // No shared sections, no shared teams.
        return buildChain({ data: [], error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const r = await openOrCreateDm('cccc0000-0000-0000-0000-000000000003')

    expect(r.data).toBeUndefined()
    expect(insertAttempted).toBe(false)
    /* Same wording as a nonexistent profile, deliberately: a distinct message would
       confirm whether an arbitrary id is a real account. */
    expect(r.error).toBe('User not found')
  })
})

// ── sendDmMessage ─────────────────────────────────────────────

describe('sendDmMessage', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const r = await sendDmMessage('chan-1', { content: 'hi' })
    expect(r.error).toBe('Not authenticated')
  })

  it('rejects invalid input (no text and no attachment)', async () => {
    mockAuthenticated()
    const r = await sendDmMessage('chan-1', { content: '' })
    expect(typeof r.error).toBe('string')
    expect(r.error!.startsWith('Invalid input')).toBe(true)
  })

  it('rejects when the channel is not found', async () => {
    mockAuthenticated()
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await sendDmMessage('chan-missing', { content: 'hi' })
    expect(r.error).toBe('DM not found')
  })

  it('blocks non-participants from sending', async () => {
    mockAuthenticated('attacker-id')
    const admin = {
      from: vi.fn(() =>
        buildChain({
          data: { id: 'chan-1', user_a_id: 'user-a', user_b_id: 'user-b' },
          error: null,
        }),
      ),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await sendDmMessage('chan-1', { content: 'hi' })
    expect(r.error).toBe('Not a participant in this DM')
  })

  it('allows a participant to send a message', async () => {
    mockAuthenticated('user-a')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) {
          return buildChain({
            data: { id: 'chan-1', user_a_id: 'user-a', user_b_id: 'user-b' },
            error: null,
          })
        }
        // dm_messages insert → returns new id
        if (call === 2) return buildChain({ data: { id: 'msg-1' }, error: null })
        // app_notifications insert → best-effort; no error
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await sendDmMessage('chan-1', { content: 'hi' })
    expect(r.success).toBe(true)
  })

  it('writes message_id into the recipient notification metadata', async () => {
    mockAuthenticated('user-a')
    let call = 0
    let notifRow: Record<string, unknown> | null = null
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) {
          return buildChain({
            data: { id: 'chan-1', user_a_id: 'user-a', user_b_id: 'user-b' },
            error: null,
          })
        }
        if (call === 2) return buildChain({ data: { id: 'msg-1' }, error: null })
        const chain = buildChain({ data: null, error: null })
        chain.insert = vi.fn((row: Record<string, unknown>) => {
          notifRow = row
          return chain
        })
        return chain
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await sendDmMessage('chan-1', { content: 'hi' })
    expect(r.success).toBe(true)
    expect(notifRow).not.toBeNull()
    expect(notifRow!.kind).toBe('dm')
    const metadata = notifRow!.metadata as Record<string, unknown>
    expect(metadata.message_id).toBe('msg-1')
    expect(metadata.channel_id).toBe('chan-1')
    expect(metadata.author_id).toBe('user-a')

    /* #693: the notification told a student they had a message and then stranded them,
       because both of these were null. actor_id renders the sender instead of a generic
       avatar; link_url makes the row clickable.

       The link points at the /dms RESOLVER rather than a discussions URL on purpose. A
       DM is global while the pane is section-scoped, so the destination depends on which
       course the pair still shares, the RECIPIENT's role there, and whether discussions
       is switched on — all of which can change after this row is written. Asserting the
       resolver form is therefore the point: a literal course URL here would be the bug. */
    expect(notifRow!.actor_id).toBe('user-a')
    expect(notifRow!.link_url).toBe('/dms?c=chan-1')
  })
})

// ── deleteDmMessage ──────────────────────────────────────────

describe('deleteDmMessage', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const r = await deleteDmMessage('msg-1')
    expect(r.error).toBe('Not authenticated')
  })

  it('rejects missing message id', async () => {
    mockAuthenticated()
    const r = await deleteDmMessage('')
    expect(r.error).toBe('Missing message id')
  })

  it('rejects when message does not exist', async () => {
    mockAuthenticated('user-a')
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteDmMessage('msg-missing')
    expect(r.error).toBe('Message not found')
  })

  it('blocks non-authors from deleting', async () => {
    mockAuthenticated('attacker-id')
    const admin = {
      from: vi.fn(() =>
        buildChain({
          data: { id: 'msg-1', author_id: 'victim-id', channel_id: 'chan-1', deleted_at: null },
          error: null,
        }),
      ),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteDmMessage('msg-1')
    expect(r.error).toBe('You can only delete your own messages')
  })

  it('is idempotent when already deleted', async () => {
    mockAuthenticated('user-a')
    const admin = {
      from: vi.fn(() =>
        buildChain({
          data: {
            id: 'msg-1',
            author_id: 'user-a',
            channel_id: 'chan-1',
            deleted_at: '2026-04-01T00:00:00Z',
          },
          error: null,
        }),
      ),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteDmMessage('msg-1')
    expect(r.success).toBe(true)
  })

  it('soft-deletes a message the caller authored', async () => {
    mockAuthenticated('user-a')
    let call = 0
    let updatedRow: Record<string, unknown> | null = null
    const admin = {
      from: vi.fn((table: string) => {
        call++
        if (call === 1) {
          return buildChain({
            data: { id: 'msg-1', author_id: 'user-a', channel_id: 'chan-1', deleted_at: null },
            error: null,
          })
        }
        if (table === 'dm_messages') {
          const chain = buildChain({ data: null, error: null })
          chain.update = vi.fn((row: Record<string, unknown>) => {
            updatedRow = row
            return chain
          })
          return chain
        }
        // app_notifications cleanup — best-effort, no error
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteDmMessage('msg-1')
    expect(r.success).toBe(true)
    expect(updatedRow).not.toBeNull()
    expect(typeof updatedRow!.deleted_at).toBe('string')
    expect(updatedRow!.deleted_by_id).toBe('user-a')
  })

  it('cascade-deletes the recipient app_notifications row by message_id', async () => {
    mockAuthenticated('user-a')
    let deleteCall: { kind?: unknown; messageId?: unknown } | null = null
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'dm_messages') {
          // First call: lookup the message. Subsequent calls on this
          // table are the soft-delete update, which we don't need to
          // distinguish here.
          return buildChain({
            data: { id: 'msg-1', author_id: 'user-a', channel_id: 'chan-1', deleted_at: null },
            error: null,
          })
        }
        // app_notifications: capture the cascade-delete filters.
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
    const r = await deleteDmMessage('msg-1')
    expect(r.success).toBe(true)
    expect(deleteCall).not.toBeNull()
    expect(deleteCall!.kind).toBe('dm')
    expect(deleteCall!.messageId).toBe('msg-1')
  })

  it('still reports success when notification cleanup fails', async () => {
    mockAuthenticated('user-a')
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'dm_messages') {
          return buildChain({
            data: { id: 'msg-1', author_id: 'user-a', channel_id: 'chan-1', deleted_at: null },
            error: null,
          })
        }
        // app_notifications cleanup returns an error — must not roll back.
        return buildChain({ data: null, error: { message: 'simulated cleanup failure' } })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await deleteDmMessage('msg-1')
    expect(r.success).toBe(true)
    expect(r.error).toBeUndefined()
  })
})

// ── listSectionPeople ─────────────────────────────────────────

describe('listSectionPeople', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const r = await listSectionPeople('section-1')
    expect(r.error).toBe('Not authenticated')
  })

  it('rejects when the section does not exist', async () => {
    mockAuthenticated()
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await listSectionPeople('missing')
    expect(r.error).toBe('Section not found')
  })

  it('rejects non-enrolled non-professor callers', async () => {
    mockAuthenticated('stranger-id')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        // section
        if (call === 1)
          return buildChain({ data: { id: 'section-1', professor_id: 'prof-x' }, error: null })
        // enrollment → none
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await listSectionPeople('section-1')
    expect(r.error).toBe('Not enrolled in this section')
  })

  it('returns people for the professor of the section', async () => {
    const prof = 'prof-x'
    mockAuthenticated(prof)
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1)
          return buildChain({ data: { id: 'section-1', professor_id: prof }, error: null })
        // enrollments
        if (call === 2)
          return buildChain({
            data: [
              {
                student_id: 'stu-1',
                profile: { id: 'stu-1', name: 'Ada', email: 'ada@x.com', avatar_url: null },
              },
            ],
            error: null,
          })
        // professor profile (filtered out because === caller)
        if (call === 3)
          return buildChain({
            data: { id: prof, name: 'Prof', email: 'prof@x.com', avatar_url: null },
            error: null,
          })
        // section_staff — no TAs/graders on this section. Must be an ARRAY:
        // listSectionPeople iterates it, so an object here throws and the
        // action's catch turns it into a generic 'Something went wrong'.
        return buildChain({ data: [], error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await listSectionPeople('section-1')
    expect(r.error).toBeUndefined()
    expect(r.data?.length).toBe(1)
    expect(r.data?.[0].id).toBe('stu-1')
  })
})

// ── listTeamPeople ───────────────────────────────────────────

describe('listTeamPeople', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const r = await listTeamPeople('team-1')
    expect(r.error).toBe('Not authenticated')
  })

  it('rejects non-members of the team', async () => {
    mockAuthenticated('stranger')
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await listTeamPeople('team-1')
    expect(r.error).toBe('Not a team member')
  })

  it('returns teammates excluding the caller', async () => {
    mockAuthenticated('me-id')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'member-row' }, error: null })
        // members list
        return buildChain({
          data: [
            {
              user_id: 'me-id',
              role: 'member',
              profile: { id: 'me-id', name: 'Me', email: 'me@x.com', avatar_url: null },
            },
            {
              user_id: 'you',
              role: 'lead',
              profile: { id: 'you', name: 'You', email: 'you@x.com', avatar_url: null },
            },
          ],
          error: null,
        })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const r = await listTeamPeople('team-1')
    expect(r.error).toBeUndefined()
    expect(r.data?.length).toBe(1)
    expect(r.data?.[0].id).toBe('you')
    expect(r.data?.[0].role).toBe('lead')
  })
})
