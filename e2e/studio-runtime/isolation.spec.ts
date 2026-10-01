/**
 * Can untrusted plugin JavaScript, in the real runtime frame, reach anything it shouldn't?
 * Runs in Chromium, Firefox and WebKit against harness.mjs (see there for the four origins).
 *
 * "Blocked" here means two things together: the plugin's own attempt failed, AND nothing
 * arrived at the attacker server. Channels the browser can't reliably block are recorded,
 * per browser, rather than asserted as blocked (docs/reference/studio-plugin-runtime.md).
 */
import { expect, test, type Page } from '@playwright/test'

const RUNTIME = 'http://127.0.0.1:4311'
const ATTACKER = 'http://127.0.0.1:4312'
const RUNTIME_V9 = 'http://127.0.0.1:4313'
const frameUrl = (variant: string, origin = RUNTIME) => `${origin}/studio-frame/v1/probe/${variant}`

interface Snapshot {
  status: 'loading' | 'handshaking' | 'ready' | 'stale' | 'stopped'
  reason?: string
  session?: string
  loads: number
  strikes: number
}
interface Report {
  method: string
  args: Record<string, unknown>
}
interface AttackerLog {
  requests: { path: string; cookie: boolean }[]
  idleConnections: number
}

interface MountOptions {
  mode?: 'custom' | 'bridge' | 'preview'
  limits?: Record<string, number>
  allowedMethods?: string[]
  versionId?: string
}
interface BridgeLogEntry {
  body: Record<string, unknown> & { type: 'call' | 'event' | 'status'; method?: string; args?: unknown }
  origin: string | null
  contentType: string | null
}

declare global {
  interface Window {
    harnessReady?: boolean
    harness: {
      state: {
        reports: Report[]
        security: string[]
        previewCalls: { method: string; result: unknown }[]
        toasts: { message: string; tone: string }[]
      }
      mount(url: string, options?: MountOptions): void
      snapshot(): Snapshot | null
      destroy(): void
    }
  }
}

const attackerLog = async (): Promise<AttackerLog> => (await fetch(`${ATTACKER}/__log`)).json()
const hits = async (prefix: string) => (await attackerLog()).requests.filter((r) => r.path.startsWith(prefix))

const APP = 'http://localhost:4310'
const bridgeLog = async (): Promise<BridgeLogEntry[]> => (await fetch(`${APP}/__bridge-log`)).json()

async function open(page: Page) {
  await fetch(`${ATTACKER}/__reset`)
  await fetch(`${APP}/__bridge-reset`)
  await page.goto('/host.html')
  await page.waitForFunction(() => window.harnessReady === true)
}

async function mount(page: Page, url: string, options?: MountOptions) {
  await page.evaluate(([u, o]) => window.harness.mount(u as string, o as MountOptions | undefined), [url, options] as const)
}

const snapshot = (page: Page) => page.evaluate(() => window.harness.snapshot())
const reports = (page: Page) => page.evaluate(() => window.harness.state.reports)

async function waitForStatus(page: Page, status: Snapshot['status']) {
  await expect.poll(async () => (await snapshot(page))?.status, { timeout: 15_000 }).toBe(status)
}

