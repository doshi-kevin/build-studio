// Tests for the student project_docs (multi-canvas) server actions.
// Focus: auth gating, team-membership enforcement, pinned-doc delete
// guard, and the position-assignment rule for createDoc.

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
  chain.then = undefined
  return chain
}

// Thenable chain — used when the action awaits the query directly
// (without .single()/.maybeSingle()). For example, the order/limit
// chain inside createDoc or listTeamDocs.
function buildThenable(finalResult: { data: unknown; error: unknown }) {
  const chain = buildChain(finalResult)
  ;(chain as Record<string, unknown>).then = (
    onFulfilled: (v: unknown) => unknown,
  ) => Promise.resolve(finalResult).then(onFulfilled)
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
vi.mock('@/lib/chat/system-messages', () => ({
  emitSystemMessage: vi.fn().mockResolvedValue(undefined),
}))

// ── Action Handles ───────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let listTeamDocs: any
let getDoc: any
let createDoc: any
let updateDocTitle: any
let updateDocContent: any
let deleteDoc: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import(
    '@/app/(dashboard)/student/courses/[sectionId]/projects/docs-actions'
  )
  listTeamDocs = mod.listTeamDocs
  getDoc = mod.getDoc
  createDoc = mod.createDoc
  updateDocTitle = mod.updateDocTitle
  updateDocContent = mod.updateDocContent
  deleteDoc = mod.deleteDoc
})

// ── Auth helpers ─────────────────────────────────────────────

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

function mockAuthenticated(userId = 'user-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

// ── listTeamDocs ─────────────────────────────────────────────

describe('listTeamDocs', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await listTeamDocs('team-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-members of the team', async () => {
    mockAuthenticated('user-1')
    const admin = {
      from: vi.fn(() =>
        // verifyTeamMembership → project_members.maybeSingle returns null
        buildChain({ data: null, error: null }),
      ),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await listTeamDocs('team-1')
    expect(result.error).toBe('Not a team member')
  })

  it('returns docs for a verified team member', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) {
          // project_members membership check
          return buildChain({ data: { id: 'member-1' }, error: null })
        }
        // project_docs list — awaited directly (thenable chain)
        return buildThenable({
          data: [
            { id: 'd1', title: 'Planning', is_pinned: true, position: 0, updated_at: 't', updated_by: null },
          ],
          error: null,
        })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await listTeamDocs('team-1')
    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(1)
  })
})

// ── getDoc ───────────────────────────────────────────────────

describe('getDoc', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await getDoc('doc-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('returns doc-not-found when the doc lookup errors', async () => {
    mockAuthenticated('user-1')
    const admin = {
      from: vi.fn(() =>
        buildChain({ data: null, error: { message: 'not found' } }),
      ),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await getDoc('doc-1')
    expect(result.error).toBe('Doc not found')
  })

  it('rejects callers who are not members of the doc team', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) {
          // project_docs.single
          return buildChain({
            data: { id: 'doc-1', team_id: 'team-1', title: 't', content: null, is_pinned: false, position: 1, created_by: 'other', updated_by: null, updated_at: 'now' },
            error: null,
          })
        }
        // project_members.maybeSingle → non-member
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await getDoc('doc-1')
    expect(result.error).toBe('Not a team member')
  })
})

// ── createDoc ────────────────────────────────────────────────

describe('createDoc', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await createDoc('team-1', 'section-1', { title: 'Spec' })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects non-members', async () => {
    mockAuthenticated('user-1')
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await createDoc('team-1', 'section-1', { title: 'Spec' })
    expect(result.error).toBe('Not a team member')
  })

  it('assigns position 1 when only the pinned (position 0) Planning doc exists', async () => {
    mockAuthenticated('user-1')
    const insertChain = buildChain({ data: { id: 'new-doc' }, error: null })
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) {
          // project_members membership
          return buildChain({ data: { id: 'm-1' }, error: null })
        }
        if (call === 2) {
          // highest-position query — returns the pinned doc at position 0
          return buildThenable({ data: [{ position: 0 }], error: null })
        }
        // insert().select('id').single()
        return insertChain
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await createDoc('team-1', 'section-1', { title: 'Spec' })
    expect(result.success).toBe(true)
    // verify that the insert payload used position 1 (pinned is 0)
    const insertFn = insertChain.insert as ReturnType<typeof vi.fn>
    expect(insertFn).toHaveBeenCalledTimes(1)
    const inserted = insertFn.mock.calls[0][0]
    expect(inserted.position).toBe(1)
    expect(inserted.title).toBe('Spec')
    expect(inserted.is_pinned).toBe(false)
    expect(inserted.team_id).toBe('team-1')
    expect(inserted.created_by).toBe('user-1')
  })

  it('increments position above the highest existing non-pinned doc', async () => {
    mockAuthenticated('user-1')
    const insertChain = buildChain({ data: { id: 'new-doc' }, error: null })
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'm-1' }, error: null })
        if (call === 2) return buildThenable({ data: [{ position: 5 }], error: null })
        return insertChain
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await createDoc('team-1', 'section-1', { title: 'Next' })
    expect(result.success).toBe(true)
    const inserted = (insertChain.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(inserted.position).toBe(6)
  })

  it('defaults to position 1 when no docs exist yet', async () => {
    mockAuthenticated('user-1')
    const insertChain = buildChain({ data: { id: 'new-doc' }, error: null })
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) return buildChain({ data: { id: 'm-1' }, error: null })
        if (call === 2) return buildThenable({ data: [], error: null })
        return insertChain
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await createDoc('team-1', 'section-1', {})
    expect(result.success).toBe(true)
    const inserted = (insertChain.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(inserted.position).toBe(1)
    expect(inserted.title).toBe('Untitled') // schema default applied
  })

  it('rejects titles that exceed the 200-char schema cap', async () => {
    mockAuthenticated('user-1')
    const result = await createDoc('team-1', 'section-1', { title: 'a'.repeat(500) })
    expect(result.error?.startsWith('Invalid input')).toBe(true)
  })
})

