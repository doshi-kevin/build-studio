/**
 * Serves one plugin frame document on the runtime origin, for the route
 * src/app/studio-frame/v1/[installationId]/[view]/route.ts.
 *
 * It trusts nothing in the request except a valid ticket: the host must be the runtime
 * origin, the ticket must verify and be unexpired, and the path must name the same
 * installation and view as the ticket, and Studio must not be switched off (the kill
 * switch, read fresh, failing closed). Every failure is the same plain 404, so the route
 * can't be used to probe which installations exist.
 */
import 'server-only'
import { randomBytes } from 'node:crypto'
import { studioKillSwitchEngaged } from '../access'
import { loadSnapshotBundle, loadVersionBundle } from '../db'
import { frameHeaders, frameHtml } from './frame-document'
import { frameTicketSecret, verifyDraftFrameTicket, verifyFrameTicket } from './frame-ticket'
import { studioOrigins } from './origin'

const notFound = () =>
  new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })

export async function frameResponse(host: string, installationId: string, view: string, token: string | null): Promise<Response> {
  const origins = studioOrigins()
  const secret = frameTicketSecret()
  if (!origins || !secret || host !== new URL(origins.runtime).host) return notFound()

  const ticket = verifyFrameTicket(token, secret)
  if (!ticket || ticket.installationId !== installationId || ticket.view !== view) return notFound()
  if (await studioKillSwitchEngaged()) return notFound()

  const bundle = await loadVersionBundle(ticket.versionId, ticket.view)
  if (!bundle) return notFound()

  const input = {
    appOrigin: origins.app,
    runtimeOrigin: origins.runtime,
    nonce: randomBytes(18).toString('base64'),
    bundle: bundle.code,
    title: bundle.name,
  }
  return new Response(frameHtml(input), { status: 200, headers: frameHeaders(input) })
}

/** The draft preview frame, for src/app/studio-frame/v1/draft/[projectId]/[view]/route.ts.
 * The same checks as an installation frame, against a draft ticket, and the same
 * document and headers: a draft gets no privilege a published version lacks. */
export async function draftFrameResponse(host: string, projectId: string, view: string, token: string | null): Promise<Response> {
  const origins = studioOrigins()
  const secret = frameTicketSecret()
  if (!origins || !secret || host !== new URL(origins.runtime).host) return notFound()

  const ticket = verifyDraftFrameTicket(token, secret)
  if (!ticket || ticket.projectId !== projectId || ticket.view !== view) return notFound()
  if (await studioKillSwitchEngaged()) return notFound()

  const bundle = await loadSnapshotBundle(ticket.projectId, ticket.hash, ticket.view)
  if (!bundle) return notFound()

  const input = {
    appOrigin: origins.app,
    runtimeOrigin: origins.runtime,
    nonce: randomBytes(18).toString('base64'),
    bundle: bundle.code,
    title: bundle.name,
  }
  return new Response(frameHtml(input), { status: 200, headers: frameHeaders(input) })
}
