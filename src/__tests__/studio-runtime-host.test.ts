/**
 * The host controller's own decisions, in jsdom: which messages it accepts, when it sends
 * the welcome, what stops a frame. jsdom doesn't enforce sandboxing; the browser tests in
 * e2e/studio-runtime do that against real browsers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountPluginFrame, type FrameSnapshot, type PluginFrameOptions, type StopReason } from '@/lib/studio/runtime/host'
import { STUDIO_FRAME_MAX_HEIGHT_PX, STUDIO_FRAME_MIN_HEIGHT_PX } from '@/lib/studio/limits'

/** The session, which only a running (ready or stale) frame has. */
const sessionOf = (s: FrameSnapshot) => (s.status === 'ready' || s.status === 'stale' ? s.session : undefined)

const FRAME_URL = 'http://127.0.0.1:3000/studio-frame/v1/x/student?t=ticket'
const hello = (runtime = 'v1') => ({ scholera: 'bridge', v: 1, type: 'hello', runtime })
const request = (session: string | undefined, id = 'r1', method = 'test.ping', args: unknown = null) => ({
  scholera: 'bridge', v: 1, type: 'request', session, id, method, args,
})

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
})

function mount(options: Partial<PluginFrameOptions> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const security: StopReason[] = []
  let last: FrameSnapshot | undefined
  const frame = mountPluginFrame({
    container,
    frameUrl: FRAME_URL,
    title: 'Exit ticket',
    view: 'student',
    onChange: (s) => (last = s),
    onStopped: (r) => security.push(r),
    limits: { startTimeoutMs: 1000, helloTimeoutMs: 500, malformedMax: 3 },
    ...options,
  })
  const iframe = container.querySelector('iframe')!
  const win = iframe.contentWindow!
  const posted: Record<string, unknown>[] = []
  vi.spyOn(win, 'postMessage').mockImplementation(((m: Record<string, unknown>) => posted.push(m)) as never)
  const send = (data: unknown, source: Window | null = win) => window.dispatchEvent(new MessageEvent('message', { data, source }))
  const load = () => iframe.dispatchEvent(new Event('load'))
  const ready = () => {
    send(hello())
    load()
    return sessionOf(frame.snapshot())!
  }
  return { frame, container, iframe, posted, send, load, ready, security, last: () => last }
}

type Mounted = ReturnType<typeof mount>


describe('the iframe', () => {
  it('is sandboxed to scripts only, with no permissions and no referrer', () => {
    const { iframe } = mount()
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('allow')).toBe('')
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe.getAttribute('src')).toBe(FRAME_URL)
    expect(iframe.title).toBe('Exit ticket')
  })
})

describe('handshake', () => {
  it.each([
    ['hello, then load', (m: Mounted): void => { m.send(hello()); m.load() }],
    ['load, then hello', (m: Mounted): void => { m.load(); m.send(hello()) }],
  ])('welcomes once it has both: %s', (_label, steps) => {
    const m = mount()
    steps(m)
    expect(m.frame.snapshot()).toMatchObject({ status: 'ready', loads: 1 })
    expect(m.posted).toEqual([
      {
        scholera: 'bridge',
        v: 1,
        type: 'welcome',
        session: sessionOf(m.frame.snapshot()),
        context: { runtime: 'v1', view: 'student', theme: 'light' },
      },
    ])
  })

  it('sends nothing before the first load, so plugin code can’t start before load events are counted', () => {
    const m = mount()
    m.send(hello())
    expect(m.posted).toEqual([])
    expect(m.frame.snapshot().status).toBe('loading')
  })

  it('stops a frame that says it runs an unsupported runtime', () => {
    const m = mount()
    m.load()
    m.send(hello('v9'))
    expect(m.frame.snapshot()).toMatchObject({ status: 'stopped', reason: 'unsupported-runtime' })
    expect(m.container.querySelector('iframe')).toBeNull()
    expect(m.posted).toEqual([])
  })

  it('treats a second hello as junk', () => {
    const m = mount()
    m.ready()
    m.send(hello())
    expect(m.frame.snapshot()).toMatchObject({ status: 'ready', strikes: 1 })
  })
})