// ── updateDocTitle ───────────────────────────────────────────

describe('updateDocTitle', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await updateDocTitle('doc-1', 'section-1', { title: 'New' })
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects empty titles via schema validation', async () => {
    mockAuthenticated('user-1')
    const result = await updateDocTitle('doc-1', 'section-1', { title: '   ' })
    expect(result.error?.startsWith('Invalid input')).toBe(true)
  })

  it('returns Doc not found when the doc lookup misses', async () => {
    mockAuthenticated('user-1')
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await updateDocTitle('doc-1', 'section-1', { title: 'New' })
    expect(result.error).toBe('Doc not found')
  })

  it('rejects non-members even for docs that exist', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) {
          // project_docs.single
          return buildChain({ data: { team_id: 'team-1', is_pinned: false }, error: null })
        }
        // project_members.maybeSingle → non-member
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await updateDocTitle('doc-1', 'section-1', { title: 'New' })
    expect(result.error).toBe('Not a team member')
  })
})

// ── updateDocContent ─────────────────────────────────────────

describe('updateDocContent', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await updateDocContent('doc-1', 'section-1', '<p>hi</p>')
    expect(result.error).toBe('Not authenticated')
  })

  it('rejects content that exceeds the 50k-char cap', async () => {
    mockAuthenticated('user-1')
    const hugeHtml = 'a'.repeat(50_001)
    const result = await updateDocContent('doc-1', 'section-1', hugeHtml)
    expect(result.error?.startsWith('Invalid input')).toBe(true)
  })

  it('does not revalidate on success (autosave hot path)', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) {
          // project_docs.single
          return buildChain({ data: { team_id: 'team-1' }, error: null })
        }
        if (call === 2) {
          // project_members.maybeSingle
          return buildChain({ data: { id: 'm-1' }, error: null })
        }
        // update().eq() → thenable chain
        return buildThenable({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    // revalidatePath is a module-level mock shared across tests; reset
    // its call history so we only see what this action triggers.
    const { revalidatePath } = await import('next/cache')
    ;(revalidatePath as ReturnType<typeof vi.fn>).mockClear()

    const result = await updateDocContent('doc-1', 'section-1', '<p>saved</p>')
    expect(result.success).toBe(true)
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

// ── deleteDoc ────────────────────────────────────────────────

describe('deleteDoc', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await deleteDoc('doc-1', 'section-1')
    expect(result.error).toBe('Not authenticated')
  })

  it('refuses to delete pinned (Planning) docs', async () => {
    mockAuthenticated('user-1')
    const admin = {
      from: vi.fn(() =>
        buildChain({
          data: { team_id: 'team-1', is_pinned: true, title: 'Planning' },
          error: null,
        }),
      ),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await deleteDoc('doc-1', 'section-1')
    expect(result.error).toBe('The Planning doc cannot be deleted')
  })

  it('returns Doc not found when the row is missing', async () => {
    mockAuthenticated('user-1')
    const admin = {
      from: vi.fn(() => buildChain({ data: null, error: null })),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await deleteDoc('doc-1', 'section-1')
    expect(result.error).toBe('Doc not found')
  })

  it('rejects non-members for non-pinned docs', async () => {
    mockAuthenticated('user-1')
    let call = 0
    const admin = {
      from: vi.fn(() => {
        call++
        if (call === 1) {
          return buildChain({
            data: { team_id: 'team-1', is_pinned: false, title: 'Sketch' },
            error: null,
          })
        }
        // non-member
        return buildChain({ data: null, error: null })
      }),
    }
    mockAdminClient.mockReturnValue(admin)
    const result = await deleteDoc('doc-1', 'section-1')
    expect(result.error).toBe('Not a team member')
  })
})
