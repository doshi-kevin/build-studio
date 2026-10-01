// Fire-and-forget kick for Class Insights generation. Mirrors the extraction
// worker handshake (lib/extraction/enqueue.ts): resolve our own public URL,
// POST to the internal generation route with a shared secret, and don't block
// on the response. A failed kick never fails endRoom.
//
// NOTE on the fallback: this job is NOT in the `background_jobs` queue, so
// `jobs-worker-sweep` (Cloud Scheduler) does NOT cover it, and the GHA
// `jobs-sweep.yml` has been dead since 2026-07-17. **Lazy-on-view is the only
// fallback** — if this kick fails, nothing generates until someone opens the
// report and waits through it. Keep that in mind before weakening it.

import 'server-only'

import { logger } from '@/lib/logger'
import { getSiteUrl } from '@/lib/site-url'

function resolveInsightsUrl(): string {
  const fromEnv = process.env.LC_INSIGHTS_KICK_URL
  if (fromEnv) return fromEnv
  // getSiteUrl() reads runtime SITE_URL first. The previous chain used
  // NEXT_PUBLIC_APP_URL / VERCEL_URL — neither of which is set on Cloud Run — so
  // this kick silently resolved to localhost:3000 against a container listening
  // on 8080, and every kick was refused in production.
  const siteUrl = getSiteUrl()
  const base = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`
  return `${base.replace(/\/$/, '')}/api/live-classroom/generate-insights`
}

/**
 * Kick off Class Insights generation for an ended room. Returns whether the
 * request was accepted; never throws (callers ignore the result).
 */
export async function triggerClassInsights(roomId: string): Promise<{ kicked: boolean; error?: string }> {
  // Same chain the receiving route verifies against, so sender and receiver
  // cannot disagree — see api/live-classroom/generate-insights/route.ts.
  const secret = process.env.LC_INSIGHTS_SECRET ?? process.env.LC_RECORDING_SECRET ?? ''
  if (!secret) {
    logger.warn(
      'triggerClassInsights: no LC_INSIGHTS_SECRET or LC_RECORDING_SECRET set, skipping kick — nothing will generate until someone opens the report',
      { roomId },
    )
    return { kicked: false, error: 'secret not set' }
  }

  const url = resolveInsightsUrl()
  // 500ms is enough to dispatch the request (the generation route then runs as
  // its own Cloud Run request regardless); we deliberately don't wait for the
  // long-running response. Keeps End Class snappy.
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 500)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lc-insights-secret': secret },
      body: JSON.stringify({ roomId }),
      signal: controller.signal,
    })
    return { kicked: res.ok, error: res.ok ? undefined : `kick responded ${res.status}` }
  } catch (err) {
    // AbortError is expected — we dispatched the request and bailed on the
    // (long-running) response body. The generation continues server-side.
    const message = err instanceof Error ? err.message : String(err)
    if (message.toLowerCase().includes('abort')) return { kicked: true }
    logger.warn('triggerClassInsights: kick fetch failed — falls back to lazy on-view generation', {
      roomId,
      error: message,
    })
    return { kicked: false, error: message }
  } finally {
    clearTimeout(timeoutId)
  }
}