describe('frame identity', () => {
  it('ignores every message not sent by this frame’s window, without replying or counting it', () => {
    const m = mount()
    const sibling = document.createElement('iframe')
    document.body.appendChild(sibling)
    m.send(hello(), sibling.contentWindow)
    m.send(hello(), window)
    m.load()
    expect(m.frame.snapshot()).toMatchObject({ status: 'handshaking', strikes: 0 })
    expect(m.posted).toEqual([])
  })

  // Refusals happen synchronously in the message handler, so nothing needs to settle.
  it('refuses a request from before the welcome or with another session', () => {
    const m = mount()
    m.load()
    m.send(request(crypto.randomUUID()))
    m.send(hello())
    m.send(request(crypto.randomUUID()))
    expect(m.frame.snapshot().strikes).toBe(2)
    expect(m.posted.filter((p) => p.type === 'response')).toEqual([])
  })

  it('a replacement frame has a new session, and the old one is refused there', () => {
    const first = mount()
    const oldSession = first.ready()
    first.frame.destroy()

    const second = mount()
    const newSession = second.ready()
    expect(newSession).not.toBe(oldSession)
    second.send(request(oldSession))
    expect(second.posted.filter((p) => p.type === 'response')).toEqual([])
    expect(second.frame.snapshot().strikes).toBe(1)
  })
})

describe('requests', () => {
  it('refuses every request when no handler is connected', async () => {
    const m = mount()
    const session = m.ready()
    m.send(request(session))
    await vi.waitFor(() =>
      expect(m.posted.at(-1)).toMatchObject({ type: 'response', session, id: 'r1', ok: false, error: { code: 'unsupported' } }),
    )
  })

  it('routes to the handler and answers the same id in the same session', async () => {
    const handleRequest = vi.fn(async () => ({ ok: true as const, data: { pong: true } }))
    const m = mount({ handleRequest })
    const session = m.ready()
    m.send(request(session, 'abc', 'test.ping', { n: 1 }))
    await vi.waitFor(() =>
      expect(m.posted.at(-1)).toEqual({ scholera: 'bridge', v: 1, type: 'response', session, id: 'abc', ok: true, data: { pong: true } }),
    )
    expect(handleRequest).toHaveBeenCalledWith('test.ping', { n: 1 })
  })

  it('refuses an id that is still in progress', async () => {
    let finish: (v: { ok: true; data: unknown }) => void = () => {}
    const m = mount({ handleRequest: () => new Promise((r) => (finish = r)) })
    const session = m.ready()
    m.send(request(session, 'same'))
    m.send(request(session, 'same'))
    // The duplicate is refused before the handler is awaited, so synchronously.
    expect(m.posted.at(-1)).toMatchObject({ id: 'same', ok: false, error: { code: 'invalid' } })
    finish({ ok: true, data: 1 })
    await vi.waitFor(() => expect(m.posted.at(-1)).toMatchObject({ id: 'same', ok: true }))
  })

  it('never answers after the frame stopped', async () => {
    let finish: (v: { ok: true; data: unknown }) => void = () => {}
    let settled = false
    const m = mount({
      handleRequest: () =>
        new Promise<{ ok: true; data: unknown }>((r) => (finish = r)).then((v) => {
          settled = true
          return v
        }),
    })
    const session = m.ready()
    m.send(request(session))
    m.load() // navigated while the request was in flight
    finish({ ok: true, data: 'secret' })
    await vi.waitFor(() => expect(settled).toBe(true))
    expect(m.posted.filter((p) => p.type === 'response')).toEqual([])
  })
})

