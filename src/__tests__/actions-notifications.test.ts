// Tests for the in-app notification server actions. Every action is
// recipient-scoped: the caller can only see / modify rows where
// recipient_id = user.id. These tests verify both the auth gate and
// the recipient filter that the actions layer on every query.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown; count?: number }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.or = vi.fn().mockReturnValue(chain)
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
let listMyNotifications: any
let listBell: any
let countUnreadNotifications: any
let markNotificationRead: any
let markAllNotificationsRead: any
let dismissNotification: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import('@/app/(dashboard)/notifications-actions')
  listMyNotifications = mod.listMyNotifications
  listBell = mod.listBell
  countUnreadNotifications = mod.countUnreadNotifications
  markNotificationRead = mod.markNotificationRead
  markAllNotificationsRead = mod.markAllNotificationsRead
  dismissNotification = mod.dismissNotification
})

// ── Auth helpers ─────────────────────────────────────────────

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

function mockAuthenticated(userId = 'user-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

// ── listMyNotifications ──────────────────────────────────────

describe('listMyNotifications', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await listMyNotifications()
    expect(result.error).toBe('Not authenticated')
  })

  it('filters rows by recipient_id and limits to 50 newest', async () => {
    mockAuthenticated('user-1')
    const chain = buildChain({ data: [], error: null })
    const admin = { from: vi.fn(() => chain) }
    mockAdminClient.mockReturnValue(admin)

    await listMyNotifications()

    expect(admin.from).toHaveBeenCalledWith('app_notifications')
    const eqFn = chain.eq as ReturnType<typeof vi.fn>
    expect(eqFn).toHaveBeenCalledWith('recipient_id', 'user-1')
    const limitFn = chain.limit as ReturnType<typeof vi.fn>
    expect(limitFn).toHaveBeenCalledWith(50)
    const orderFn = chain.order as ReturnType<typeof vi.fn>
    expect(orderFn).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  it('computes unreadCount from is_read flags', async () => {
    mockAuthenticated('user-1')
    const rows = [
      { id: 'n1', recipient_id: 'user-1', kind: 'x', title: 't', body: null, link_url: null, is_read: false, read_at: null, metadata: {}, created_at: 'a', actor_id: null },
      { id: 'n2', recipient_id: 'user-1', kind: 'x', title: 't', body: null, link_url: null, is_read: true, read_at: null, metadata: {}, created_at: 'b', actor_id: null },
      { id: 'n3', recipient_id: 'user-1', kind: 'x', title: 't', body: null, link_url: null, is_read: false, read_at: null, metadata: {}, created_at: 'c', actor_id: null },
    ]
    const chain = buildChain({ data: rows, error: null })
    const admin = { from: vi.fn(() => chain) }
    mockAdminClient.mockReturnValue(admin)

    const result = await listMyNotifications()
    expect(result.success).toBe(true)
    expect(result.data.unreadCount).toBe(2)
    expect(result.data.notifications).toHaveLength(3)
  })
})

// ── listBell (dual-source: app_notifications + feed_items) ───

describe('listBell', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await listBell()
    expect(result.error).toBe('Not authenticated')
  })

  it('surfaces feed_items metadata.important as BellItem.important (defaulting false)', async () => {
    mockAuthenticated('user-1')
    const feedRows = [
      { id: 'f1', type: 'announcement_posted', title: 'Heads up', body: null, link_url: null, is_read: false, created_at: 'b', metadata: { important: true, course_label: 'CS 546' }, actor: null },
      { id: 'f2', type: 'announcement_posted', title: 'FYI', body: null, link_url: null, is_read: false, created_at: 'a', metadata: {}, actor: null },
    ]
    // listBell queries app_notifications AND feed_items in parallel — branch by table
    // so only the feed source carries rows.
    const admin = {
      from: vi.fn((table: string) =>
        table === 'feed_items'
          ? buildChain({ data: feedRows, error: null })
          : buildChain({ data: [], error: null }),
      ),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await listBell()
    expect(result.success).toBe(true)
    const byId = Object.fromEntries(result.data.items.map((i: { id: string }) => [i.id, i]))
    expect(byId.f1.important).toBe(true) // metadata.important passes through
    expect(byId.f2.important).toBe(false) // absent → default false
  })

  it('surfaces feed is_actionable/is_done (defaulting false for chat/DM)', async () => {
    mockAuthenticated('user-1')
    const feedRows = [
      { id: 'todo', type: 'assignment_published', title: 'HW1', body: null, link_url: null, is_read: false, created_at: 'b', metadata: {}, is_actionable: true, is_done: false, actor: null },
      { id: 'notice', type: 'announcement_posted', title: 'FYI', body: null, link_url: null, is_read: false, created_at: 'a', metadata: {}, is_actionable: false, is_done: false, actor: null },
    ]
    const appRows = [
      { id: 'dm', title: 'DM', body: null, link_url: null, is_read: false, created_at: 'c', metadata: {}, actor: null },
    ]
    const admin = {
      from: vi.fn((table: string) =>
        table === 'feed_items'
          ? buildChain({ data: feedRows, error: null })
          : buildChain({ data: appRows, error: null }),
      ),
    }
    mockAdminClient.mockReturnValue(admin)

    const result = await listBell()
    const byId = Object.fromEntries(result.data.items.map((i: { id: string }) => [i.id, i]))
    // A live to-do vs a notice — the bell needs this to decide delete-vs-keep on dismiss.
    expect(byId.todo.is_actionable).toBe(true)
    expect(byId.todo.is_done).toBe(false)
    expect(byId.notice.is_actionable).toBe(false)
    // chat/DM (app_notifications) has no such columns → default false, never a to-do.
    expect(byId.dm.is_actionable).toBe(false)
    expect(byId.dm.is_done).toBe(false)
  })

  it('hides read to-dos from the bell (kept for the dashboard) via the feed .or filter', async () => {
    mockAuthenticated('user-1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let feedChain: any
    const admin = {
      from: vi.fn((table: string) => {
        const chain = buildChain({ data: [], error: null })
        if (table === 'feed_items') feedChain = chain
        return chain
      }),
    }
    mockAdminClient.mockReturnValue(admin)

    await listBell()
    // A read to-do (is_actionable && is_read) is excluded from the bell so it can be
    // cleared, while its row stays for the dashboard to-do list; notices still show read.
    const orFn = feedChain.or as ReturnType<typeof vi.fn>
    expect(orFn).toHaveBeenCalledWith('is_actionable.eq.false,is_read.eq.false')
  })
})

