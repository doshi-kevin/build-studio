/**
 * The host side of a plugin frame: creates the sandboxed iframe, runs the handshake,
 * checks every message, and answers host-only methods. Framework-free; PluginHost.tsx
 * wraps it for React. The browser isolation tests (e2e/studio-runtime) load this file.
 *
 * Order of events for a healthy frame:
 *   1. The iframe is created with sandbox="allow-scripts" and the runtime-origin URL.
 *   2. The runtime sends `hello` while the document parses. The plugin bundle is still
 *      inert text at this point.
 *   3. The frame fires its first `load` event.
 *   4. With both, the host sends `welcome` with a fresh session. Only then does the
 *      runtime run the plugin bundle.
 * So plugin code always starts after load #1, and any navigation it causes produces
 * load #2, which stops the frame (rules appendix N9). That is detection, not prevention:
 * the navigation request has already left by the time load #2 fires.
 *
 * States (docs/reference/studio-plugin-runtime.md, "Runtime states"):
 *   loading      the iframe is in the page; its document hasn't loaded
 *   handshaking  loaded; waiting for a valid hello
 *   ready        plugin running; requests answered. `readOnly` when the viewer may not
 *                write (archived, entitlement lost, completed enrollment): writes are
 *                refused here as well as on the server. The heartbeat can change it
 *   stale        the installation moved to another version while this frame was open;
 *                every request is refused until a reload builds a new frame
 *   stopped      terminal, with a reason; the iframe has been removed
 * Creating the iframe happens synchronously inside mountPluginFrame, before the first
 * snapshot, so it is never an observable state.
 *
 * Losing access. Any bridge answer of `unavailable` (hidden, Studio switched off,
 * release gate closed) stops the frame. A plugin that makes no bridge calls would never
 * hear that, so a running frame also asks `checkStatus` every
 * STUDIO_FRAME_STATUS_INTERVAL_MS: `unavailable` stops it, `stale` freezes it,
 * `readOnly` and `available` set whether writes are refused.
 *
 * Runtime v2 (docs/designs/studio/studio-builder-quality.md 3.4). The welcome echoes the
 * runtime the frame said in its hello, and a v1 frame never gets v2 messages. A v2 frame
 * may also send:
 *   size    its content's height; clamped like ui.resize and applied to the iframe.
 *   roster  a RosterTable placeholder; roster-overlay.ts draws the table, with names,
 *           over the frame. Only in a professor view whose allowed methods include
 *           course.roster: anything else is a strike. Names come from `rosterNames`
 *           and never enter the frame; the frame hears only `event` roster.action.
 * Neither counts toward the call budget. Each has its own per-second bound, and
 * messages over it are dropped.
 */
import {
  envelope,
  isSupportedRuntime,
  parseFrameMessage,
  type BridgeErrorCode,
  type FrameMessage,
  type FrameStatus,
  type HostMessage,
  type PluginView,
  type RuntimeVersion,
} from './protocol'
import {
  STUDIO_BRIDGE_CALLS_PER_MINUTE,
  STUDIO_BRIDGE_MAX_MESSAGE_BYTES,
  STUDIO_FRAME_HELLO_TIMEOUT_MS,
  STUDIO_FRAME_MALFORMED_MAX,
  STUDIO_FRAME_RATE_ABUSE_MAX,
  STUDIO_FRAME_START_TIMEOUT_MS,
  STUDIO_FRAME_STATUS_INTERVAL_MS,
  STUDIO_TOASTS_PER_MINUTE,
} from '../limits'
import { methodSpec } from '../bridge/catalog'
import { clampFrameHeight, runHostMethod, type ToastTone } from './host-methods'
import { createRosterOverlay, type RosterOverlay } from './roster-overlay'

/** Per-second bounds for v2's layout messages (3.4). The kit sends at most 10 of each. */
const ROSTER_MESSAGES_PER_SECOND = 20
const SIZE_MESSAGES_PER_SECOND = 10

export type StopReason =
  | 'start-timeout'
  | 'hello-timeout'
  | 'unsupported-runtime'
  | 'navigated'
  | 'malformed'
  | 'crashed'
  | 'throttled'
  | 'unavailable'
  | 'destroyed'

interface Counters {
  loads: number
  strikes: number
}

/** One shape per state, so impossible combinations (a session on a stopped frame, a
 * stop reason on a running one) can't be expressed. */