test.describe('the isolation probe', () => {
  let phase1: Record<string, string>
  let phase2: Record<string, string>
  let log: AttackerLog
  let downloads = 0
  let pagesAfter = 0
  let hostUrlAfter = ''

  test.beforeAll(async ({ browser }, testInfo) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('download', () => (downloads += 1))
    await open(page)
    await mount(page, frameUrl('probe'))
    await expect.poll(async () => (await reports(page)).length, { timeout: 25_000 }).toBeGreaterThanOrEqual(2)
    const all = await reports(page)
    phase1 = all[0].args.results as Record<string, string>
    phase2 = all[1].args.results as Record<string, string>
    await page.waitForTimeout(1500) // let the form submission and any late request land
    log = await attackerLog()
    pagesAfter = context.pages().length
    hostUrlAfter = page.url()
    const record = { browser: testInfo.project.name, phase1, phase2, attacker: log, downloads, final: await snapshot(page) }
    console.log(`PROBE_RESULTS ${JSON.stringify(record)}`)
    await testInfo.attach('probe-results', { body: JSON.stringify(record, null, 2), contentType: 'application/json' })
    await context.close()
  })

  test('nothing the plugin tried reached the attacker server, cookies or not', () => {
    // Every probe is an HTTP request, a WebSocket or a connection; none of them may arrive.
    expect(log.requests.map((r) => r.path)).toEqual([])
  })

  test('host DOM is unreachable', () => {
    for (const p of ['parentDocument', 'topDocument', 'parentLocation']) expect(phase1[p], p).toMatch(/^blocked/)
  })

  test('cookies, storage, IndexedDB and Cache Storage are unreachable', () => {
    for (const p of ['cookie', 'localStorage', 'sessionStorage', 'indexedDB']) expect(phase1[p], p).toMatch(/^blocked/)
    expect(phase1.cacheStorage).toMatch(/^(blocked|unavailable)/)
  })

  test('fetch, XHR, WebSocket and EventSource fail', () => {
    for (const p of ['fetch', 'xhr', 'websocket', 'eventSource']) expect(phase1[p], p).toMatch(/^blocked/)
  })

  test('external script, image, stylesheet, font and media fail', () => {
    for (const p of ['script', 'image', 'stylesheet', 'font', 'media']) expect(phase1[p], p).toMatch(/^blocked/)
  })

  test('eval, new Function and inline scripts without the nonce are refused', () => {
    for (const p of ['eval', 'newFunction', 'inlineScriptWithoutNonce']) expect(phase1[p], p).toMatch(/^blocked/)
  })

  test('workers and service workers fail', () => {
    for (const p of ['worker', 'blobWorker']) expect(phase1[p], p).toMatch(/^blocked/)
    expect(phase1.sharedWorker).toMatch(/^(blocked|unavailable)/)
    expect(phase1.serviceWorker).toMatch(/^(blocked|unavailable)/)
  })

  test('popups and top navigation fail, and the host page stays where it was', () => {
    expect(phase1.popup).toMatch(/^blocked/)
    expect(pagesAfter).toBe(1)
    expect(phase1.topNavigation).toMatch(/^blocked/)
    expect(hostUrlAfter).toBe('http://localhost:4310/host.html')
  })

  test('downloads and form submission go nowhere', () => {
    expect(downloads).toBe(0)
    expect(log.requests.some((r) => r.path.startsWith('/form'))).toBe(false)
  })

  test('the runtime removed the WebRTC constructor and resource hints before plugin code ran', () => {
    expect(phase1.webrtcConstructor).toBe('removed')
    expect(phase1.dnsPrefetchElement).toBe('removed by runtime')
    expect(phase1.preconnectElement).toBe('removed by runtime')
  })

  test('WebRTC through a child frame and preconnect are recorded, not claimed as blocked', () => {
    // Browser-dependent (N10, N11). The outcome is in PROBE_RESULTS and the attachment;
    // docs/reference/studio-plugin-runtime.md records it per browser.
    test.info().annotations.push(
      { type: 'webrtcFromChildFrame', description: String(phase1.webrtcFromChildFrame) },
      { type: 'idleConnectionsAtAttacker', description: String(log.idleConnections) },
    )
    expect(phase1.webrtcFromChildFrame).toBeDefined()
  })
})

