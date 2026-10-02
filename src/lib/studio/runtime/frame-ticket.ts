/**
 * Frame tickets: how a page on the app origin authorizes one frame document on the
 * runtime origin.
 *
 * The runtime origin is a different site, so the browser sends it no session cookie and
 * it can't call resolveViewer. Instead the app origin, which has the session, decides
 * who may load which view of which installation and signs that decision. The frame route
 * on the runtime origin checks the signature and the expiry and serves exactly that.
 *
 * The signature stops someone holding one ticket from changing it. Without it, a student
 * could ask the runtime origin for the professor view of a version they know. A ticket
 * holds the installation, version, view and expiry; never a user (rule 2.5). The plugin
 * can read its own frame URL, so a ticket isn't a secret, only tamper-proof and short-lived.
 */
import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { candidateVersion, resolveViewer } from '../context'
import { STUDIO_FRAME_TICKET_TTL_MS } from '../limits'
import { studioOrigins } from './origin'
import type { PluginView } from './protocol'

export interface FrameTicket {
  installationId: string
  versionId: string
  view: PluginView
  expiresAt: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function ticketSecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.STUDIO_FRAME_TICKET_SECRET
  return secret && secret.length >= 32 ? secret : null
}

const mac = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url')

export function signFrameTicket(ticket: FrameTicket, secret: string): string {
  const body = Buffer.from(
    JSON.stringify({ i: ticket.installationId, r: ticket.versionId, w: ticket.view, e: ticket.expiresAt }),
  ).toString('base64url')
  return `${body}.${mac(body, secret)}`
}

/** The ticket, or null if it's malformed, tampered with, signed with another secret, or expired. */
export function verifyFrameTicket(token: string | null, secret: string, now = Date.now()): FrameTicket | null {
  if (!token || token.length > 512) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra !== undefined) return null

  const expected = Buffer.from(mac(body, secret))
  const given = Buffer.from(signature)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const t = raw as Record<string, unknown>
  if (
    typeof t?.i !== 'string' || !UUID.test(t.i) ||
    typeof t.r !== 'string' || !UUID.test(t.r) ||
    (t.w !== 'student' && t.w !== 'professor') ||
    typeof t.e !== 'number' || t.e <= now
  ) {
    return null
  }
  return { installationId: t.i, versionId: t.r, view: t.w, expiresAt: t.e }
}

export function frameTicketSecret(): string | null {
  return ticketSecret()
}

/**
 * The frame URL for this viewer, or null. A student may load only the student view.
 * Staff may load either: the professor view, or the student view to preview it (that
 * preview still runs on the host-only mock bridge, never real data).
 *
 * `candidateVersionId`: the section's professor previewing another published version of
 * the same project before activating it. Always previewed on the mock bridge by the
 * page; if its ticket were ever used with the live bridge, every call would be answered
 * `stale`, because the server only works with the installation's current version.
 */
export async function issueFrameUrl(
  installationId: string,
  view: PluginView,
  candidateVersionId?: string,
): Promise<string | null> {
  const origins = studioOrigins()
  const secret = ticketSecret()
  if (!origins || !secret) return null

  const viewer = await resolveViewer(installationId)
  if (!viewer) return null
  if (viewer.role === 'student' && view !== 'student') return null

  let versionId = viewer.versionId
  if (candidateVersionId) {
    const candidate = await candidateVersion(viewer, candidateVersionId)
    if (!candidate) return null
    versionId = candidate.versionId
  }

  const ticket = signFrameTicket(
    {
      installationId: viewer.installationId,
      versionId,
      view,
      expiresAt: Date.now() + STUDIO_FRAME_TICKET_TTL_MS,
    },
    secret,
  )
  return `${origins.runtime}/studio-frame/v1/${viewer.installationId}/${view}?t=${ticket}`
}

// ── Draft tickets (the builder's preview, before any version exists) ──
// Keyed by project and snapshot hash, never by a user. Signed with a key derived for
// this purpose alone, so an installation ticket never verifies as a draft ticket and a
// draft ticket never verifies as an installation ticket.

export interface DraftFrameTicket {
  projectId: string
  hash: string
  view: PluginView
  expiresAt: number
}

const HASH = /^[0-9a-f]{64}$/
const draftKey = (secret: string) => createHmac('sha256', secret).update('studio-draft-frame-v1').digest('base64url')

export function signDraftFrameTicket(ticket: DraftFrameTicket, secret: string): string {
  const body = Buffer.from(JSON.stringify({ k: 'draft', p: ticket.projectId, h: ticket.hash, w: ticket.view, e: ticket.expiresAt })).toString('base64url')
  return `${body}.${mac(body, draftKey(secret))}`
}

export function verifyDraftFrameTicket(token: string | null, secret: string, now = Date.now()): DraftFrameTicket | null {
  if (!token || token.length > 512) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra !== undefined) return null
  const expected = Buffer.from(mac(body, draftKey(secret)))
  const given = Buffer.from(signature)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const t = raw as Record<string, unknown>
  if (
    t?.k !== 'draft' ||
    typeof t.p !== 'string' || !UUID.test(t.p) ||
    typeof t.h !== 'string' || !HASH.test(t.h) ||
    (t.w !== 'student' && t.w !== 'professor') ||
    typeof t.e !== 'number' || t.e <= now
  ) {
    return null
  }
  return { projectId: t.p, hash: t.h, view: t.w, expiresAt: t.e }
}

/** A draft frame URL for a snapshot the caller has already authorized, or null when the
 * runtime isn't configured. The builder service is the only caller. */
export function draftFrameUrl(projectId: string, hash: string, view: PluginView): string | null {
  const origins = studioOrigins()
  const secret = ticketSecret()
  if (!origins || !secret) return null
  const ticket = signDraftFrameTicket({ projectId, hash, view, expiresAt: Date.now() + STUDIO_FRAME_TICKET_TTL_MS }, secret)
  return `${origins.runtime}/studio-frame/v1/draft/${projectId}/${view}?t=${ticket}`
}
