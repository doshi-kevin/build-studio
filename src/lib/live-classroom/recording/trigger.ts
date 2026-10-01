// Fire-and-forget kick for recording finalization. Mirrors the Class Insights
// kick (insights/trigger.ts): POST to the internal finalize route with a shared
// secret and don't block on the response. A failed kick never fails endRoom.
// As with the insights kick, no sweep covers this job — see that file's note.

import 'server-only'

import { logger } from '@/lib/logger'
import { getSiteUrl } from '@/lib/site-url'

function resolveFinalizeUrl(): string {
  const fromEnv = process.env.LC_RECORDING_KICK_URL
  if (fromEnv) return fromEnv
  // See insights/trigger.ts: the old NEXT_PUBLIC_APP_URL / VERCEL_URL chain is
  // unset on Cloud Run, so this resolved to localhost:3000 and was refused.
  const siteUrl = getSiteUrl()
  const base = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`
  return `${base.replace(/\/$/, '')}/api/live-classroom/recording/finalize`
}

/** Kick recording finalization for a room. Returns whether accepted; never throws. */
export async function triggerRecordingFinalize(
  roomId: string,
): Promise<{ kicked: boolean; error?: string }> {
  // Own secret, falling back to the insights secret so no new env config is
  // required in environments that already run Class Insights.
  const secret = process.env.LC_RECORDING_SECRET ?? process.env.LC_INSIGHTS_SECRET ?? ''
  if (!secret) {
    logger.warn('triggerRecordingFinalize: no secret set, skipping kick (sweep will pick up)', { roomId })
    return { kicked: false, error: 'secret not set' }
  }

  const url = resolveFinalizeUrl()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 500)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lc-recording-secret': secret },
      body: JSON.stringify({ roomId }),
      signal: controller.signal,
    })
    return { kicked: res.ok, error: res.ok ? undefined : `kick responded ${res.status}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.toLowerCase().includes('abort')) return { kicked: true }
    logger.warn('triggerRecordingFinalize: kick failed (sweep will pick up)', { roomId, error: message })
    return { kicked: false, error: message }
  } finally {
    clearTimeout(timeoutId)
  }
}
