// Tests for the short-URL redirect layer (createInviteRedirect + resolveInviteRedirect).
// Covers happy-path insertion, DB failure handling, and the three resolve states
// (not_found / revoked / expired / ok + first-hit tracking).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAdminClient = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => mockAdminClient(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// Build a stub admin DB exposing .from('invite_redirects') with configurable
// insert / select / update chains per test.
function buildRedirectsDb(opts: {
  insertError?: { message: string } | null
  selectData?: Record<string, unknown> | null
  selectError?: { message: string } | null
  updateCapture?: ReturnType<typeof vi.fn>
}) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: opts.selectData ?? null,
      error: opts.selectError ?? null,
    }),
    insert: vi.fn().mockResolvedValue({ error: opts.insertError ?? null }),
    update: opts.updateCapture ?? vi.fn().mockReturnThis(),
  }
  return { from: vi.fn(() => chain), _chain: chain }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createInviteRedirect: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resolveInviteRedirect: any

beforeEach(async () => {
  vi.resetModules()
  mockAdminClient.mockReset()
  const mod = await import('@/lib/invite-redirects')
  createInviteRedirect = mod.createInviteRedirect
  resolveInviteRedirect = mod.resolveInviteRedirect
})

// The allowlist check in createInviteRedirect only accepts action_links whose
// origin matches NEXT_PUBLIC_SUPABASE_URL. The test env points that at the
// local Supabase (http://127.0.0.1:54321), so test fixtures must use it too.
const SUPABASE_ORIGIN = 'http://127.0.0.1:54321'
const VALID_ACTION_LINK = `${SUPABASE_ORIGIN}/auth/v1/verify?token=XYZ`

describe('createInviteRedirect', () => {
  it('inserts a row and returns a short URL on success', async () => {
    const db = buildRedirectsDb({ insertError: null })
    mockAdminClient.mockReturnValue(db)

    const result = await createInviteRedirect({
      actionLink: VALID_ACTION_LINK,
      purpose: 'staff_invite',
      createdBy: 'admin-uuid',
    })

    expect('error' in result).toBe(false)
    if ('error' in result) throw new Error('unexpected')

    // short URL shape: <site>/i/<16-char id>
    expect(result.shortUrl).toMatch(/\/i\/[A-Za-z0-9]{16}$/)
    expect(result.shortId).toHaveLength(16)
    expect(db.from).toHaveBeenCalledWith('invite_redirects')
    expect(db._chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        short_id: result.shortId,
        action_link: VALID_ACTION_LINK,
        purpose: 'staff_invite',
        created_by: 'admin-uuid',
        expires_at: expect.any(String),
      })
    )
  })

  it('returns error when DB insert fails', async () => {
    const db = buildRedirectsDb({ insertError: { message: 'unique violation' } })
    mockAdminClient.mockReturnValue(db)

    const result = await createInviteRedirect({
      actionLink: VALID_ACTION_LINK,
      purpose: 'staff_invite',
    })

    expect('error' in result).toBe(true)
    if (!('error' in result)) throw new Error('unexpected')
    expect(result.error).toMatch(/unique violation/)
  })

  it('rejects action_links outside the configured Supabase origin', async () => {
    const db = buildRedirectsDb({ insertError: null })
    mockAdminClient.mockReturnValue(db)

    const result = await createInviteRedirect({
      actionLink: 'https://evil.example.com/redirect?to=attacker.com',
      purpose: 'staff_invite',
    })

    expect('error' in result).toBe(true)
    if (!('error' in result)) throw new Error('unexpected')
    expect(result.error).toMatch(/Invalid action link/)
    // DB insert must not have been attempted
    expect(db._chain.insert).not.toHaveBeenCalled()
  })

  it('rejects malformed action_links', async () => {
    const db = buildRedirectsDb({ insertError: null })
    mockAdminClient.mockReturnValue(db)

    const result = await createInviteRedirect({
      actionLink: 'not-a-url',
      purpose: 'staff_invite',
    })

    expect('error' in result).toBe(true)
    expect(db._chain.insert).not.toHaveBeenCalled()
  })

  it('uses 7-day default expiry and accepts override', async () => {
    const db = buildRedirectsDb({ insertError: null })
    mockAdminClient.mockReturnValue(db)

    await createInviteRedirect({
      actionLink: VALID_ACTION_LINK,
      purpose: 'staff_invite',
    })

    const insertCall = db._chain.insert.mock.calls[0][0]
    const expiresAt = new Date(insertCall.expires_at).getTime()
    const now = Date.now()
    const diffSec = Math.round((expiresAt - now) / 1000)
    // Should be ~7 days, within a generous window for clock variance
    expect(diffSec).toBeGreaterThan(6 * 24 * 60 * 60)
    expect(diffSec).toBeLessThan(8 * 24 * 60 * 60)

    // Custom expiry override
    await createInviteRedirect({
      actionLink: VALID_ACTION_LINK,
      purpose: 'magic_link',
      expiresSec: 3600,
    })
    const secondCall = db._chain.insert.mock.calls[1][0]
    const secondExpiresAt = new Date(secondCall.expires_at).getTime()
    const secondDiff = Math.round((secondExpiresAt - Date.now()) / 1000)
    expect(secondDiff).toBeGreaterThan(3500)
    expect(secondDiff).toBeLessThan(3700)
  })
})