describe('containment before the network', () => {
  it('refuses a method outside the allowed list without calling the bridge', async () => {
    const handleRequest = vi.fn(async () => ({ ok: true as const, data: 1 }))
    const m = mount({ handleRequest, allowedMethods: ['context.get'] })
    const session = m.ready()
    m.send(request(session, 'r1', 'records.list'))
    expect(m.posted.at(-1)).toMatchObject({ id: 'r1', ok: false, error: { code: 'unsupported' } })
    expect(handleRequest).not.toHaveBeenCalled()
    m.send(request(session, 'r2', 'context.get'))
    await vi.waitFor(() => expect(m.posted.at(-1)).toMatchObject({ id: 'r2', ok: true }))
  })

  it('refuses calls over the per-frame rate, then stops a frame that keeps going', async () => {
    const handleRequest = vi.fn(async () => ({ ok: true as const, data: 1 }))
    const m = mount({ handleRequest, limits: { startTimeoutMs: 1000, helloTimeoutMs: 500, malformedMax: 3, callsPerMinute: 2, rateAbuseMax: 3 } })
    const session = m.ready()
    m.send(request(session, 'a'))
    m.send(request(session, 'b'))
    m.send(request(session, 'c'))
    expect(m.posted.at(-1)).toMatchObject({ id: 'c', ok: false, error: { code: 'rate_limited' } })
    await vi.waitFor(() => expect(handleRequest).toHaveBeenCalledTimes(2))
    for (const id of ['d', 'e', 'f']) m.send(request(session, id))
    expect(m.frame.snapshot()).toMatchObject({ status: 'stopped', reason: 'throttled' })
    expect(m.security).toEqual(['throttled'])
  })

  it('opens a fresh budget each minute', async () => {
    vi.useFakeTimers()
    const handleRequest = vi.fn(async () => ({ ok: true as const, data: 1 }))
    const m = mount({ handleRequest, limits: { startTimeoutMs: 1000, helloTimeoutMs: 500, malformedMax: 3, callsPerMinute: 1, rateAbuseMax: 5 } })
    const session = m.ready()
    m.send(request(session, 'a'))
    m.send(request(session, 'b'))
    expect(m.posted.at(-1)).toMatchObject({ id: 'b', error: { code: 'rate_limited' } })
    vi.advanceTimersByTime(60_000)
    m.send(request(session, 'c'))
    expect(handleRequest).toHaveBeenCalledTimes(2)
  })
})

describe('stopping a frame', () => {
  it('stops and removes the frame on a second load (self-navigation), and reports it', () => {
    const m = mount()
    m.ready()
    m.load()
    expect(m.frame.snapshot()).toMatchObject({ status: 'stopped', reason: 'navigated' })
    expect('session' in m.frame.snapshot()).toBe(false)
    expect(m.container.querySelector('iframe')).toBeNull()
    expect(m.security).toEqual(['navigated'])
  })

  it('stops after too many malformed messages', () => {
    const m = mount()
    m.ready()
    for (let i = 0; i < 4; i++) m.send({ junk: i })
    expect(m.frame.snapshot()).toMatchObject({ status: 'stopped', reason: 'malformed' })
    expect(m.security).toEqual(['malformed'])
  })

  it('stops when the plugin reports a crash in its session, and reports the stop without the crash text', () => {
    const m = mount()
    const session = m.ready()
    m.send({ scholera: 'bridge', v: 1, type: 'crash', session, message: 'boom' })
    expect(m.frame.snapshot()).toMatchObject({ status: 'stopped', reason: 'crashed' })
    expect(m.security).toEqual(['crashed'])
  })

  it.each([
    ['start-timeout', (): void => {}, 1000],
    ['hello-timeout', (m: Mounted): void => void m.load(), 500],
  ] as const)('stops with %s', (reason, steps, after) => {
    vi.useFakeTimers()
    const m = mount()
    steps(m)
    vi.advanceTimersByTime(after - 1)
    expect(m.frame.snapshot().status).not.toBe('stopped')
    vi.advanceTimersByTime(1)
    expect(m.frame.snapshot()).toMatchObject({ status: 'stopped', reason })
  })

  it('destroy removes the frame and stops listening', () => {
    const m = mount()
    m.frame.destroy()
    expect(m.container.querySelector('iframe')).toBeNull()
    m.send(hello())
    m.load()
    expect(m.posted).toEqual([])
    expect(m.security).toEqual([])
  })
})

