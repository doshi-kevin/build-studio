// @vitest-environment node
//
// fetchPineconeBill — the Pinecone line on the super-admin Cost Analysis page.
// Pinecone publishes no invoice API, so this number is entirely ours: metered
// RU/WU spend from external_usage_events, floored at the plan minimum we pay
// regardless of usage. Two failure modes are silent and expensive:
//
//  1. Dropping the floor (or flipping max→min) makes a real $50 obligation
//     render as $0.003 — the dashboard under-states the actual bill.
//  2. Forgetting to scope the read to provider='pinecone' / the current month
//     sums EVERY provider's external spend into the Pinecone row.
//
// Both are arithmetic/query-shape bugs no type checker catches, so they are
// pinned here.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const select = vi.fn()
const eq = vi.fn()
const gte = vi.fn()
const limit = vi.fn()
const from = vi.fn()
const createAdminClient = vi.fn()

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClient() }))

import { fetchPineconeBill } from '@/lib/costs/providers/pinecone'

/** Resolve the usage read with `result`; returns the chain for arg assertions. */
function withUsageRows(result: { data?: Array<{ cost_usd: unknown }>; error?: { message: string } }) {
  limit.mockResolvedValue(result)
  const chain = { select, eq, gte, limit }
  select.mockReturnValue(chain)
  eq.mockReturnValue(chain)
  gte.mockReturnValue(chain)
  from.mockReturnValue(chain)
  createAdminClient.mockReturnValue({ from })
  return chain
}

const month = () => new Date().toISOString().slice(0, 7)

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.PINECONE_PLAN_MINIMUM_USD
})

describe('fetchPineconeBill', () => {
  it('reports the plan floor when metered spend is below it', async () => {
    withUsageRows({ data: [{ cost_usd: 0.002 }, { cost_usd: 0.0008 }] })
    const bill = await fetchPineconeBill()
    // We pay $50 whether or not we used $50 of it — the floor IS the bill.
    expect(bill.amountUsd).toBe(50)
    expect(bill.detail).toEqual({ meteredUsd: 0.0028, minimum: 50 })
    expect(bill.source).toBe('computed')
    expect(bill.provider).toBe('pinecone')
    expect(bill.month).toBe(month())
  })

  it('reports metered spend once it exceeds the floor, rounded to cents', async () => {
    withUsageRows({ data: [{ cost_usd: 40 }, { cost_usd: 32.126 }] })
    const bill = await fetchPineconeBill()
    expect(bill.amountUsd).toBe(72.13)
    // detail keeps 4 dp so sub-cent RU spend stays legible next to the total.
    expect(bill.detail).toEqual({ meteredUsd: 72.126, minimum: 50 })
  })

  it('scopes the read to pinecone rows in the current month only', async () => {
    withUsageRows({ data: [] })
    await fetchPineconeBill()
    expect(from).toHaveBeenCalledWith('external_usage_events')
    // Without this eq(), every provider's spend lands in the Pinecone row.
    expect(eq).toHaveBeenCalledWith('provider', 'pinecone')
    expect(gte).toHaveBeenCalledWith('created_at', `${month()}-01T00:00:00Z`)
  })

  it('treats a null/garbage cost_usd as zero rather than poisoning the sum with NaN', async () => {
    withUsageRows({ data: [{ cost_usd: null }, { cost_usd: 1.5 }] })
    const bill = await fetchPineconeBill()
    expect(bill.detail).toEqual({ meteredUsd: 1.5, minimum: 50 })
    expect(bill.amountUsd).toBe(50)
  })

  it('falls back to the floor with meteredUsd: null when the usage read fails', async () => {
    withUsageRows({ error: { message: 'permission denied' } })
    const bill = await fetchPineconeBill()
    // null, not 0: "we could not measure" must not read as "nothing was spent".
    expect(bill.detail).toEqual({ meteredUsd: null, minimum: 50 })
    expect(bill.amountUsd).toBe(50)
  })

  it('never throws — an admin-client failure still yields the plan-floor bill', async () => {
    createAdminClient.mockImplementation(() => {
      throw new Error('no service role key')
    })
    const bill = await fetchPineconeBill()
    expect(bill).toMatchObject({ provider: 'pinecone', amountUsd: 50, source: 'computed' })
    expect(bill.detail).toBeUndefined()
  })

  it('honors PINECONE_PLAN_MINIMUM_USD for a different plan tier', async () => {
    process.env.PINECONE_PLAN_MINIMUM_USD = '0'
    withUsageRows({ data: [{ cost_usd: 0.25 }] })
    const bill = await fetchPineconeBill()
    // Floor of 0 (a plan with no minimum) must let real metered spend through.
    expect(bill.amountUsd).toBe(0.25)
    expect(bill.detail).toEqual({ meteredUsd: 0.25, minimum: 0 })
  })
})
