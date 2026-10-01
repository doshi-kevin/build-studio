/**
 * Every method a plugin can call, in one place, shared by the host (browser) and the
 * server. A method not listed here doesn't exist.
 *
 * For each method:
 *   runs        'host': answered by Scholera's page, never sent to the server.
 *               'server': sent to POST /api/studio/bridge and handled by registry.ts.
 *   capability  the manifest capability the current view must declare, or null when a
 *               declared collection is what grants access (records).
 *   views       which views may call it at all.
 *   kind        'read' or 'write', for rate limits and read-only installations.
 *   args        the strict argument schema.
 *
 * Adding a capability later (course memory, AI, notifications, grading) means one entry
 * here and, for a server method, one handler in registry.ts. Nothing else in the bridge
 * changes. Pure, so the host can import it.
 */
import { z } from 'zod'
import { CAPABILITIES, type CapabilityName } from '../capabilities'
import { STUDIO_RECORD_PAGE_MAX, STUDIO_TOAST_MAX_CHARS } from '../limits'
import type { StudioManifest } from '../manifest'
import type { PluginView } from '../runtime/protocol'

export interface MethodSpec {
  runs: 'host' | 'server'
  capability: CapabilityName | null
  views: readonly PluginView[]
  kind: 'read' | 'write'
  args: z.ZodType
}

const BOTH = ['student', 'professor'] as const
const collection = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/)
const recordId = z.uuid()

// Record arguments never include the installation: it is the verified viewer's.
export const METHOD_CATALOG = {
  'context.get': { runs: 'server', capability: 'context.get', views: BOTH, kind: 'read', args: z.strictObject({}) },
  'course.skills': { runs: 'server', capability: 'course.skills', views: BOTH, kind: 'read', args: z.strictObject({}) },
  'records.list': {
    runs: 'server',
    capability: null,
    views: BOTH,
    kind: 'read',
    args: z.strictObject({
      collection,
      limit: z.number().int().min(1).max(STUDIO_RECORD_PAGE_MAX).optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
    }),
  },
  'records.get': { runs: 'server', capability: null, views: BOTH, kind: 'read', args: z.strictObject({ collection, recordId }) },
  'records.create': {
    runs: 'server',
    capability: null,
    views: BOTH,
    kind: 'write',
    args: z.strictObject({ collection, data: z.unknown() }),
  },
  'records.update': {
    runs: 'server',
    capability: null,
    views: BOTH,
    kind: 'write',
    args: z.strictObject({ collection, recordId, data: z.unknown(), expectedUpdatedAt: z.string().max(64).optional() }),
  },
  'records.delete': { runs: 'server', capability: null, views: BOTH, kind: 'write', args: z.strictObject({ collection, recordId }) },
  // Host only. The host clamps the height to its own limits; the plugin only asks.
  'ui.resize': {
    runs: 'host',
    capability: 'ui.resize',
    views: BOTH,
    kind: 'read',
    args: z.strictObject({ height: z.number().int().min(0).max(100_000) }),
  },
  // Host only. Plain text, rendered as text; a tone, not a style.
  'ui.toast': {
    runs: 'host',
    capability: 'ui.toast',
    views: BOTH,
    kind: 'read',
    args: z.strictObject({
      message: z.string().trim().min(1).max(STUDIO_TOAST_MAX_CHARS),
      tone: z.enum(['info', 'success', 'error']).optional(),
    }),
  },
} satisfies Record<string, MethodSpec>

export type MethodName = keyof typeof METHOD_CATALOG
export type ServerMethodName = { [K in MethodName]: (typeof METHOD_CATALOG)[K]['runs'] extends 'server' ? K : never }[MethodName]
export type MethodArgs<K extends MethodName> = z.infer<(typeof METHOD_CATALOG)[K]['args']>

export function methodSpec(name: string): MethodSpec | null {
  return Object.hasOwn(METHOD_CATALOG, name) ? METHOD_CATALOG[name as MethodName] : null
}

/** Strict argument parse. A method with no arguments may be called with null. */
export function parseMethodArgs(spec: MethodSpec, args: unknown): { ok: true; args: unknown } | { ok: false } {
  const result = spec.args.safeParse(args === null || args === undefined ? {} : args)
  return result.success ? { ok: true, args: result.data } : { ok: false }
}

/** Whether this view of this manifest may call the method: the view is allowed, and the
 * capability is declared (or, for records, a collection exists). The same rule the host
 * uses to refuse early and the server enforces on every call. */
export function methodAllowed(spec: MethodSpec, manifest: StudioManifest, view: PluginView): boolean {
  if (!spec.views.includes(view)) return false
  if (spec.capability === null) return Object.keys(manifest.collections).length > 0
  return (
    (manifest.views[view].capabilities as readonly string[]).includes(spec.capability) &&
    CAPABILITIES[spec.capability].views.includes(view)
  )
}

/** Every method this view of the manifest may call, host and server alike. */
export function allowedBridgeMethods(manifest: StudioManifest, view: PluginView): string[] {
  return Object.entries(METHOD_CATALOG)
    .filter(([, spec]) => methodAllowed(spec, manifest, view))
    .map(([name]) => name)
}
