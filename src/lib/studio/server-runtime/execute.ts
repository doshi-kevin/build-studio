/**
 * The one entry for running a plugin's server action, live or in preview:
 *
 *   1. The manifest declares the action for the caller's view (contract.ts serverAction).
 *   2. Strict arguments, from the manifest's declaration.
 *   3. An executor exists on this server (executor.ts), and the bundle is there.
 *   4. The executor runs it; every capability call comes back to `capability`.
 *   5. The result: JSON within STUDIO_SERVER_ACTION_RESULT_MAX_BYTES, or a plain refusal.
 *
 * Live calls (executeServerAction) arrive through the Bridge's dispatch, which has
 * already resolved the viewer from the session and checked the stale version; this adds
 * the version's bundle, the live capabilities and the audit event. A plugin's own error
 * message goes back to its own frame only: it is never logged.
 */
import 'server-only'
import type { MethodResult } from '../bridge/registry'
import type { StudioViewer } from '../context'
import { loadVersionServerBundle } from '../db'
import { loadHandleKey } from '../handles'
import type { StudioManifest } from '../manifest'
import { viewOf } from '../policy'
import type { PluginView } from '../capabilities'
import { logEvent } from '@/lib/supabase/event-logger'
import { liveCapabilities } from './capabilities'
import { actionArgsSchema, serverAction, type CapabilityHandler, type ExecutionOutcome, type LogEvent } from './contract'
import { pluginExecutor } from './executor'

export const SERVER_UNAVAILABLE = 'This tool’s server isn’t available right now.'
const NOT_AVAILABLE = 'This tool can’t do that here.'
const INVALID = 'This tool sent something it can’t use. Try again, or let your instructor know if it keeps happening.'
const FAILED = 'This tool ran into a problem and couldn’t finish. Try again, or let your instructor know if it keeps happening.'

const REFUSAL: Record<Exclude<ExecutionOutcome, { ok: true }>['reason'], string> = {
  busy: 'This tool’s server is busy. Try again in a moment.',
  timeout: 'This tool took too long to respond. Try again in a moment.',
  crashed: FAILED,
  missing_action: 'This tool can’t do that yet. Let your instructor know.',
  threw: FAILED,
  unserializable: FAILED,
  too_large: FAILED,
  too_many_calls: FAILED,
  protocol: FAILED,
}

export interface ActionInput {
  manifest: StudioManifest
  view: PluginView
  action: string
  args: unknown
  /** Loaded only once the call is allowed. */
  bundle: () => Promise<string | null>
  /** The caller's handle: a student's own, null for staff. Undefined: it couldn't be read. */
  handle: () => Promise<string | null | undefined>
  capability: (def: NonNullable<ReturnType<typeof serverAction>>) => CapabilityHandler
}

export type ActionOutcome = { result: MethodResult; ran: ExecutionOutcome | null }

export async function runServerAction(input: ActionInput): Promise<ActionOutcome> {
  const refuse = (code: Extract<MethodResult, { ok: false }>['code'], message: string): ActionOutcome => ({ result: { ok: false, code, message }, ran: null })
  const def = serverAction(input.manifest, input.view, input.action)
  if (!def) return refuse('not_available', NOT_AVAILABLE)
  const args = actionArgsSchema(def).safeParse(input.args ?? {})
  if (!args.success) {
    return { result: { ok: false, code: 'invalid', message: INVALID, issues: args.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'args'}: ${i.message}`) }, ran: null }
  }
  const executor = pluginExecutor()
  // 'failed', not 'unavailable': that code makes the host stop the whole frame.
  if (!executor) return refuse('failed', SERVER_UNAVAILABLE)
  const [bundle, handle] = await Promise.all([input.bundle(), input.handle()])
  if (!bundle || handle === undefined) return refuse('failed', FAILED)

  const ran = await executor.execute(
    { bundle, action: input.action, argsJson: JSON.stringify(args.data), caller: { role: input.view, handle }, now: new Date().toISOString() },
    input.capability(def),
  )
  if (!ran.ok) return { result: { ok: false, code: 'failed', message: ran.reason === 'threw' && ran.message ? ran.message : REFUSAL[ran.reason] }, ran }
  try {
    return { result: { ok: true, data: JSON.parse(ran.resultJson) as unknown }, ran }
  } catch {
    return { result: { ok: false, code: 'failed', message: FAILED }, ran }
  }
}

// Versions never change: a version's bundle is read once per server process.
const bundles = new Map<string, string>()
const BUNDLE_CACHE_MAX = 64

async function versionBundle(versionId: string): Promise<string | null> {
  const cached = bundles.get(versionId)
  if (cached) return cached
  const bundle = await loadVersionServerBundle(versionId)
  if (bundle) {
    if (bundles.size >= BUNDLE_CACHE_MAX) bundles.delete(bundles.keys().next().value!)
    bundles.set(versionId, bundle)
  }
  return bundle
}

const auditLogs = (viewer: StudioViewer, action: string, logs: LogEvent[]) => {
  for (const event of logs) {
    logEvent({
      userId: viewer.userId,
      eventType: 'studio.plugin.event',
      eventCategory: 'studio',
      sectionId: viewer.sectionId,
      metadata: { installationId: viewer.installationId, versionId: viewer.versionId, action, name: event.name, data: event.data },
    })
  }
}

/** A live server.call from the Bridge, for a viewer resolveViewer built. */
export async function executeServerAction(viewer: StudioViewer, action: string, args: unknown): Promise<MethodResult> {
  const view = viewOf(viewer.role)
  const started = Date.now()
  const { result, ran } = await runServerAction({
    manifest: viewer.manifest,
    view,
    action,
    args,
    bundle: () => versionBundle(viewer.versionId),
    handle: async () => {
      if (viewer.role !== 'student') return null
      const key = await loadHandleKey(viewer.installationId)
      return key ? key.of(viewer.userId) : undefined
    },
    capability: (def) => liveCapabilities(viewer, def),
  })
  if (ran) {
    // Identifiers, the outcome and the time only: never arguments, results or the plugin's messages.
    logEvent({
      userId: viewer.userId,
      eventType: 'studio.server.action',
      eventCategory: 'studio',
      sectionId: viewer.sectionId,
      metadata: { installationId: viewer.installationId, versionId: viewer.versionId, action, ok: ran.ok, reason: ran.ok ? null : ran.reason, ms: Date.now() - started },
    })
    auditLogs(viewer, action, ran.logs)
  }
  return result
}