describe('runtime states', () => {
  it('goes loading, handshaking, ready, with a session only once ready', () => {
    const m = mount()
    expect(m.frame.snapshot()).toEqual({ status: 'loading', loads: 0, strikes: 0 })
    m.load()
    expect(m.frame.snapshot()).toEqual({ status: 'handshaking', loads: 1, strikes: 0 })
    m.send(hello())
    expect(m.frame.snapshot()).toMatchObject({ status: 'ready', readOnly: false, session: expect.any(String) })
  })

  it('a stopped frame carries its reason and no session', () => {
    const m = mount()
    m.ready()
    m.load()
    expect(m.frame.snapshot()).toEqual({ status: 'stopped', reason: 'navigated', loads: 2, strikes: 0 })
  })
})

describe('stale frames', () => {
  const staleResult = { ok: false as const, code: 'stale' as const, message: 'A newer version is in use.' }

  it('turns stale when the server says so, and refuses everything after without asking it again', async () => {
    const handleRequest = vi.fn(async () => staleResult)
    const m = mount({ handleRequest })
    const session = m.ready()
    m.send(request(session, 'a', 'records.create'))
    await vi.waitFor(() => expect(m.frame.snapshot().status).toBe('stale'))
    expect(m.posted.at(-1)).toMatchObject({ id: 'a', ok: false, error: { code: 'stale' } })

    m.send(request(session, 'b', 'records.list'))
    expect(m.posted.at(-1)).toMatchObject({ id: 'b', ok: false, error: { code: 'stale' } })
    expect(handleRequest).toHaveBeenCalledTimes(1)
    // Still detected: a stale frame that navigates is stopped like any other.
    m.load()
    expect(m.frame.snapshot()).toMatchObject({ status: 'stopped', reason: 'navigated' })
  })

  it('keeps the frame in place while stale: no silent reload onto new code', async () => {
    const m = mount({ handleRequest: async () => staleResult })
    const session = m.ready()
    m.send(request(session))
    await vi.waitFor(() => expect(m.frame.snapshot().status).toBe('stale'))
    expect(m.container.querySelector('iframe')).not.toBeNull()
    expect(m.iframe.getAttribute('src')).toBe(FRAME_URL)
  })
})

describe('read-only installations', () => {
  it('refuses writes before the network, and still answers reads', async () => {
    const handleRequest = vi.fn(async () => ({ ok: true as const, data: [] }))
    const m = mount({ handleRequest, readOnly: true })
    const session = m.ready()
    expect(m.frame.snapshot()).toMatchObject({ status: 'ready', readOnly: true })
    m.send(request(session, 'w', 'records.update'))
    expect(m.posted.at(-1)).toMatchObject({ id: 'w', ok: false, error: { code: 'not_available' } })
    m.send(request(session, 'r', 'records.list'))
    await vi.waitFor(() => expect(m.posted.at(-1)).toMatchObject({ id: 'r', ok: true }))
    expect(handleRequest).toHaveBeenCalledTimes(1)
  })
})

