// POST /api/live-classroom/generate-insights
//
// Generates Class Insights (professor report + PII-free student study pack)
// for an ended room. Called two ways, mirroring the extraction worker:
//   1. endRoom fires a fire-and-forget POST here right after a class ends.
//   2. A GHA sweep (follow-up) POSTs here periodically to re-run rooms whose
//      kick failed or whose generation is stuck.
//
// Auth: a shared secret in the x-lc-insights-secret header. The secret lives
// in Cloud Run env only. Without it the route returns 401 and does nothing —
// generation runs under the admin client, so this gate is the access control.
//
// Runtime: 'nodejs', long maxDuration — the LLM steps (summary + flashcards +
// practice quiz) take tens of seconds.

import 'server-only'
import { timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { generateClassInsights } from '@/lib/live-classroom/insights/generate'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const bodySchema = z.object({ roomId: z.string().uuid() })

function verifySecret(req: NextRequest): boolean {
  // Falls back to LC_RECORDING_SECRET exactly as the recording finalize route
  // already falls back to LC_INSIGHTS_SECRET — these are internal kick endpoints
  // on the same service, at the same trust level. Prod has LC_RECORDING_SECRET
  // but NOT LC_INSIGHTS_SECRET, which left this endpoint unreachable and every
  // post-class study pack waiting on a lazy on-view generation.
  // The sender (lib/live-classroom/insights/trigger.ts) resolves the identical
  // chain, so the two cannot drift.
  const expected = process.env.LC_INSIGHTS_SECRET ?? process.env.LC_RECORDING_SECRET
  if (!expected) return false
  const provided = req.headers.get('x-lc-insights-secret')
  if (!provided) return false
  /* Compare BYTE lengths, not string lengths. `provided.length` counts UTF-16 code
     units while Buffer.from() encodes UTF-8, so a header containing a multibyte
     character could clear a string-length check and still produce unequal buffers —
     and timingSafeEqual THROWS on a length mismatch. verifySecret runs outside the
     handler's try/catch, so that surfaced as an unauthenticated 500 instead of a 401. */
  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let roomId: string
  try {
    const parsed = bodySchema.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
    roomId = parsed.data.roomId
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  try {
    const result = await generateClassInsights(roomId)
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'generation failed' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, empty: result.empty ?? false }, { status: 200 })
  } catch (err) {
    logger.error('generate-insights route: failed', err, { roomId })
    return NextResponse.json({ error: 'generation failed' }, { status: 500 })
  }
}
