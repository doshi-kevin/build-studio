// The Scholera Bridge: the one door from a plugin into Scholera. The host (Scholera's
// own page code) calls it; plugin code can't, because its frame has no network access.
// This handler does HTTP only: origin, content type, size, JSON, session, rate limit.
// Studio decisions are in dispatch() and Step 3. Every refusal is generic: no database
// detail, no stack trace. docs/reference/studio-plugin-runtime.md, "The bridge".
import { resolveViewer, sessionUserId } from '@/lib/studio/context'
import { dispatch } from '@/lib/studio/bridge/dispatch'
import { parseBridgeEnvelope } from '@/lib/studio/bridge/envelope'
import { readBodyCapped } from '@/lib/studio/bridge/read-body'
import { methodSpec } from '@/lib/studio/bridge/catalog'
import { RETRY_AFTER_SECONDS, takeBridgeCall } from '@/lib/studio/bridge/rate-limit'
import { frameStatusFor } from '@/lib/studio/bridge/status'
import { STUDIO_BRIDGE_MAX_MESSAGE_BYTES } from '@/lib/studio/limits'
import { studioOrigins } from '@/lib/studio/runtime/origin'
import type { BridgeErrorCode } from '@/lib/studio/runtime/protocol'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

const respond = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } })

const refuse = (status: number, code: BridgeErrorCode, message: string, extra?: Record<string, string>) =>
  respond(status, { ok: false, error: { code, message } }, extra)

const NOT_AVAILABLE = 'This isn’t available.'
const BAD_REQUEST = 'This request isn’t valid.'
const STALE = 'A newer version of this tool is in use. Reload to continue.'
const UNAVAILABLE = 'This tool isn’t available right now.'

const isJson = (contentType: string | null) => contentType?.split(';')[0].trim().toLowerCase() === 'application/json'

export async function POST(request: Request) {
  try {
    const origins = studioOrigins()
    if (!origins) return refuse(404, 'not_available', NOT_AVAILABLE)
    // Only Scholera's own pages may call the bridge. A plugin frame can't send any
    // request at all; this stops other sites riding a signed-in session.
    if (request.headers.get('origin') !== origins.app) return refuse(403, 'not_available', NOT_AVAILABLE)
    if (!isJson(request.headers.get('content-type'))) return refuse(415, 'invalid', BAD_REQUEST)

    const body = await readBodyCapped(request, STUDIO_BRIDGE_MAX_MESSAGE_BYTES)
    if (!body.ok) {
      return body.reason === 'too-large' ? refuse(413, 'invalid', 'This request is too large.') : refuse(400, 'invalid', BAD_REQUEST)
    }
    let raw: unknown
    try {
      raw = JSON.parse(body.text)
    } catch {
      return refuse(400, 'invalid', BAD_REQUEST)
    }
    const envelope = parseBridgeEnvelope(raw)
    if (!envelope) return refuse(400, 'invalid', BAD_REQUEST)

    const userId = await sessionUserId()
    if (!userId) return refuse(401, 'not_available', NOT_AVAILABLE)

    const kind = envelope.type === 'call' ? (methodSpec(envelope.method)?.kind ?? 'read') : 'read'
    if (!takeBridgeCall(userId, envelope.installationId, kind)) {
      return refuse(429, 'rate_limited', 'Too many requests. Wait a moment and try again.', {
        'Retry-After': String(RETRY_AFTER_SECONDS),
      })
    }

    // Step 3: the session, the installation, the role, visibility, the kill switch and
    // the current version. The ID in the request is a claim; this is what checks it.
    const viewer = await resolveViewer(envelope.installationId)

    // The host's heartbeat: one of four states, nothing more.
    if (envelope.type === 'status') {
      return respond(200, { ok: true, data: { status: frameStatusFor(viewer, envelope.expectedVersionId) } })
    }

    // Hidden, Studio switched off, release gate closed, enrollment gone, or never existed:
    // the same answer for all of them. The host stops the frame on it.
    if (!viewer) return respond(200, { ok: false, error: { code: 'unavailable', message: UNAVAILABLE } })

    if (envelope.type === 'event') {
      // A runtime stop worth knowing about. Identifiers and the reason only: never
      // plugin data, crash text or anything a student wrote.
      logEvent({
        userId,
        eventType: 'studio.runtime.stopped',
        eventCategory: 'studio',
        sectionId: viewer.sectionId,
        metadata: { installationId: viewer.installationId, versionId: viewer.versionId, reason: envelope.reason },
      })
      return respond(200, { ok: true, data: null })
    }

    // The frame was built for another version: a newer one, or an older one after a
    // rollback. Refuse before dispatching, so a stale frame can't read or write; the host
    // then asks for a reload. The version itself is never taken from the request.
    if (envelope.expectedVersionId !== viewer.versionId) {
      return respond(200, { ok: false, error: { code: 'stale', message: STALE } })
    }

    const result = await dispatch(viewer, envelope)
    return respond(
      200,
      result.ok
        ? { ok: true, data: result.data }
        : { ok: false, error: { code: result.code, message: result.message, ...(result.issues ? { issues: result.issues } : {}) } },
    )
  } catch (error) {
    logger.error('studio/bridge.POST', error)
    return refuse(500, 'failed', 'Something went wrong. Try again.')
  }
}