export type FrameSnapshot =
  | ({ status: 'loading' } & Counters)
  | ({ status: 'handshaking' } & Counters)
  | ({ status: 'ready'; session: string; readOnly: boolean } & Counters)
  | ({ status: 'stale'; session: string } & Counters)
  | ({ status: 'stopped'; reason: StopReason } & Counters)

export type RequestResult = { ok: true; data: unknown } | { ok: false; code: BridgeErrorCode; message: string; issues?: string[] }

export interface PluginFrameOptions {
  container: HTMLElement
  frameUrl: string
  title: string
  view: PluginView
  className?: string
  /** The viewer may not write: write methods are refused before the network. The
   * heartbeat updates it while the frame runs. */
  readOnly?: boolean
  /** Answers server methods: the real bridge (bridge-client.ts) or the preview bridge.
   * Without it, every server method is refused. Host-only methods never reach it. */
  handleRequest?: (method: string, args: unknown) => Promise<RequestResult>
  /** Methods this view of the plugin may call (allowedBridgeMethods). Any other method
   * is refused here, before the network. Containment only: the server checks again. */
  allowedMethods?: readonly string[]
  /** The heartbeat: asks the server whether this frame may keep running. Without it
   * (preview), the frame is never checked. A failed check changes nothing. */
  checkStatus?: () => Promise<FrameStatus>
  /** Shows a ui.toast. The text is plain text; render it as text. */
  onToast?: (message: string, tone: ToastTone) => void
  onChange?: (snapshot: FrameSnapshot) => void
  /** Every stop except an intentional destroy, for the server to log. */
  onStopped?: (reason: Exclude<StopReason, 'destroyed'>) => void
  /** Display names by student handle, for the host-drawn roster (v2, professor view).
   * Asked once per frame, on the first roster render. Preview passes the synthetic class. */
  rosterNames?: () => Promise<Record<string, string>>
  limits?: Partial<{
    startTimeoutMs: number
    helloTimeoutMs: number
    malformedMax: number
    callsPerMinute: number
    rateAbuseMax: number
    toastsPerMinute: number
    statusIntervalMs: number
    rosterPerSecond: number
    sizePerSecond: number
  }>
}

export interface PluginFrame {
  snapshot(): FrameSnapshot
  destroy(): void
}

const STALE_MESSAGE = 'A newer version of this tool is in use. Reload to continue.'