// ── countUnreadNotifications ─────────────────────────────────

describe('countUnreadNotifications', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await countUnreadNotifications()
    expect(result.error).toBe('Not authenticated')
  })

  it('filters count by recipient_id and is_read=false', async () => {
    mockAuthenticated('user-1')
    const chain = buildChain({ data: null, error: null, count: 7 })
    const admin = { from: vi.fn(() => chain) }
    mockAdminClient.mockReturnValue(admin)

    const result = await countUnreadNotifications()
    expect(result.success).toBe(true)
    expect(result.data.count).toBe(7)
    const eqFn = chain.eq as ReturnType<typeof vi.fn>
    // recipient + is_read filters both present
    expect(eqFn).toHaveBeenCalledWith('recipient_id', 'user-1')
    expect(eqFn).toHaveBeenCalledWith('is_read', false)
  })

  it('returns 0 when count is null', async () => {
    mockAuthenticated('user-1')
    const chain = buildChain({ data: null, error: null, count: undefined })
    const admin = { from: vi.fn(() => chain) }
    mockAdminClient.mockReturnValue(admin)

    const result = await countUnreadNotifications()
    expect(result.success).toBe(true)
    expect(result.data.count).toBe(0)
  })
})

// ── markNotificationRead ─────────────────────────────────────

describe('markNotificationRead', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await markNotificationRead('n1')
    expect(result.error).toBe('Not authenticated')
  })

  it('scopes the update to the caller via recipient_id filter', async () => {
    mockAuthenticated('user-1')
    const chain = buildChain({ data: null, error: null })
    const admin = { from: vi.fn(() => chain) }
    mockAdminClient.mockReturnValue(admin)

    const result = await markNotificationRead('n1')
    expect(result.success).toBe(true)
    const eqFn = chain.eq as ReturnType<typeof vi.fn>
    // MUST include a recipient_id filter so one user can't mark
    // another's notifications. Also must include the id filter.
    expect(eqFn).toHaveBeenCalledWith('id', 'n1')
    expect(eqFn).toHaveBeenCalledWith('recipient_id', 'user-1')
    // Idempotent guard — only flip unread rows.
    expect(eqFn).toHaveBeenCalledWith('is_read', false)
  })

  it('returns an error when the DB update fails', async () => {
    mockAuthenticated('user-1')
    const chain = buildChain({ data: null, error: { message: 'boom' } })
    const admin = { from: vi.fn(() => chain) }
    mockAdminClient.mockReturnValue(admin)

    const result = await markNotificationRead('n1')
    expect(result.error).toBe('Failed to update notification')
  })
})

// ── markAllNotificationsRead ─────────────────────────────────

describe('markAllNotificationsRead', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await markAllNotificationsRead()
    expect(result.error).toBe('Not authenticated')
  })

  it('filters by caller and is_read=false only', async () => {
    mockAuthenticated('user-1')
    const chain = buildChain({ data: null, error: null })
    const admin = { from: vi.fn(() => chain) }
    mockAdminClient.mockReturnValue(admin)

    const result = await markAllNotificationsRead()
    expect(result.success).toBe(true)
    const eqFn = chain.eq as ReturnType<typeof vi.fn>
    expect(eqFn).toHaveBeenCalledWith('recipient_id', 'user-1')
    expect(eqFn).toHaveBeenCalledWith('is_read', false)
  })
})

// ── dismissNotification ──────────────────────────────────────

describe('dismissNotification', () => {
  it('rejects unauthenticated users', async () => {
    mockUnauthenticated()
    const result = await dismissNotification('n1')
    expect(result.error).toBe('Not authenticated')
  })

  it('soft-deletes (dismisses) only within the caller’s recipient scope', async () => {
    mockAuthenticated('user-1')
    const chain = buildChain({ data: null, error: null })
    const admin = { from: vi.fn(() => chain) }
    mockAdminClient.mockReturnValue(admin)

    const result = await dismissNotification('n1')
    expect(result.success).toBe(true)
    // MUST be scoped to the caller — a crafted request naming someone
    // else's notification id should be filtered out by recipient_id.
    const eqFn = chain.eq as ReturnType<typeof vi.fn>
    expect(eqFn).toHaveBeenCalledWith('id', 'n1')
    expect(eqFn).toHaveBeenCalledWith('recipient_id', 'user-1')
    // Soft delete — sets dismissed_at (keeps the row for the history page), never .delete().
    const updateFn = chain.update as ReturnType<typeof vi.fn>
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ dismissed_at: expect.any(String) }),
    )
    expect(chain.delete as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })
})
