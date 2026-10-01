// Client-side reaction send helper. Reactions go directly over the ephemeral
// private channel — no server hop, no persistence — so the professor's live
// aggregate updates in <100ms. Mirrors send-stroke.ts.

'use client'

import type { RealtimeChannel, RealtimeChannelSendResponse } from '@supabase/supabase-js'
import type { ReactionData } from '@/lib/live-classroom/broadcast/types'

/**
 * Returns Supabase's send status: 'ok' | 'timed out' | 'error'. It RESOLVES with a
 * failure rather than rejecting, so a caller that only attaches `.catch()` cannot
 * tell a delivered reaction from a dropped one — which is how students came to see
 * "Sent" for reactions the professor never received (#641). Callers must branch on
 * this value.
 */
export async function sendReaction(
  ephemChannel: RealtimeChannel,
  data: ReactionData,
): Promise<RealtimeChannelSendResponse> {
  return ephemChannel.send({
    type: 'broadcast',
    event: 'reaction',
    // Match the LcEnvelope shape: ephemeral events have seq=null.
    payload: {
      seq: null,
      ts: new Date().toISOString(),
      type: 'reaction',
      data,
    },
  })
}