test.describe('the handshake and frame identity', () => {
  test('plugin code starts only after the handshake, and learns no IDs', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('ready'))
    await expect.poll(async () => (await reports(page)).length).toBe(1)
    const [report] = await reports(page)
    expect(report.args.context).toEqual({ runtime: 'v1', view: 'student', theme: 'light' })
    expect(await snapshot(page)).toMatchObject({ status: 'ready', loads: 1 })
  })

  test('a message with a stale session is refused; the real session works', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('stale'))
    await expect.poll(async () => (await reports(page)).length).toBe(1)
    expect((await reports(page))[0].args).toEqual({ fresh: true })
    expect((await snapshot(page))?.strikes).toBe(1)
  })

  test('a sibling frame and a popup on another origin can’t impersonate the plugin, even with its session', async ({ page, context }) => {
    await open(page)
    await mount(page, frameUrl('ready'))
    await waitForStatus(page, 'ready')
    const session = (await snapshot(page))!.session!

    await page.evaluate((src) => {
      const f = document.createElement('iframe')
      f.src = src
      f.id = 'impostor'
      document.body.appendChild(f)
    }, `${RUNTIME}/impostor.html#${session}`)
    const sibling = page.frameLocator('#impostor').locator('body[data-done="1"]')
    await expect(sibling).toHaveCount(1)
    expect(JSON.parse((await sibling.getAttribute('data-got'))!)).toEqual([])

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.evaluate((src) => void window.open(src), `${RUNTIME}/impostor.html#${session}`),
    ])
    await expect(popup.locator('body[data-done="1"]')).toHaveCount(1)
    expect(JSON.parse((await popup.locator('body').getAttribute('data-got'))!)).toEqual([])

    expect((await reports(page)).some((r) => 'impostor' in r.args)).toBe(false)
    expect((await snapshot(page))?.status).toBe('ready')
  })

  test('an unsupported bridge version stops cleanly, and the plugin never runs', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('ready', RUNTIME_V9))
    await waitForStatus(page, 'stopped')
    expect(await snapshot(page)).toMatchObject({ reason: 'unsupported-runtime' })
    expect(await reports(page)).toEqual([])
    expect(await page.locator('iframe').count()).toBe(0)
  })

  test('a frame that never loads is stopped at the start timeout', async ({ page }) => {
    await open(page)
    await mount(page, `${RUNTIME}/hang`, { limits: { startTimeoutMs: 1500 } })
    await waitForStatus(page, 'stopped')
    expect(await snapshot(page)).toMatchObject({ reason: 'start-timeout' })
  })

  test('a crashing plugin is stopped', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('crash'))
    await waitForStatus(page, 'stopped')
    expect(await snapshot(page)).toMatchObject({ reason: 'crashed' })
  })
})

test.describe('self-navigation (N9): detected, not prevented', () => {
  test('the navigation request leaves the browser, and the host then kills the frame', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('selfnav'))
    await waitForStatus(page, 'stopped')
    expect(await snapshot(page)).toMatchObject({ reason: 'navigated', loads: 2 })
    expect(await page.evaluate(() => window.harness.state.security)).toEqual(['navigated'])
    expect(await page.locator('iframe').count()).toBe(0)
    // The data in the URL arrived: detection is not prevention.
    await expect.poll(async () => (await hits('/nav')).map((r) => r.path)).toEqual(['/nav?leak=probe-data'])
  })
})

test.describe('the frame document on its own', () => {
  test('framed by a site that isn’t Scholera, it doesn’t run (frame-ancestors)', async ({ page }) => {
    await page.goto(`${ATTACKER}/framer.html?src=${encodeURIComponent(frameUrl('ready'))}`)
    await page.waitForTimeout(1500)
    expect(await page.locator('body').getAttribute('data-hello')).toBeNull()
  })

  test('opened directly, it’s still sandboxed: opaque origin, no storage', async ({ page }) => {
    await page.goto(frameUrl('ready'))
    expect(await page.evaluate(() => self.origin)).toBe('null')
    expect(await page.evaluate(() => {
      try {
        void localStorage.length
        return 'reachable'
      } catch {
        return 'blocked'
      }
    })).toBe('blocked')
  })
})

