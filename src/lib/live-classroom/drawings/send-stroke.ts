// Client-side stroke send helpers. Strokes go directly over the ephemeral
// private channel — no server hop — so other clients receive them in
// <100ms. Persistence is handled separately via persistStrokeBatch().

'use client'

import type { RealtimeChannel } from '@supabase/supabase-js'
import type { Stroke } from './types'

export async function sendStroke(
  ephemChannel: RealtimeChannel,
  stroke: Stroke,
): Promise<void> {
  await ephemChannel.send({
    type: 'broadcast',
    event: 'drawing_stroke',
    // Match the LcEnvelope shape: ephemeral events have seq=null.
    payload: {
      seq: null,
      ts: new Date().toISOString(),
      type: 'drawing_stroke',
      data: stroke,
    },
  })
}

/**
 * Tell every connected viewer to wipe their local strokes for the given
 * slide. Sent on the same ephemeral topic so the latency is identical to
 * a stroke (<100ms). The professor's own client also receives this and
 * clears its canvas — so the fan-out and self-update are symmetric.
 */
export async function sendClear(
  ephemChannel: RealtimeChannel,
  slideIndex: number,
): Promise<void> {
  await ephemChannel.send({
    type: 'broadcast',
    event: 'drawing_clear',
    payload: {
      seq: null,
      ts: new Date().toISOString(),
      type: 'drawing_clear',
      data: { slideIndex },
    },
  })
}
