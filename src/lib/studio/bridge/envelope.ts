/**
 * What the host sends to POST /api/studio/bridge. The host builds it; the plugin
 * supplies only `method` and `args`. There is no field for a user, role, section,
 * institution, version, author or owner, and the schema is strict, so a request
 * carrying one is refused. `installationId` comes from the page, and Step 3 verifies it
 * as a claim (resolveViewer), never trusts it.
 */
import { z } from 'zod'

/** Stops the host reports so they can be logged. Never with plugin data. */
export const LOGGED_STOPS = [
  'navigated',
  'malformed',
  'unsupported-runtime',
  'crashed',
  'start-timeout',
  'hello-timeout',
  'throttled',
] as const

/** The viewer's own browser settings, read by the host from Intl, never from the plugin. */
const hostContext = z.strictObject({
  locale: z.string().max(35).regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/),
  timeZone: z.string().max(64).regex(/^[A-Za-z]+(?:[/_+-][A-Za-z0-9]+)*$/),
})
export type HostContext = z.infer<typeof hostContext>

const call = z.strictObject({
  v: z.literal(1),
  type: z.literal('call'),
  installationId: z.uuid(),
  method: z.string().max(64).regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/),
  args: z.unknown(),
  host: hostContext,
  /** The version the open frame was created for. Only ever used to refuse a call as
   * stale; the server always works with the installation's current version. */
  expectedVersionId: z.uuid(),
})

const event = z.strictObject({
  v: z.literal(1),
  type: z.literal('event'),
  installationId: z.uuid(),
  reason: z.enum(LOGGED_STOPS),
})

/** The host's heartbeat: may this frame keep running? Answered with a FrameStatus only. */
const status = z.strictObject({
  v: z.literal(1),
  type: z.literal('status'),
  installationId: z.uuid(),
  expectedVersionId: z.uuid(),
})

const envelope = z.discriminatedUnion('type', [call, event, status])
export type BridgeEnvelope = z.infer<typeof envelope>
export type BridgeCall = z.infer<typeof call>

export function parseBridgeEnvelope(raw: unknown): BridgeEnvelope | null {
  const result = envelope.safeParse(raw)
  return result.success ? result.data : null
}
