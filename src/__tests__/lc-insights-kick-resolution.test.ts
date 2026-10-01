/**
 * Two production defects met in this one function.
 *
 * 1. URL: the target resolved via `NEXT_PUBLIC_APP_URL ?? VERCEL_URL ?? localhost:3000`.
 *    Neither of the first two is set on Cloud Run, and the container listens on
 *    8080 — so every kick POSTed to a dead localhost:3000 and was refused. It only
 *    ever "worked" in dev, where localhost:3000 happens to be correct.
 * 2. Secret: the sender required LC_INSIGHTS_SECRET, which is NOT set on Cloud Run,
 *    so it returned early before even building the URL. Prod does have
 *    LC_RECORDING_SECRET, which the recording finalize route already accepts as an
 *    interchangeable fallback.
 *
 * The oracles are the resolved URL and the header actually sent — not merely "a
 * fetch happened". A test asserting fetch was called would pass against the old
 * code whenever LC_INSIGHTS_SECRET was set in the test env.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { triggerClassInsights } from '@/lib/live-classroom/insights/trigger'

const ROOM = '11111111-2222-3333-4444-555555555555'
const KEYS = ['LC_INSIGHTS_SECRET', 'LC_RECORDING_SECRET', 'LC_INSIGHTS_KICK_URL', 'SITE_URL', 'NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_APP_URL', 'VERCEL_URL'] as const

describe('triggerClassInsights — URL and secret resolution', () => {
  const saved: Record<string, string | undefined> = {}
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k] as string
    }
    vi.unstubAllGlobals()
  })

  it('targets the runtime SITE_URL host, not localhost:3000', async () => {
    process.env.SITE_URL = 'https://app.scholera-inc.com'
    process.env.LC_INSIGHTS_SECRET = 'insights-secret'

    await triggerClassInsights(ROOM)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://app.scholera-inc.com/api/live-classroom/generate-insights')
    expect(String(url)).not.toContain('localhost')
  })

  it('kicks using LC_RECORDING_SECRET when LC_INSIGHTS_SECRET is absent (the prod shape)', async () => {
    process.env.SITE_URL = 'https://app.scholera-inc.com'
    process.env.LC_RECORDING_SECRET = 'recording-secret'
    // LC_INSIGHTS_SECRET deliberately unset — exactly how prod Cloud Run is configured.

    const result = await triggerClassInsights(ROOM)

    expect(result.kicked).toBe(true)
    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit & { headers: Record<string, string> }).headers['x-lc-insights-secret']).toBe(
      'recording-secret',
    )
  })

  it('prefers LC_INSIGHTS_SECRET when both are present', async () => {
    process.env.SITE_URL = 'https://app.scholera-inc.com'
    process.env.LC_INSIGHTS_SECRET = 'insights-secret'
    process.env.LC_RECORDING_SECRET = 'recording-secret'

    await triggerClassInsights(ROOM)

    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit & { headers: Record<string, string> }).headers['x-lc-insights-secret']).toBe(
      'insights-secret',
    )
  })

  it('still skips the kick when no secret at all is configured', async () => {
    process.env.SITE_URL = 'https://app.scholera-inc.com'

    const result = await triggerClassInsights(ROOM)

    expect(result.kicked).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honours an explicit LC_INSIGHTS_KICK_URL override', async () => {
    process.env.LC_INSIGHTS_KICK_URL = 'https://override.example/api/kick'
    process.env.SITE_URL = 'https://app.scholera-inc.com'
    process.env.LC_INSIGHTS_SECRET = 'insights-secret'

    await triggerClassInsights(ROOM)

    expect(fetchMock.mock.calls[0][0]).toBe('https://override.example/api/kick')
  })
})