test.describe('the bridge: plugin, host, HTTPS, back', () => {
  const calls = async () => (await bridgeLog()).filter((e) => e.body.type === 'call')

  test('a plugin request becomes one POST from the host, and the answer comes back to the plugin', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('bridgecall'), { mode: 'bridge' })
    await expect.poll(async () => (await calls()).length).toBe(2)
    const [first, second] = await calls()
    // Sent by Scholera's page, not the frame: same-origin, JSON, nothing but method and args from the plugin.
    expect(first.origin).toBe('http://localhost:4310')
    expect(first.contentType).toBe('application/json')
    expect(Object.keys(first.body).sort()).toEqual(['args', 'expectedVersionId', 'host', 'installationId', 'method', 'type', 'v'])
    expect(first.body).toMatchObject({ method: 'records.list', args: { collection: 'responses' } })
    // The second call carries what the plugin received from the first.
    expect(second.body).toMatchObject({ method: 'test.report', args: { got: { echo: 'records.list' } } })
  })

  test('a sibling frame or a popup can’t send requests through the registered frame', async ({ page, context }) => {
    await open(page)
    await mount(page, frameUrl('ready'), { mode: 'bridge' })
    await waitForStatus(page, 'ready')
    const session = (await snapshot(page))!.session!
    await page.evaluate((src) => {
      const f = document.createElement('iframe')
      f.src = src
      f.id = 'impostor'
      document.body.appendChild(f)
    }, `${RUNTIME}/impostor.html#${session}`)
    await expect(page.frameLocator('#impostor').locator('body[data-done="1"]')).toHaveCount(1)
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.evaluate((src) => void window.open(src), `${RUNTIME}/impostor.html#${session}`),
    ])
    await expect(popup.locator('body[data-done="1"]')).toHaveCount(1)
    expect((await calls()).some((c) => JSON.stringify(c.body.args).includes('impostor'))).toBe(false)
  })

  test('a stale-session message never reaches the bridge', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('stale'), { mode: 'bridge' })
    await expect.poll(async () => (await calls()).length).toBe(1)
    expect((await calls())[0].body.args).toEqual({ fresh: true })
  })

  test('an oversized message is refused by the host and never sent', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('oversized'), { mode: 'bridge' })
    await expect.poll(async () => (await calls()).length).toBe(1)
    expect((await calls())[0].body).toMatchObject({ method: 'test.report', args: { after: 'oversized' } })
  })

  test('too many malformed messages stop the frame, and the stop is reported with the reason only', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('junk'), { mode: 'bridge' })
    await waitForStatus(page, 'stopped')
    expect(await snapshot(page)).toMatchObject({ reason: 'malformed' })
    await expect.poll(async () => (await bridgeLog()).filter((e) => e.body.type === 'event').map((e) => e.body)).toEqual([
      { v: 1, type: 'event', installationId: '00000000-0000-4000-8000-000000000001', reason: 'malformed' },
    ])
  })

  test('a method the manifest doesn’t allow is refused by the host, before the network', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('undeclared'), { mode: 'bridge', allowedMethods: ['records.list'] })
    await expect.poll(async () => (await calls()).length).toBe(1)
    expect((await calls())[0].body).toMatchObject({ method: 'records.list', args: { report: 'unsupported' } })
  })

  test('preview answers from sample data and never reaches the real bridge', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('previewcall'), { mode: 'preview' })
    await expect.poll(async () => (await page.evaluate(() => window.harness.state.previewCalls)).length).toBe(2)
    const previewCalls = await page.evaluate(() => window.harness.state.previewCalls)
    expect(previewCalls[0]).toMatchObject({ method: 'context.get', result: { ok: true, data: { preview: true, view: 'student' } } })
    expect(previewCalls[1]).toMatchObject({ method: 'records.list', result: { ok: true, data: [{ mine: true }] } })
    expect(await bridgeLog()).toEqual([])
  })
})