describe('resolveInviteRedirect', () => {
  it('returns not_found when row missing', async () => {
    const db = buildRedirectsDb({
      selectData: null,
      selectError: { message: 'no rows' },
    })
    mockAdminClient.mockReturnValue(db)

    const result = await resolveInviteRedirect('missing-id')
    expect(result.status).toBe('not_found')
  })

  it('returns revoked when revoked_at is set', async () => {
    const db = buildRedirectsDb({
      selectData: {
        action_link: 'https://example.com',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        redeemed_at: null,
        revoked_at: new Date().toISOString(),
      },
    })
    mockAdminClient.mockReturnValue(db)

    const result = await resolveInviteRedirect('revoked-id')
    expect(result.status).toBe('revoked')
  })

  it('returns expired when expires_at is past', async () => {
    const db = buildRedirectsDb({
      selectData: {
        action_link: 'https://example.com',
        expires_at: new Date(Date.now() - 3600_000).toISOString(),
        redeemed_at: null,
        revoked_at: null,
      },
    })
    mockAdminClient.mockReturnValue(db)

    const result = await resolveInviteRedirect('expired-id')
    expect(result.status).toBe('expired')
  })

  it('returns ok + firstHit=true on first use and marks redeemed_at', async () => {
    const updateChain = {
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockResolvedValue({ error: null }),
    }
    const updateFn = vi.fn().mockReturnValue(updateChain)
    const db = buildRedirectsDb({
      selectData: {
        action_link: 'https://example.com/redirect',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        redeemed_at: null,
        revoked_at: null,
      },
      updateCapture: updateFn,
    })
    mockAdminClient.mockReturnValue(db)

    const result = await resolveInviteRedirect('fresh-id')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unexpected')
    expect(result.actionLink).toBe('https://example.com/redirect')
    expect(result.firstHit).toBe(true)
    // Must have attempted to stamp redeemed_at
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ redeemed_at: expect.any(String) })
    )
  })

  it('returns ok + firstHit=false when already redeemed (Supabase token already single-use at auth layer)', async () => {
    const updateFn = vi.fn()
    const db = buildRedirectsDb({
      selectData: {
        action_link: 'https://example.com/redirect',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        redeemed_at: new Date(Date.now() - 60_000).toISOString(),
        revoked_at: null,
      },
      updateCapture: updateFn,
    })
    mockAdminClient.mockReturnValue(db)

    const result = await resolveInviteRedirect('redeemed-id')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unexpected')
    expect(result.firstHit).toBe(false)
    // Must NOT re-update redeemed_at on replay
    expect(updateFn).not.toHaveBeenCalled()
  })
})
