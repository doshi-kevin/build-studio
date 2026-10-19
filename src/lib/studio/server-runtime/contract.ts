/**
 * The plugin server runtime's contract, shared by every executor and by the live and
 * preview capability hosts. Pure.
 *
 *   executePluginAction (execute.ts)      the trusted entry: role, arguments, bundle, audit
 *     -> PluginExecutor.execute            runs one action of one bundle, somewhere isolated
 *          -> CapabilityHandler            every request the plugin's code makes comes back
 *                                          here, to trusted code, as data
 *
 * An executor never receives a credential, a database client or a session. It gets the
 * compiled bundle, the action's name, its arguments as JSON and the caller's role and
 * handle; everything else is a capability call it sends back. That is what lets a
 * container executor replace the local one without any plugin changing.
 */
import { z } from 'zod'
import { STUDIO_RECORD_PAGE_MAX } from '../limits'
import type { ServerActionDef, StudioManifest } from '../manifest'
import type { PluginView } from '../capabilities'

/** Every capability a plugin's server code can ask for. A method not listed here doesn't exist. */
export const CAPABILITY_METHODS = ['records.list', 'records.get', 'records.create', 'records.update', 'records.delete', 'course.get'] as const
export type CapabilityMethod = (typeof CAPABILITY_METHODS)[number]

const collection = z.string().max(40)
const recordId = z.string().max(64)
const handle = z.string().max(40)

/** Strict shapes for each capability's parameters. records.ts parses them again. */
export const CAPABILITY_PARAMS: Record<CapabilityMethod, z.ZodType> = {
  'records.list': z.strictObject({ collection, limit: z.number().int().min(1).max(STUDIO_RECORD_PAGE_MAX).optional(), offset: z.number().int().min(0).max(100_000).optional() }),
  'records.get': z.strictObject({ collection, recordId }),
  'records.create': z.strictObject({ collection, data: z.unknown(), student: handle.optional() }),
  'records.update': z.strictObject({ collection, recordId, data: z.unknown(), expectedUpdatedAt: z.string().max(64).optional() }),
  'records.delete': z.strictObject({ collection, recordId }),
  'course.get': z.strictObject({}),
}

export const isCapabilityMethod = (m: unknown): m is CapabilityMethod => typeof m === 'string' && (CAPABILITY_METHODS as readonly string[]).includes(m)

export type CapabilityResult = { ok: true; data: unknown } | { ok: false; message: string }
/** Trusted code answering one capability call. Never throws for a refusal: it returns one. */
export type CapabilityHandler = (method: CapabilityMethod, params: unknown) => Promise<CapabilityResult>

export interface LogEvent {
  name: string
  data: Record<string, string | number | boolean>
}

export interface ExecutionRequest {
  /** The compiled server bundle (builder/compile.ts): a script whose value is the entry's exports. */
  bundle: string
  action: string
  /** The validated arguments, as JSON. */
  argsJson: string
  caller: { role: PluginView; handle: string | null }
  /** ISO time the call started: what ctx.now() returns. */
  now: string
}

export type ExecutionFailure = 'busy' | 'timeout' | 'crashed' | 'missing_action' | 'threw' | 'unserializable' | 'too_large' | 'too_many_calls' | 'protocol'
export type ExecutionOutcome =
  | { ok: true; resultJson: string; logs: LogEvent[] }
  | { ok: false; reason: ExecutionFailure; /** The plugin's own error message, for its own frame only. */ message?: string; logs: LogEvent[] }

/** Runs one action somewhere isolated. Implementations: LocalProcessExecutor (local-executor.ts) today. */
export interface PluginExecutor {
  readonly kind: 'local' | 'container'
  execute(request: ExecutionRequest, capability: CapabilityHandler): Promise<ExecutionOutcome>
}

/** The action a viewer of this view may call, or null: not declared, or not for their role. */
export function serverAction(manifest: StudioManifest, view: PluginView, action: string): ServerActionDef | null {
  if (manifest.manifestVersion !== 2 || !manifest.server) return null
  const def = Object.hasOwn(manifest.server.actions, action) ? manifest.server.actions[action] : null
  return def && def.roles.includes(view) ? def : null
}

/** Whether this view may call any server action: what grants the server.call method. */
export const hasServerActions = (manifest: StudioManifest, view: PluginView) =>
  manifest.manifestVersion === 2 && !!manifest.server && Object.values(manifest.server.actions).some((a) => a.roles.includes(view))

const ARG: Record<'text' | 'number' | 'boolean' | 'json', z.ZodType> = {
  text: z.string().max(10_000),
  number: z.number().finite(),
  boolean: z.boolean(),
  json: z.unknown().refine((v) => v !== undefined, 'Required'),
}

/** The strict argument schema an action's manifest declares. */
export function actionArgsSchema(def: ServerActionDef): z.ZodType {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, type] of Object.entries(def.args)) {
    const optional = type.endsWith('?')
    const base = ARG[type.replace('?', '') as keyof typeof ARG]
    shape[name] = optional ? base.optional() : base
  }
  return z.strictObject(shape)
}

/** A log.event from plugin code: a camelCase name and up to 8 short scalar values, or null. */
const logSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/),
  data: z
    .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), z.union([z.string().max(100), z.number().finite(), z.boolean()]))
    .refine((d) => Object.keys(d).length <= 8)
    .optional(),
})
export function parseLogEvent(raw: unknown): LogEvent | null {
  const parsed = logSchema.safeParse(raw)
  return parsed.success ? { name: parsed.data.name, data: parsed.data.data ?? {} } : null
}