export function mountPluginFrame(options: PluginFrameOptions): PluginFrame {
  const limits = {
    startTimeoutMs: STUDIO_FRAME_START_TIMEOUT_MS,
    helloTimeoutMs: STUDIO_FRAME_HELLO_TIMEOUT_MS,
    malformedMax: STUDIO_FRAME_MALFORMED_MAX,
    callsPerMinute: STUDIO_BRIDGE_CALLS_PER_MINUTE,
    rateAbuseMax: STUDIO_FRAME_RATE_ABUSE_MAX,
    toastsPerMinute: STUDIO_TOASTS_PER_MINUTE,
    statusIntervalMs: STUDIO_FRAME_STATUS_INTERVAL_MS,
    rosterPerSecond: ROSTER_MESSAGES_PER_SECOND,
    sizePerSecond: SIZE_MESSAGES_PER_SECOND,
    ...options.limits,
  }

  // Creating: synchronous, before the first snapshot.
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts') // never allow-same-origin (N1)
  iframe.setAttribute('allow', '') // no device permissions
  iframe.setAttribute('referrerpolicy', 'no-referrer')
  iframe.title = options.title
  if (options.className) iframe.className = options.className
  // Set before insertion, so the first load event is the frame document's own.
  iframe.src = options.frameUrl

  let status: FrameSnapshot['status'] = 'loading'
  let reason: StopReason = 'destroyed'
  let session = ''
  let loads = 0
  let strikes = 0
  let helloSeen = false
  let runtime: RuntimeVersion = 'v1'
  let overlay: RosterOverlay | null = null
  const pending = new Set<string>()
  let frameWindow: Window | null = null
  let readOnly = options.readOnly ?? false
  let timer = setTimeout(() => stop('start-timeout'), limits.startTimeoutMs)
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let checking = false
  // Per-frame budgets: fixed one-minute windows. Refused calls in the same window count
  // toward stopping a frame that keeps hammering.
  let windowStart = Date.now()
  let callsInWindow = 0
  let refusedInWindow = 0
  let toastsInWindow = 0
  // v2 layout messages: fixed one-second windows.
  let secondStart = Date.now()
  let rosterInSecond = 0
  let sizeInSecond = 0

  function snapshot(): FrameSnapshot {
    const counters = { loads, strikes }
    switch (status) {
      case 'ready':
        return { status, session, readOnly, ...counters }
      case 'stale':
        return { status, session, ...counters }
      case 'stopped':
        return { status, reason, ...counters }
      default:
        return { status, ...counters }
    }
  }
  const changed = () => options.onChange?.(snapshot())

  // The frame's origin is opaque, so it can't be named as a target (N3). Only this
  // frame's window receives it, and only data this viewer may see is ever sent.
  const post = (message: HostMessage) => frameWindow?.postMessage(envelope(message), '*')
  const running = () => status === 'ready' || status === 'stale'

  function stop(why: StopReason) {
    if (status === 'stopped') return
    status = 'stopped'
    reason = why
    session = ''
    clearTimeout(timer)
    clearInterval(heartbeat)
    window.removeEventListener('message', onMessage)
    pending.clear()
    overlay?.destroy()
    overlay = null
    iframe.remove()
    if (why !== 'destroyed') options.onStopped?.(why)
    changed()
  }

  function rollWindow() {
    const now = Date.now()
    if (now - windowStart < 60_000) return
    windowStart = now
    callsInWindow = 0
    refusedInWindow = 0
    toastsInWindow = 0
  }

  function takeCall(): boolean {
    rollWindow()
    if (callsInWindow >= limits.callsPerMinute) return false
    callsInWindow += 1
    return true
  }

  /** False when this second's bound for that kind of message is used up. */
  function takeLayout(kind: 'roster' | 'size'): boolean {
    const now = Date.now()
    if (now - secondStart >= 1000) {
      secondStart = now
      rosterInSecond = 0
      sizeInSecond = 0
    }
    if (kind === 'roster') {
      if (rosterInSecond >= limits.rosterPerSecond) return false
      rosterInSecond += 1
      return true
    }
    if (sizeInSecond >= limits.sizePerSecond) return false
    sizeInSecond += 1
    return true
  }

  function strike() {
    strikes += 1
    if (strikes > limits.malformedMax) stop('malformed')
  }

  /** Applies what the server says about this frame. Shared by the heartbeat and by
   * bridge answers, so both paths behave the same. */
  function apply(state: FrameStatus) {
    if (status === 'stopped') return
    if (state === 'unavailable') return stop('unavailable')
    if (state === 'stale') {
      if (status !== 'ready') return
      status = 'stale'
      return changed()
    }
    const nextReadOnly = state === 'readOnly'
    if (nextReadOnly === readOnly) return
    readOnly = nextReadOnly
    if (status === 'ready') changed()
  }

  async function checkNow() {
    if (!options.checkStatus || checking || !running()) return
    checking = true
    let state: FrameStatus | null = null
    try {
      state = await options.checkStatus()
    } catch {
      // A failed check (offline, server error) proves nothing; the next one may.
    }
    checking = false
    if (state) apply(state)
  }

  function welcomeIfReady() {
    if ((status !== 'loading' && status !== 'handshaking') || loads !== 1 || !helloSeen) return
    clearTimeout(timer)
    session = crypto.randomUUID()
    status = 'ready'
    post({ type: 'welcome', session, context: { runtime, view: options.view, theme: 'light' } })
    if (options.checkStatus) heartbeat = setInterval(() => void checkNow(), limits.statusIntervalMs)
    changed()
  }

  iframe.addEventListener('load', () => {
    if (status === 'stopped') return
    loads += 1
    if (loads > 1) return stop('navigated')
    clearTimeout(timer)
    timer = setTimeout(() => stop('hello-timeout'), limits.helloTimeoutMs)
    status = 'handshaking'
    if (helloSeen) return welcomeIfReady()
    changed()
  })

  const effects = {
    setHeight: (px: number) => {
      iframe.style.height = `${px}px`
    },
    toast: (message: string, tone: ToastTone) => {
      rollWindow()
      if (toastsInWindow >= limits.toastsPerMinute) return false
      toastsInWindow += 1
      options.onToast?.(message, tone)
      return true
    },
  }

  /** Roster actions go back as handles, column keys and values: what the plugin sent. */
  function rosterOverlay(): RosterOverlay {
    overlay ??= createRosterOverlay({
      container: options.container,
      names: options.rosterNames,
      onAction: (data) => {
        if (running()) post({ type: 'event', session, name: 'roster.action', data })
      },
    })
    return overlay
  }

  const lastRoster = new Map<string, string>()

  function onRoster(message: Extract<FrameMessage, { type: 'roster' }>) {
    // Names are for staff, and only for a tool allowed to read the class.
    if (options.view !== 'professor' || !options.allowedMethods?.includes('course.roster')) return strike()
    if (!takeLayout('roster')) return
    if (message.op === 'render') {
      // The same table again changes nothing: skip the rebuild, so a plugin can't spin the page.
      const key = JSON.stringify(message.payload)
      if (lastRoster.get(message.slot) === key) return
      lastRoster.set(message.slot, key)
      if (!rosterOverlay().render(message.slot, message.payload)) strike()
    } else if (message.op === 'place') {
      overlay?.place(message.slot, message.rect)
    } else {
      overlay?.remove(message.slot)
    }
  }

  async function answer(request: Extract<FrameMessage, { type: 'request' }>) {
    const sessionAtStart = session
    const reply = (result: RequestResult) => {
      if (!running() || session !== sessionAtStart) return
      post(
        result.ok
          ? { type: 'response', session: sessionAtStart, id: request.id, ok: true, data: result.data }
          : {
              type: 'response',
              session: sessionAtStart,
              id: request.id,
              ok: false,
              error: { code: result.code, message: result.message, ...(result.issues ? { issues: result.issues } : {}) },
            },
      )
    }
    if (pending.has(request.id)) return reply({ ok: false, code: 'invalid', message: 'That request is already in progress.' })
    // A stale frame accepts nothing new; only a reload builds a frame on the current version.
    if (status === 'stale') return reply({ ok: false, code: 'stale', message: STALE_MESSAGE })
    if (options.allowedMethods && !options.allowedMethods.includes(request.method)) {
      return reply({ ok: false, code: 'unsupported', message: 'This tool asked for something it can’t use here.' })
    }
    const spec = methodSpec(request.method)
    if (readOnly && spec?.kind === 'write') {
      return reply({ ok: false, code: 'not_available', message: 'This tool is read-only here.' })
    }
    if (!takeCall()) {
      refusedInWindow += 1
      if (refusedInWindow > limits.rateAbuseMax) return stop('throttled')
      return reply({ ok: false, code: 'rate_limited', message: 'Too many requests. Wait a moment and try again.' })
    }
    // Host-only methods are answered here and never reach handleRequest or the network.
    if (spec?.runs === 'host') return reply(runHostMethod(request.method, request.args, effects))

    pending.add(request.id)
    let result: RequestResult
    try {
      result = options.handleRequest
        ? await options.handleRequest(request.method, request.args)
        : { ok: false, code: 'unsupported', message: 'This isn’t available yet.' }
    } catch {
      result = { ok: false, code: 'failed', message: 'Something went wrong.' }
    }
    pending.delete(request.id)
    // The viewer lost access: stop, without answering. A stopped frame is gone.
    if (!result.ok && result.code === 'unavailable') return apply('unavailable')
    // The server says the installation's version moved on. Never carry on as if the
    // frame were current, and never swap code under a running plugin: go stale and wait
    // for the viewer to reload.
    if (!result.ok && result.code === 'stale') apply('stale')
    reply(result)
  }

  function onMessage(event: MessageEvent) {
    // Anything not from this frame's window is ignored without a reply (N2). The
    // origin is "null" for every sandboxed frame, so it identifies nothing.
    if (!frameWindow || event.source !== frameWindow || status === 'stopped') return

    const message = parseFrameMessage(event.data, STUDIO_BRIDGE_MAX_MESSAGE_BYTES)
    if (!message) return strike()

    if (message.type === 'hello') {
      if (helloSeen) return strike()
      if (!isSupportedRuntime(message.runtime)) return stop('unsupported-runtime')
      runtime = message.runtime
      helloSeen = true
      return welcomeIfReady()
    }
    // Before the welcome, or from an earlier document: not this session.
    if (!running() || message.session !== session) return strike()
    if (message.type === 'crash') return stop('crashed')
    if (message.type === 'roster' || message.type === 'size') {
      // v2 messages from a v1 runtime are junk.
      if (runtime === 'v1') return strike()
      if (message.type === 'roster') return onRoster(message)
      if (takeLayout('size')) effects.setHeight(clampFrameHeight(Math.round(message.height)))
      return
    }
    void answer(message)
  }

  window.addEventListener('message', onMessage)
  options.container.appendChild(iframe)
  frameWindow = iframe.contentWindow
  changed()

  return {
    snapshot,
    destroy: () => stop('destroyed'),
  }
}
