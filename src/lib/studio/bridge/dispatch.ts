/**
 * Routes one bridge call for a verified viewer. HTTP is the route handler's job; this is
 * the Studio part, and it runs in this order:
 *
 *   1. The method exists in the catalog (catalog.ts).
 *   2. It runs on the server. Host-only methods (ui.*) are answered by the page and are
 *      refused here, whoever sends them.
 *   3. The viewer's view may call it, its capability is declared in the current view of
 *      the manifest (rule 1.5), and the capability is allowed for that view (class-wide
 *      data never reaches a student's frame, rules 4.1 and 4.5).
 *   4. That version is approved for this installation. Satisfied by construction:
 *      viewer.versionId is the installation's current version, and the database
 *      refuses a current version without an approval row for that installation
 *      (Step 2's deferred approval key). V1 approval is all-or-nothing, so the approved
 *      capabilities are exactly this manifest's.
 *   5. Strict argument validation, then the handler (Step 3 for records).
 *
 * The viewer comes from resolveViewer: the session, the installation, the role and the
 * current version, none of it from the request.
 */
import 'server-only'
import type { StudioViewer } from '../context'
import { viewOf } from '../policy'
import { methodAllowed, methodSpec, parseMethodArgs } from './catalog'
import type { BridgeCall } from './envelope'
import { serverHandler, type MethodResult } from './registry'

export const METHOD_UNSUPPORTED = 'This tool asked for something Scholera doesn’t offer.'
export const METHOD_NOT_AVAILABLE = 'This isn’t available.'
export const INVALID_ARGUMENTS = 'This request’s arguments aren’t valid.'

export async function dispatch(viewer: StudioViewer, call: Pick<BridgeCall, 'method' | 'args' | 'host'>): Promise<MethodResult> {
  const spec = methodSpec(call.method)
  const handler = spec?.runs === 'server' ? serverHandler(call.method) : null
  if (!spec || !handler) return { ok: false, code: 'unsupported', message: METHOD_UNSUPPORTED }

  if (!methodAllowed(spec, viewer.manifest, viewOf(viewer.role))) {
    return { ok: false, code: 'not_available', message: METHOD_NOT_AVAILABLE }
  }

  const parsed = parseMethodArgs(spec, call.args)
  if (!parsed.ok) return { ok: false, code: 'invalid', message: INVALID_ARGUMENTS }
  // The catalog's schema produced these arguments for exactly this handler.
  return (handler as (v: StudioViewer, a: unknown, h: typeof call.host) => Promise<MethodResult>)(viewer, parsed.args, call.host)
}
