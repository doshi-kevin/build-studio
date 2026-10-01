// POST /api/preclass-audio/generate
//
// Generates one lecture's Pre-Class Primer audio (script → TTS → storage).
// Fired by the professor toggling a lecture's primer on, via a fire-and-forget
// kick.
//
// Auth: a shared secret in the x-preclass-audio-secret header. The secret lives
// in Cloud Run env only. Generation runs under the admin client, so this gate
// is the access control — without the secret the route 401s and does nothing.
//
// Runtime: 'nodejs', long maxDuration — script generation + TTS + upload take
// tens of seconds.

import 'server-only'
import { timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { generatePrimer } from '@/lib/preclass-audio/generate'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const bodySchema = z.object({
  moduleItemId: z.string().uuid(),
  force: z.boolean().optional(),
})

function verifySecret(req: NextRequest): boolean {
  const expected = process.env.PRECLASS_AUDIO_SECRET
  if (!expected) return false
  const provided = req.headers.get('x-preclass-audio-secret')
  if (!provided || provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: z.infer<typeof bodySchema>
  try {
    const parsed = bodySchema.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
    body = parsed.data
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  try {
    const result = await generatePrimer(body.moduleItemId, body.force ?? false)
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'generation failed' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, skipped: result.skipped ?? false }, { status: 200 })
  } catch (err) {
    logger.error('generate-primer route: failed', err)
    return NextResponse.json({ error: 'generation failed' }, { status: 500 })
  }
}
