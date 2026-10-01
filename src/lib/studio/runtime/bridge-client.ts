/**
 * The host's side of the Scholera Bridge: turns a plugin request into one HTTPS POST to
 * /api/studio/bridge, from Scholera's own page. The plugin never makes this request; its
 * frame can't reach the network (rule 1.2).
 *
 * The host adds the installation (from the page it was rendered for) and the viewer's
 * own locale and time zone (from the browser's Intl settings). The plugin supplies only
 * the method and its arguments. The server re-checks everything: these values are
 * conveniences, not authority.
 */
import { LOGGED_STOPS } from '../bridge/envelope'
import type { BridgeErrorCode, FrameStatus } from './protocol'
import type { RequestResult, StopReason } from './host'

export const BRIDGE_ENDPOINT = '/api/studio/bridge'

const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/
const TIME_ZONE = /^[A-Za-z]+(?:[/_+-][A-Za-z0-9]+)*$/

function browserSettings() {
  const options = Intl.DateTimeFormat().resolvedOptions()
  return {
    locale: LOCALE.test(options.locale) && options.locale.length <= 35 ? options.locale : 'en-US',
    timeZone: options.timeZone && TIME_ZONE.test(options.timeZone) && options.timeZone.length <= 64 ? options.timeZone : 'UTC',
  }
}

const STATUS_CODES: Record<number, BridgeErrorCode> = {
  400: 'invalid',
  401: 'not_available',
  403: 'not_available',
  404: 'not_available',
  413: 'invalid',
  415: 'invalid',
  429: 'rate_limited',
}

const FAILED = { ok: false, code: 'failed', message: 'Something went wrong. Try again.' } as const satisfies RequestResult

export interface BridgeClient {
  handleRequest(method: string, args: unknown): Promise<RequestResult>
  /** Reports a stop the server should log. Fire and forget; never carries plugin data. */
  reportStop(reason: StopReason): void
  /** The heartbeat: may this frame keep running? Throws when the answer can't be read,
   * which the host treats as "no news". */
  checkStatus(): Promise<FrameStatus>
}

const FRAME_STATUSES: readonly FrameStatus[] = ['available', 'readOnly', 'unavailable', 'stale']

export function createBridgeClient({
  installationId,
  versionId,
  endpoint = BRIDGE_ENDPOINT,
  fetchImpl = (...a: Parameters<typeof fetch>) => fetch(...a),
}: {
  installationId: string
  /** The version this frame was created for, from the page. The server answers `stale`
   * once the installation has moved to another version. */
  versionId: string
  endpoint?: string
  fetchImpl?: typeof fetch
}): BridgeClient {
  const post = (body: unknown, keepalive = false) =>
    fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive,
      body: JSON.stringify(body),
    })

  return {
    async handleRequest(method, args) {
      let response: Response
      try {
        response = await post({
          v: 1,
          type: 'call',
          installationId,
          expectedVersionId: versionId,
          method,
          args: args ?? null,
          host: browserSettings(),
        })
      } catch {
        return FAILED
      }
      let body: { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown; issues?: unknown } } | null = null
      try {
        body = await response.json()
      } catch {
        /* a non-JSON body falls through to the status mapping */
      }
      if (response.ok && body?.ok === true) return { ok: true, data: body.data }
      const code = (typeof body?.error?.code === 'string' ? body.error.code : STATUS_CODES[response.status] ?? 'failed') as BridgeErrorCode
      const message = typeof body?.error?.message === 'string' ? body.error.message : FAILED.message
      const issues = Array.isArray(body?.error?.issues) ? body.error.issues.filter((i): i is string => typeof i === 'string') : undefined
      return { ok: false, code, message, ...(issues ? { issues } : {}) }
    },

    reportStop(reason) {
      // Only the stops worth logging. An `unavailable` stop is the server's own decision.
      if (!(LOGGED_STOPS as readonly string[]).includes(reason)) return
      void post({ v: 1, type: 'event', installationId, reason }, true).catch(() => {})
    },

    async checkStatus() {
      const response = await post({ v: 1, type: 'status', installationId, expectedVersionId: versionId })
      const body = (await response.json()) as { ok?: unknown; data?: { status?: unknown } }
      const status = body?.ok === true ? body.data?.status : undefined
      if (!FRAME_STATUSES.includes(status as FrameStatus)) throw new Error('No status')
      return status as FrameStatus
    },
  }
}
