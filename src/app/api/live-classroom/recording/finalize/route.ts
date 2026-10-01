// POST /api/live-classroom/recording/finalize
//
// Concatenates a room's recorded audio sessions and marks the recording ready.
// Called two ways (mirrors generate-insights):
//   1. endRoom fires a fire-and-forget POST here when a recording class ends.
//   2. A GHA sweep (follow-up) re-POSTs for stuck/failed recordings.
//
// Auth: a shared secret in the x-lc-recording-secret header (Cloud Run env
// only). Finalize runs under the admin client, so this gate is the access
// control. Runtime: 'nodejs' — it downloads/uploads binary audio.

import 'server-only'
import { timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { finalizeRecording } from '@/lib/live-classroom/recording/finalize'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const bodySchema = z.object({ roomId: z.string().uuid() })

function verifySecret(req: NextRequest): boolean {
  const expected = process.env.LC_RECORDING_SECRET ?? process.env.LC_INSIGHTS_SECRET
  if (!expected) return false
  const provided = req.headers.get('x-lc-recording-secret')
  if (!provided || provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
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
    const result = await finalizeRecording(roomId)
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'finalize failed' }, { status: 500 })
    }
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    logger.error('recording finalize route: failed', err, { roomId })
    return NextResponse.json({ error: 'finalize failed' }, { status: 500 })
  }
}
