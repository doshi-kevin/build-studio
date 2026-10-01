// Resend webhook → email cost ledger. Counts EVERY delivered send — including
// the Supabase-SMTP auth emails (invites, resets) that never touch our app
// code — so the platform email count is exact. Resend has no usage/billing
// API; this webhook is the only complete counter.
//
// Rows are platform-level (institution_id null): per-send tenant attribution
// would require tagging 11+ send sites for ~$0.0004/email — deliberately not
// done. Idempotent on the provider event id (dedup_key), per the inbound-
// webhook rule.
//
// Signature: Resend signs with svix. Verified manually with node:crypto
// (HMAC-SHA256 over `${id}.${timestamp}.${payload}` using the base64 secret
// after the `whsec_` prefix) to avoid a new dependency. Set
// RESEND_WEBHOOK_SECRET and point a Resend webhook at /api/webhooks/resend
// with the `email.sent` event.

import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { recordExternalUsage } from '@/lib/costs/external-usage'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

const TOLERANCE_SECONDS = 5 * 60

function verifySvixSignature(secret: string, id: string, timestamp: string, payload: string, signatureHeader: string): boolean {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64')
  // Header holds space-separated "v1,<sig>" entries (key-rotation can yield several).
  return signatureHeader.split(' ').some((part) => {
    const sig = part.split(',')[1]
    if (!sig) return false
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  })
}

export async function POST(request: NextRequest) {
  try {
    const secret = process.env.RESEND_WEBHOOK_SECRET
    if (!secret) {
      logger.warn('POST /api/webhooks/resend: RESEND_WEBHOOK_SECRET not set — ignoring event')
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
    }

    const svixId = request.headers.get('svix-id') ?? ''
    const svixTimestamp = request.headers.get('svix-timestamp') ?? ''
    const svixSignature = request.headers.get('svix-signature') ?? ''
    const payload = await request.text()
    if (!svixId || !svixTimestamp || !svixSignature ||
        !verifySvixSignature(secret, svixId, svixTimestamp, payload, svixSignature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    let event: { type?: string; data?: { email_id?: string; subject?: string } }
    try {
      event = JSON.parse(payload)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    // One row per sent email; other event types (delivered, bounced, opened)
    // would double-count the same send.
    if (event.type === 'email.sent') {
      await recordExternalUsage({
        provider: 'resend',
        feature: 'email',
        quantity: 1,
        dedupKey: `resend:${event.data?.email_id ?? svixId}`,
        metadata: { subject: event.data?.subject?.slice(0, 120) ?? null },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    logger.error('POST /api/webhooks/resend: exception', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
