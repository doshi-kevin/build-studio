// Tests for the Resend email-cost webhook (src/app/api/webhooks/resend/route.ts).
// The signed request is the ONLY trust boundary here — an attacker who can forge
// it can inject fake email-cost rows, and a crypto regression (wrong signed-string
// format, base64/hex mixup, missing tolerance window) would silently reject every
// real Resend delivery. Both directions are exercised against a signature computed
// independently in the test with node:crypto.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'

const mockRecordExternalUsage = vi.fn()

vi.mock('@/lib/costs/external-usage', () => ({
  recordExternalUsage: (...args: unknown[]) => mockRecordExternalUsage(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const SECRET = 'whsec_' + Buffer.from('super-secret-signing-key').toString('base64')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let POST: any

beforeEach(async () => {
  vi.resetModules()
  mockRecordExternalUsage.mockReset()
  process.env.RESEND_WEBHOOK_SECRET = SECRET
  const mod = await import('@/app/api/webhooks/resend/route')
  POST = mod.POST
})

// Sign exactly as Resend/svix does: HMAC-SHA256 over `${id}.${ts}.${payload}`
// keyed by the base64-decoded secret (after the whsec_ prefix), digest base64,
// header value "v1,<sig>".
function sign(id: string, ts: number, payload: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64')
  return `v1,${sig}`
}

function makeRequest(headers: Record<string, string>, body: string): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/resend', {
    method: 'POST',
    headers,
    body,
  })
}

function signedRequest(body: string, opts: { ts?: number; secret?: string; id?: string } = {}): NextRequest {
  const id = opts.id ?? 'msg_123'
  const ts = opts.ts ?? Math.floor(Date.now() / 1000)
  return makeRequest(
    {
      'svix-id': id,
      'svix-timestamp': String(ts),
      'svix-signature': sign(id, ts, body, opts.secret ?? SECRET),
    },
    body,
  )
}

describe('POST /api/webhooks/resend', () => {
  it('records one email on a valid email.sent event', async () => {
    const body = JSON.stringify({ type: 'email.sent', data: { email_id: 'e1', subject: 'Hello' } })
    const res = await POST(signedRequest(body))
    expect(res.status).toBe(200)
    expect(mockRecordExternalUsage).toHaveBeenCalledTimes(1)
    expect(mockRecordExternalUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'resend',
        feature: 'email',
        quantity: 1,
        dedupKey: 'resend:e1', // dedups on the provider email_id
      }),
    )
  })

  it('rejects a tampered body (signature no longer matches) with 401', async () => {
    const signed = signedRequest(JSON.stringify({ type: 'email.sent', data: { email_id: 'e1' } }))
    // Re-issue with the same headers but a different body.
    const tampered = makeRequest(
      {
        'svix-id': signed.headers.get('svix-id')!,
        'svix-timestamp': signed.headers.get('svix-timestamp')!,
        'svix-signature': signed.headers.get('svix-signature')!,
      },
      JSON.stringify({ type: 'email.sent', data: { email_id: 'ATTACKER' } }),
    )
    const res = await POST(tampered)
    expect(res.status).toBe(401)
    expect(mockRecordExternalUsage).not.toHaveBeenCalled()
  })

  it('rejects a signature made with the wrong secret with 401', async () => {
    const body = JSON.stringify({ type: 'email.sent', data: { email_id: 'e1' } })
    const wrongSecret = 'whsec_' + Buffer.from('not-the-real-key').toString('base64')
    const res = await POST(signedRequest(body, { secret: wrongSecret }))
    expect(res.status).toBe(401)
    expect(mockRecordExternalUsage).not.toHaveBeenCalled()
  })

  it('rejects a stale timestamp outside the 5-minute tolerance with 401', async () => {
    const body = JSON.stringify({ type: 'email.sent', data: { email_id: 'e1' } })
    const staleTs = Math.floor(Date.now() / 1000) - 6 * 60
    const res = await POST(signedRequest(body, { ts: staleTs }))
    expect(res.status).toBe(401)
    expect(mockRecordExternalUsage).not.toHaveBeenCalled()
  })

  it('returns 503 when the signing secret is not configured', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET
    vi.resetModules()
    const mod = await import('@/app/api/webhooks/resend/route')
    const body = JSON.stringify({ type: 'email.sent', data: { email_id: 'e1' } })
    const res = await mod.POST(signedRequest(body))
    expect(res.status).toBe(503)
    expect(mockRecordExternalUsage).not.toHaveBeenCalled()
  })

  it('does not record on non-email.sent event types (avoids double-counting a send)', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'e1' } })
    const res = await POST(signedRequest(body))
    expect(res.status).toBe(200)
    expect(mockRecordExternalUsage).not.toHaveBeenCalled()
  })

  it('falls back to the svix id for dedup when email_id is absent', async () => {
    const body = JSON.stringify({ type: 'email.sent', data: { subject: 'no id' } })
    const res = await POST(signedRequest(body, { id: 'msg_fallback' }))
    expect(res.status).toBe(200)
    expect(mockRecordExternalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: 'resend:msg_fallback' }),
    )
  })
})
