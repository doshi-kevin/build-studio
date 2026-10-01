// Fire-and-forget kick for Pre-Class Primer generation. Mirrors the Class
// Insights kick (lib/live-classroom/insights/trigger.ts): resolve our own
// public URL, POST to the internal generation route with a shared secret, and
// don't block on the (long-running) response. Fired by the professor's
// "Make primer available" / "Regenerate" action in the Modules UI.

import 'server-only'

import { logger } from '@/lib/logger'
import { getSiteUrl } from '@/lib/site-url'

function resolvePrimerUrl(): string {
  const fromEnv = process.env.PRECLASS_AUDIO_KICK_URL
  if (fromEnv) return fromEnv
  // See live-classroom/insights/trigger.ts: the old NEXT_PUBLIC_APP_URL /
  // VERCEL_URL chain is unset on Cloud Run, so this resolved to localhost:3000.
  const siteUrl = getSiteUrl()
  const base = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`
  return `${base.replace(/\/$/, '')}/api/preclass-audio/generate`
}

/** Kick generation for one lecture item. `force` regenerates even if a fresh
 *  primer already exists (professor Regenerate). Never throws. */
export async function triggerPrimer(
  moduleItemId: string,
  force = false,
): Promise<{ kicked: boolean; error?: string }> {
  const secret = process.env.PRECLASS_AUDIO_SECRET ?? ''
  if (!secret) {
    logger.warn('triggerPrimer: PRECLASS_AUDIO_SECRET not set, skipping kick', { moduleItemId })
    return { kicked: false, error: 'secret not set' }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 500)
  try {
    const res = await fetch(resolvePrimerUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-preclass-audio-secret': secret },
      body: JSON.stringify({ moduleItemId, force }),
      signal: controller.signal,
    })
    return { kicked: res.ok, error: res.ok ? undefined : `kick responded ${res.status}` }
  } catch (err) {
    // AbortError is expected — we dispatched the request and bailed on the
    // long-running response. Generation continues server-side.
    const message = err instanceof Error ? err.message : String(err)
    if (message.toLowerCase().includes('abort')) return { kicked: true }
    logger.warn('triggerPrimer: kick fetch failed', { moduleItemId, error: message })
    return { kicked: false, error: message }
  } finally {
    clearTimeout(timeoutId)
  }
}
