/**
 * The Scholera Bridge envelope, version 1. Pure and dependency-free, because it runs in
 * the browser (the host) and in tests. The runtime inside the frame speaks the same
 * shapes from public/studio-runtime/v1/runtime.js. Contract:
 * docs/reference/studio-plugin-runtime.md.
 *
 * Everything that arrives from a frame is untrusted. parseFrameMessage is the only way
 * a frame message becomes typed data.
 */

/** Runtimes the platform serves. Older ones stay served (rule 8.7). */
export const BRIDGE_VERSIONS = ['v1'] as const
export type RuntimeVersion = (typeof BRIDGE_VERSIONS)[number]

export const isSupportedRuntime = (runtime: string): runtime is RuntimeVersion =>
  (BRIDGE_VERSIONS as readonly string[]).includes(runtime)

export type PluginView = 'student' | 'professor'

export type FrameMessage =
  | { type: 'hello'; runtime: string }
  | { type: 'request'; session: string; id: string; method: string; args: unknown }
  | { type: 'crash'; session: string; message: string }

/** What the plugin learns in the handshake. No user, section, institution or
 * installation IDs ever go here (rule 2.5). */
export interface WelcomeContext {
  runtime: RuntimeVersion
  view: PluginView
  theme: 'light'
}

/** `unavailable`: this viewer can't use this installation at all any more (hidden,
 * Studio switched off, release gate closed, or it never existed: one answer for all, so
 * it reveals nothing). The host stops the frame. `full`: the installation's storage
 * quota refused a write. */
export type BridgeErrorCode =
  | 'not_available'
  | 'invalid'
  | 'conflict'
  | 'rate_limited'
  | 'unsupported'
  | 'failed'
  | 'stale'
  | 'unavailable'
  | 'full'

/** What the host's status heartbeat learns about its frame. */
export type FrameStatus = 'available' | 'readOnly' | 'unavailable' | 'stale'

export type HostMessage =
  | { type: 'welcome'; session: string; context: WelcomeContext }
  | { type: 'response'; session: string; id: string; ok: true; data: unknown }
  | { type: 'response'; session: string; id: string; ok: false; error: { code: BridgeErrorCode; message: string; issues?: string[] } }

const SESSION = /^[0-9a-f-]{36}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const METHOD = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

function sizeOf(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length
  } catch {
    return Number.POSITIVE_INFINITY // cyclic or otherwise unserializable
  }
}

/** A frame message, or null for anything that isn't exactly one of the v1 shapes. */
export function parseFrameMessage(data: unknown, maxBytes: number): FrameMessage | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const m = data as Record<string, unknown>
  if (m.scholera !== 'bridge' || m.v !== 1) return null

  if (m.type === 'hello') {
    return typeof m.runtime === 'string' && m.runtime.length <= 16 ? { type: 'hello', runtime: m.runtime } : null
  }
  if (typeof m.session !== 'string' || !SESSION.test(m.session)) return null

  if (m.type === 'request') {
    if (typeof m.id !== 'string' || !REQUEST_ID.test(m.id)) return null
    if (typeof m.method !== 'string' || m.method.length > 64 || !METHOD.test(m.method)) return null
    if (sizeOf(m.args) > maxBytes) return null
    return { type: 'request', session: m.session, id: m.id, method: m.method, args: m.args }
  }
  if (m.type === 'crash') {
    return typeof m.message === 'string' ? { type: 'crash', session: m.session, message: m.message.slice(0, 500) } : null
  }
  return null
}

/** Adds the envelope header to a host message. */
export const envelope = (message: HostMessage) => ({ scholera: 'bridge' as const, v: 1 as const, ...message })
