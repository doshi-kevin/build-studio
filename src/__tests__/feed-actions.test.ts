// Tests for the shared feed read/mark/dismiss server actions. Every action is
// recipient-scoped. The safety-critical invariant for the bell's "Clear all":
// dismissFeedNotices must NEVER dismiss (soft-delete) a LIVE to-do (is_actionable &&
// !is_done), because feed_items rows are shared with the dashboard to-do list — clearing
// the bell must not remove a real task from a student's dashboard.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Chain Builder ────────────────────────────────────────────

function buildChain(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.or = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.delete = vi.fn().mockReturnValue(chain)
  chain.is = vi.fn().mockReturnValue(chain)
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

/* eslint-disable @typescript-eslint/no-explicit-any */
let dismissFeedNotices: any
let dismissFeedItem: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const mod = await import('@/lib/events/feed-actions')
  dismissFeedNotices = mod.dismissFeedNotices
  dismissFeedItem = mod.dismissFeedItem
})

function mockAuthenticated(userId = 'user-1') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

// ── dismissFeedNotices (bell "Clear all") ────────────────────

describe('dismissFeedNotices', () => {
  it('rejects unauthenticated users', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
    const result = await dismissFeedNotices()
    expect(result.error).toBe('Not authenticated')
  })

  it('soft-deletes only the caller’s notices/finished items and never a live to-do', async () => {
    mockAuthenticated('user-1')
    const chain = buildChain({ data: null, error: null })
    const admin = { from: vi.fn(() => chain) }
    mockAdminClient.mockReturnValue(admin)

    const result = await dismissFeedNotices()
    expect(result.success).toBe(true)
    expect(admin.from).toHaveBeenCalledWith('feed_items')
    // Soft delete — stamps dismissed_at (keeps the row for the history page), never .delete().
    const updateFn = chain.update as ReturnType<typeof vi.fn>
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ dismissed_at: expect.any(String) }),
    )
    expect(chain.delete as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    // Recipient-scoped — a user can only ever clear their own rows.
    const eqFn = chain.eq as ReturnType<typeof vi.fn>
    expect(eqFn).toHaveBeenCalledWith('recipient_id', 'user-1')
    // THE invariant: dismiss only notices (is_actionable=false) OR finished to-dos
    // (is_done=true), so a LIVE to-do (actionable && !done) is always preserved.
    const orFn = chain.or as ReturnType<typeof vi.fn>
    expect(orFn).toHaveBeenCalledWith('is_actionable.eq.false,is_done.eq.true')
  })

  it('returns an error when the update fails', async () => {
    mockAuthenticated('user-1')
    const chain = buildChain({ data: null, error: { message: 'boom' } })
    const admin = { from: vi.fn(() => chain) }
    mockAdminClient.mockReturnValue(admin)

    const result = await dismissFeedNotices()
    expect(result.error).toBe('Failed to clear notifications')
  })
})

// ── dismissFeedItem (single dismiss of a notice) ─────────────

describe('dismissFeedItem', () => {
  it('is recipient-scoped and guards live to-dos at the DB layer', async () => {
    mockAuthenticated('user-1')
    const chain = buildChain({ data: null, error: null })
    const admin = { from: vi.fn(() => chain) }
    mockAdminClient.mockReturnValue(admin)

    const result = await dismissFeedItem('f1')
    expect(result.success).toBe(true)
    // A crafted request naming someone else's item id is filtered out by recipient_id.
    const eqFn = chain.eq as ReturnType<typeof vi.fn>
    expect(eqFn).toHaveBeenCalledWith('id', 'f1')
    expect(eqFn).toHaveBeenCalledWith('recipient_id', 'user-1')
    // Soft delete — stamps dismissed_at (keeps history), never .delete().
    const updateFn = chain.update as ReturnType<typeof vi.fn>
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ dismissed_at: expect.any(String) }),
    )
    expect(chain.delete as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    // Defense-in-depth: even a DIRECT call (bypassing the client isLiveTodo gate) can't
    // dismiss a live to-do — the .or restricts the update to notices + finished to-dos,
    // so a live to-do no-ops (0 rows) instead of being dropped off the dashboard.
    const orFn = chain.or as ReturnType<typeof vi.fn>
    expect(orFn).toHaveBeenCalledWith('is_actionable.eq.false,is_done.eq.true')
  })
})