test.describe('host-only methods and stale frames', () => {
  const calls = async () => (await bridgeLog()).filter((e) => e.body.type === 'call')

  test('ui.resize and ui.toast are answered by the host, within its limits, and never reach the bridge', async ({ page }) => {
    let dialogs = 0
    page.on('dialog', (d) => {
      dialogs += 1
      void d.dismiss()
    })
    await open(page)
    await mount(page, frameUrl('ui'), { mode: 'bridge' })
    await expect.poll(async () => (await calls()).length).toBe(1)
    const [only] = await calls()
    expect(only.body).toMatchObject({ method: 'records.list', args: { report: { big: { height: 2400 }, bad: 'invalid', long: 'invalid' } } })
    expect(await page.locator('iframe').evaluate((el) => (el as HTMLIFrameElement).style.height)).toBe('2400px')
    expect(await page.evaluate(() => window.harness.state.toasts)).toEqual([{ message: '<img src=x onerror=alert(1)>', tone: 'info' }])
    expect(dialogs).toBe(0)
  })

  test('a stale answer freezes the frame: later requests are refused without reaching the bridge', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('stalecall'), { mode: 'bridge', versionId: '00000000-0000-4000-8000-0000000000de' })
    await waitForStatus(page, 'stale')
    expect((await calls()).length).toBe(1)
    // The frame stays on the page, on its old code, until the viewer reloads.
    expect(await page.locator('iframe').count()).toBe(1)
    await expect(page.frameLocator('iframe').locator('body[data-codes]')).toHaveAttribute('data-codes', 'stale,stale')
  })
})

// ── Step 5B: losing access while a frame is open ─────────────────────

test.describe('losing access while a frame is open', () => {
  const setAccess = (to: 'available' | 'readOnly' | 'unavailable') => fetch(`${APP}/__bridge-access?to=${to}`)
  const HEARTBEAT = { statusIntervalMs: 400 }

  test('a frame that never calls the bridge is closed by the heartbeat once access is gone', async ({ page }) => {
    await open(page)
    await mount(page, frameUrl('silent'), { mode: 'bridge', limits: HEARTBEAT })
    await waitForStatus(page, 'ready')
    await expect(page.frameLocator('iframe').locator('body[data-ran="yes"]')).toHaveCount(1)
    await setAccess('unavailable')
    await waitForStatus(page, 'stopped')
    expect((await snapshot(page))?.reason).toBe('unavailable')
    expect(await page.locator('iframe').count()).toBe(0)
    // The heartbeat names the installation and its version, and nothing else.
    const statusChecks = (await bridgeLog()).filter((e) => e.body.type === 'status')
    expect(statusChecks.length).toBeGreaterThan(0)
    expect(Object.keys(statusChecks[0].body).sort()).toEqual(['expectedVersionId', 'installationId', 'type', 'v'])
    // An `unavailable` stop is the server's decision, so it isn't reported back.
    expect((await bridgeLog()).filter((e) => e.body.type === 'event')).toEqual([])
  })

  test('a bridge call answered unavailable stops the frame at once', async ({ page }) => {
    await open(page)
    await setAccess('unavailable')
    await mount(page, frameUrl('bridgecall'), { mode: 'bridge' })
    await waitForStatus(page, 'stopped')
    expect((await snapshot(page))?.reason).toBe('unavailable')
    // The plugin's follow-up call never happened: it never got an answer to continue from.
    const calls = (await bridgeLog()).filter((e) => e.body.type === 'call')
    expect(calls.map((c) => c.body.method)).toEqual(['records.list'])
  })

  test('read-only from the heartbeat refuses writes in the host, before the network', async ({ page }) => {
    await open(page)
    await setAccess('readOnly')
    await mount(page, frameUrl('latewrite'), { mode: 'bridge', limits: HEARTBEAT })
    await expect
      .poll(async () => (await bridgeLog()).find((e) => e.body.method === 'test.report')?.body.args, { timeout: 15_000 })
      .toEqual({ code: 'not_available' })
    expect((await bridgeLog()).some((e) => e.body.method === 'records.create')).toBe(false)
    expect(await page.locator('iframe').count()).toBe(1)
  })
})