describe('host-only methods', () => {
  it.each([
    [5000, STUDIO_FRAME_MAX_HEIGHT_PX],
    [50, STUDIO_FRAME_MIN_HEIGHT_PX],
    [640, 640],
  ])('ui.resize %i is clamped by the host to %i', (asked, applied) => {
    const handleRequest = vi.fn()
    const m = mount({ handleRequest })
    const session = m.ready()
    m.send(request(session, 'h', 'ui.resize', { height: asked }))
    expect(m.iframe.style.height).toBe(`${applied}px`)
    expect(m.posted.at(-1)).toMatchObject({ id: 'h', ok: true, data: { height: applied } })
    expect(handleRequest).not.toHaveBeenCalled()
  })

  it.each([[{ height: -1 }], [{ height: 1.5 }], [{ height: 'tall' }], [{ height: 300, width: 900 }], [null]])(
    'ui.resize refuses %j and leaves the frame as it was',
    (args) => {
      const m = mount()
      const session = m.ready()
      m.send(request(session, 'h', 'ui.resize', args))
      expect(m.posted.at(-1)).toMatchObject({ id: 'h', ok: false, error: { code: 'invalid' } })
      expect(m.iframe.style.height).toBe('')
    },
  )

  it('ui.toast passes plain text and a tone to the page, never to the bridge', () => {
    const handleRequest = vi.fn()
    const onToast = vi.fn()
    const m = mount({ handleRequest, onToast })
    const session = m.ready()
    const html = '<img src=x onerror=alert(1)><script>alert(2)</script>'
    m.send(request(session, 't1', 'ui.toast', { message: html }))
    m.send(request(session, 't2', 'ui.toast', { message: 'Saved', tone: 'success' }))
    expect(onToast.mock.calls).toEqual([
      [html, 'info'],
      ['Saved', 'success'],
    ])
    expect(handleRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty message', { message: '   ' }],
    ['a message over 160 characters', { message: 'x'.repeat(161) }],
    ['a style', { message: 'Hi', style: 'color: red' }],
    ['a link', { message: 'Hi', href: 'https://evil.example' }],
    ['an unknown tone', { message: 'Hi', tone: 'warning' }],
  ])('ui.toast refuses %s', (_label, args) => {
    const onToast = vi.fn()
    const m = mount({ onToast })
    const session = m.ready()
    m.send(request(session, 't', 'ui.toast', args))
    expect(m.posted.at(-1)).toMatchObject({ id: 't', ok: false, error: { code: 'invalid' } })
    expect(onToast).not.toHaveBeenCalled()
  })

  it('ui.toast is capped per minute', () => {
    const onToast = vi.fn()
    const m = mount({ onToast, limits: { startTimeoutMs: 1000, helloTimeoutMs: 500, malformedMax: 3, toastsPerMinute: 2 } })
    const session = m.ready()
    for (const id of ['a', 'b', 'c']) m.send(request(session, id, 'ui.toast', { message: id }))
    expect(onToast).toHaveBeenCalledTimes(2)
    expect(m.posted.at(-1)).toMatchObject({ id: 'c', ok: false, error: { code: 'rate_limited' } })
  })

  it('host-only methods still need to be allowed for this view', () => {
    const onToast = vi.fn()
    const m = mount({ onToast, allowedMethods: ['ui.resize'] })
    const session = m.ready()
    m.send(request(session, 't', 'ui.toast', { message: 'Hi' }))
    expect(m.posted.at(-1)).toMatchObject({ id: 't', ok: false, error: { code: 'unsupported' } })
    expect(onToast).not.toHaveBeenCalled()
  })
})

describe('losing access', () => {
  const unavailable = { ok: false as const, code: 'unavailable' as const, message: 'This tool isn’t available right now.' }

  it('stops and removes the frame when a bridge call answers unavailable, without answering the plugin', async () => {
    const m = mount({ handleRequest: async () => unavailable })
    const session = m.ready()
    m.send(request(session, 'a', 'records.list'))
    await vi.waitFor(() => expect(m.frame.snapshot()).toMatchObject({ status: 'stopped', reason: 'unavailable' }))
    expect(m.container.querySelector('iframe')).toBeNull()
    expect(m.posted.some((p) => p.type === 'response')).toBe(false)
    expect(m.security).toEqual(['unavailable'])
  })
})

describe('status heartbeat', () => {
  const INTERVAL = 1000

  function mountWithStatus(checkStatus: PluginFrameOptions['checkStatus'], options: Partial<PluginFrameOptions> = {}) {
    vi.useFakeTimers()
    return mount({ checkStatus, ...options, limits: { startTimeoutMs: 60_000, helloTimeoutMs: 60_000, malformedMax: 3, statusIntervalMs: INTERVAL } })
  }

  it('closes a frame that never calls the bridge, within one interval of losing access', async () => {
    const checkStatus = vi.fn<NonNullable<PluginFrameOptions['checkStatus']>>()
    checkStatus.mockResolvedValueOnce('available').mockResolvedValueOnce('unavailable')
    const handleRequest = vi.fn()
    const m = mountWithStatus(checkStatus, { handleRequest })
    m.ready()
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(m.frame.snapshot().status).toBe('ready')
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(m.frame.snapshot()).toMatchObject({ status: 'stopped', reason: 'unavailable' })
    expect(m.container.querySelector('iframe')).toBeNull()
    expect(handleRequest).not.toHaveBeenCalled()
  })

  it('freezes the frame as stale when the installation moved to another version', async () => {
    const handleRequest = vi.fn(async () => ({ ok: true as const, data: [] }))
    const m = mountWithStatus(async () => 'stale', { handleRequest })
    const session = m.ready()
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(m.frame.snapshot().status).toBe('stale')
    m.send(request(session, 'b', 'records.list'))
    expect(m.posted.at(-1)).toMatchObject({ id: 'b', ok: false, error: { code: 'stale' } })
    expect(handleRequest).not.toHaveBeenCalled()
  })

  it('turns writes off when the server says read-only, and back on when it says available', async () => {
    const handleRequest = vi.fn(async () => ({ ok: true as const, data: null }))
    const checkStatus = vi.fn<NonNullable<PluginFrameOptions['checkStatus']>>()
    checkStatus.mockResolvedValueOnce('readOnly').mockResolvedValueOnce('available')
    const m = mountWithStatus(checkStatus, { handleRequest })
    const session = m.ready()
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(m.frame.snapshot()).toMatchObject({ status: 'ready', readOnly: true })
    m.send(request(session, 'w', 'records.create'))
    expect(m.posted.at(-1)).toMatchObject({ id: 'w', ok: false, error: { code: 'not_available' } })
    expect(handleRequest).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(m.frame.snapshot()).toMatchObject({ status: 'ready', readOnly: false })
    m.send(request(session, 'w2', 'records.create'))
    await vi.waitFor(() => expect(handleRequest).toHaveBeenCalledTimes(1))
  })

  it('treats a failed check as no news', async () => {
    const m = mountWithStatus(async () => {
      throw new Error('offline')
    })
    m.ready()
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(m.frame.snapshot()).toMatchObject({ status: 'ready', readOnly: false })
  })

  it('asks only while running, one check at a time, and never after the frame stops', async () => {
    const checkStatus = vi.fn(() => new Promise<never>(() => {}))
    const m = mountWithStatus(checkStatus)
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(checkStatus).not.toHaveBeenCalled() // not before the welcome
    m.ready()
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(checkStatus).toHaveBeenCalledTimes(1) // the first never answered
    m.frame.destroy()
    checkStatus.mockClear()
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(checkStatus).not.toHaveBeenCalled()
  })

  it('never runs without a status source, which is how preview frames run', async () => {
    vi.useFakeTimers()
    const m = mount({ limits: { startTimeoutMs: 60_000, helloTimeoutMs: 60_000, malformedMax: 3, statusIntervalMs: INTERVAL } })
    m.ready()
    await vi.advanceTimersByTimeAsync(INTERVAL * 5)
    expect(m.frame.snapshot().status).toBe('ready')
  })
})

// ── Runtime v2: auto height and the host-drawn roster (studio-builder-quality.md 3.4) ──

describe('runtime v2', () => {
  const HANDLE_A = `st_${'a'.repeat(20)}`
  const HANDLE_B = `st_${'b'.repeat(20)}`
  const NAMES = { [HANDLE_A]: 'Zoe Quinlan-Ford', [HANDLE_B]: 'Arjun Mehra-Castillo' }
  const roster = (session: string, op: string, extra: Record<string, unknown> = {}) => ({ scholera: 'bridge', v: 1, type: 'roster', session, op, slot: 'r1', ...extra })
  const payload = (rows = [HANDLE_A, HANDLE_B]) => ({
    label: 'Attendance',
    sort: 'name',
    searchable: false,
    columns: [{ key: 'status', header: 'Today' }],
    rows: rows.map((student) => ({
      student,
      cells: { status: { kind: 'choice', value: null, options: [{ value: 'present', label: 'Present', tone: 'success' }, { value: 'absent', label: 'Absent', tone: 'danger' }] } },
    })),
    emptyText: 'No students yet.',
  })
  const ROSTER_OPTIONS: Partial<PluginFrameOptions> = {
    view: 'professor',
    allowedMethods: ['course.roster'],
    rosterNames: async () => NAMES,
  }
  const readyV2 = (m: Mounted) => {
    m.send(hello('v2'))
    m.load()
    return sessionOf(m.frame.snapshot())!
  }
  /** The names provider has answered and the table is redrawn with names (aria-busy drops). */
  const namesDrawn = (m: Mounted) =>
    vi.waitFor(() => expect(m.container.querySelector('[data-studio-roster] table:not([aria-busy])')).not.toBeNull())

  it('welcomes a v2 runtime as v2, and a v1 runtime as v1', () => {
    const v2 = mount()
    readyV2(v2)
    expect(v2.posted[0]).toMatchObject({ type: 'welcome', context: { runtime: 'v2' } })
    const v1 = mount()
    v1.ready()
    expect(v1.posted[0]).toMatchObject({ type: 'welcome', context: { runtime: 'v1' } })
  })

  it('fits the frame to the height a v2 runtime reports, clamped like ui.resize', () => {
    const m = mount()
    const session = readyV2(m)
    m.send({ scholera: 'bridge', v: 1, type: 'size', session, height: 731.4 })
    expect(m.iframe.style.height).toBe('731px')
    m.send({ scholera: 'bridge', v: 1, type: 'size', session, height: 90_000 })
    expect(m.iframe.style.height).toBe(`${STUDIO_FRAME_MAX_HEIGHT_PX}px`)
    expect(m.frame.snapshot().strikes).toBe(0)
  })

  it('drops size reports over its per-second bound, without a strike', () => {
    const m = mount({ limits: { startTimeoutMs: 1000, helloTimeoutMs: 500, malformedMax: 3, sizePerSecond: 2 } })
    const session = readyV2(m)
    for (const height of [300, 400, 500]) m.send({ scholera: 'bridge', v: 1, type: 'size', session, height })
    expect(m.iframe.style.height).toBe('400px')
    expect(m.frame.snapshot().strikes).toBe(0)
  })

  it('treats v2 messages from a v1 runtime as junk', () => {
    const m = mount(ROSTER_OPTIONS)
    const session = m.ready()
    m.send({ scholera: 'bridge', v: 1, type: 'size', session, height: 700 })
    m.send(roster(session, 'render', { payload: payload() }))
    expect(m.frame.snapshot().strikes).toBe(2)
    expect(m.iframe.style.height).toBe('')
    expect(m.container.querySelector('[data-studio-roster]')).toBeNull()
  })

  it.each([
    ['a student view', { ...ROSTER_OPTIONS, view: 'student' as const }],
    ['a professor view without course.roster', { ...ROSTER_OPTIONS, allowedMethods: ['records.list'] }],
    ['a professor view with no allowed methods', { ...ROSTER_OPTIONS, allowedMethods: undefined }],
  ])('strikes roster messages from %s and draws nothing', (_label, options) => {
    const rosterNames = vi.fn(async () => NAMES)
    const m = mount({ ...options, rosterNames })
    const session = readyV2(m)
    m.send(roster(session, 'render', { payload: payload() }))
    // The refusal is synchronous, and a render that got past it would ask for names
    // synchronously too, so there is nothing to wait for.
    expect(m.frame.snapshot().strikes).toBe(1)
    expect(m.container.querySelector('[data-studio-roster]')).toBeNull()
    expect(rosterNames).not.toHaveBeenCalled()
  })

  it('strikes a payload that fails the strict parse', () => {
    const m = mount(ROSTER_OPTIONS)
    const session = readyV2(m)
    m.send(roster(session, 'render', { payload: { ...payload(), rows: [{ student: 'Arjun', cells: {} }] } }))
    expect(m.frame.snapshot().strikes).toBe(1)
    expect(m.container.querySelector('[data-studio-roster]')).toBeNull()
  })

  it('draws names over the frame, sends the plugin only handles and values, and never a name', async () => {
    const m = mount(ROSTER_OPTIONS)
    const session = readyV2(m)
    m.send(roster(session, 'render', { payload: payload() }))
    m.send(roster(session, 'place', { rect: { x: 16, y: 80, width: 600, height: 160 } }))
    await namesDrawn(m)
    const table = m.container.querySelector('table')!
    expect([...table.querySelectorAll('tbody th')].map((th) => th.textContent)).toEqual(['Arjun Mehra-Castillo', 'Zoe Quinlan-Ford'])
    const box = m.container.querySelector<HTMLElement>('[data-studio-roster="r1"]')!
    expect(box.style).toMatchObject({ left: '16px', top: '80px', width: '600px', height: '160px' })

    table.querySelector<HTMLButtonElement>('[aria-label="Absent, Zoe Quinlan-Ford"]')!.click()
    expect(m.posted.at(-1)).toEqual({
      scholera: 'bridge',
      v: 1,
      type: 'event',
      session,
      name: 'roster.action',
      data: { slot: 'r1', student: HANDLE_A, column: 'status', value: 'absent' },
    })
    const everything = JSON.stringify(m.posted)
    for (const name of Object.values(NAMES)) expect(everything).not.toContain(name)
  })

  it('asks for names once per frame, however many renders', async () => {
    const rosterNames = vi.fn(async () => NAMES)
    const m = mount({ ...ROSTER_OPTIONS, rosterNames })
    const session = readyV2(m)
    for (let i = 0; i < 3; i++) m.send(roster(session, 'render', { payload: payload() }))
    await namesDrawn(m)
    expect(rosterNames).toHaveBeenCalledTimes(1)
  })

  it('drops roster messages over its own per-second bound, outside the call budget', async () => {
    const handleRequest = vi.fn(async () => ({ ok: true as const, data: null }))
    const m = mount({
      ...ROSTER_OPTIONS,
      allowedMethods: ['course.roster', 'records.list'],
      handleRequest,
      limits: { startTimeoutMs: 1000, helloTimeoutMs: 500, malformedMax: 3, rosterPerSecond: 1, callsPerMinute: 1 },
    })
    const session = readyV2(m)
    m.send(roster(session, 'render', { payload: payload([HANDLE_A]) }))
    m.send(roster(session, 'render', { payload: payload([HANDLE_A, HANDLE_B]) }))
    await namesDrawn(m)
    expect(m.container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(m.frame.snapshot().strikes).toBe(0)
    // The roster used none of the one call this frame has.
    m.send(request(session, 'q1', 'records.list', { collection: 'x' }))
    await vi.waitFor(() => expect(m.posted.at(-1)).toMatchObject({ type: 'response', id: 'q1', ok: true }))
    expect(handleRequest).toHaveBeenCalledTimes(1)
  })

  it('removes a table on remove, and the whole layer when the frame stops', async () => {
    const m = mount(ROSTER_OPTIONS)
    const session = readyV2(m)
    m.send(roster(session, 'render', { payload: payload() }))
    await namesDrawn(m)
    m.send(roster(session, 'remove'))
    expect(m.container.querySelector('[data-studio-roster="r1"]')).toBeNull()
    m.send(roster(session, 'render', { payload: payload() }))
    m.frame.destroy()
    expect(m.container.querySelector('[data-studio-roster]')).toBeNull()
  })
})
