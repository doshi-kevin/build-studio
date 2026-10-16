// The Stage 2 (runtime) validator runner. docs/reference/studio-plugin-validator.md.
//
// Runs one plugin artifact's two views in headless Chromium, inside the real Step 4
// boundary: the real frame document and security policy from frame-document.ts, the
// real runtime.js, vendor.js and kit.css of the manifest's bridge version, the real
// host controller, on two local origins
// that are different sites (127.0.0.1 versus localhost), exactly like the isolation
// harness. Plugin code runs only in the sandboxed frame, never in this Node process.
//
// It measures and reports; it never decides a verdict. The server does
// (validator/runtime-report.ts), and requires every check for both views.
//
// Isolation of the runner itself: every request the browser makes to anything but the
// two local origins is blocked and counted, which is how an attempt to leave the
// sandbox is caught here. That is browser-level blocking on this machine, NOT the
// production network isolation the container must provide (no egress at all).
//
// Honest limits: layout, accessibility and state checks evaluate inside the plugin's own
// page, where hostile code could tamper with what they observe. They are quality gates.
// The security checks (navigation, outbound requests) are observed outside the frame.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const require = createRequire(import.meta.url)
const { frameHeaders, frameHtml } = await import('../src/lib/studio/runtime/frame-document.ts')
const limits = await import('../src/lib/studio/limits.ts')

export const RUNNER = { name: 'scholera-local-runner', version: '1.0.0' }
const VIEWS = ['student', 'professor']
const PHONE = { width: 375, height: 812 }
const TARGET_PX = 44
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
// True only in the container bundle: build.mjs defines it and puts the prebuilt host
// script, runtime assets and axe next to the bundle in dist/. From source it is
// undeclared, and the host script is built with esbuild on first use.
const PREBUILT = typeof __STUDIO_VALIDATOR_PREBUILT__ !== 'undefined'
// The bridge versions this runner serves; protocol.ts BRIDGE_VERSIONS, repeated because
// this file loads TypeScript only through Node's type stripping, file by file.
export const RUNTIMES = ['v1', 'v2']
const assetDir = (runtime) => (PREBUILT ? join(here, 'studio-runtime', runtime) : join(repo, 'public', 'studio-runtime', runtime))
const axeSource = readFileSync(PREBUILT ? join(here, 'axe.min.js') : require.resolve('axe-core/axe.min.js'), 'utf8')

let hostBundle
/** The validator host page's script: the real host controller, bundled for the browser. */
export async function hostScript() {
  if (PREBUILT) return (hostBundle ??= readFileSync(join(here, 'host.js'), 'utf8'))
  const { build } = await import('esbuild')
  hostBundle ??= (
    await build({
      entryPoints: [join(here, 'host-entry.ts')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      write: false,
      tsconfig: join(repo, 'tsconfig.json'),
      logLevel: 'error',
    })
  ).outputFiles[0].text
  return hostBundle
}

const HOST_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio validator</title><style>html,body{margin:0;padding:0}.validator-frame{display:block;width:100%;height:2000px;border:0}
.render-frame{display:block;width:100%;height:512px;border:0}</style></head>
<body><div id="mount"></div><script src="/host.js"></script></body></html>`

function listen(server, host) {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)))
}

/** The runtime a manifest's views load. A bridge this runner doesn't serve is a runner
 * failure, never a silent fallback to another version's kit. */
function runtimeOf(manifest) {
  const runtime = manifest?.bridgeVersion
  if (!RUNTIMES.includes(runtime)) throw new Error('unsupported bridge version')
  return runtime
}

export async function startServers(artifact) {
  const runtimeVersion = runtimeOf(artifact.manifest)
  const script = await hostScript()
  const runtimeServer = createServer()
  const appServer = createServer((req, res) => {
    if (req.url === '/host.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(HOST_PAGE)
    }
    if (req.url === '/host.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      return res.end(script)
    }
    res.writeHead(404)
    res.end()
  })
  const appPort = await listen(appServer, 'localhost')
  const runtimePort = await listen(runtimeServer, '127.0.0.1')
  const app = `http://localhost:${appPort}`
  const runtime = `http://127.0.0.1:${runtimePort}`
  runtimeServer.on('request', (req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const view = /^\/frame\/(student|professor)$/.exec(path)?.[1]
    if (view) {
      const input = {
        appOrigin: app,
        runtimeOrigin: runtime,
        nonce: randomBytes(18).toString('base64'),
        bundle: view === 'student' ? artifact.studentBundle : artifact.professorBundle,
        title: 'Plugin',
        runtime: runtimeVersion,
      }
      res.writeHead(200, frameHeaders(input))
      return res.end(frameHtml(input))
    }
    const [, version, asset] = /^\/studio-runtime\/(v[0-9]+)\/(runtime\.js|vendor\.js|kit\.css)$/.exec(path) ?? []
    if (asset && RUNTIMES.includes(version)) {
      res.writeHead(200, { 'Content-Type': asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' })
      return res.end(readFileSync(join(assetDir(version), asset)))
    }
    res.writeHead(404)
    res.end()
  })
  return { app, runtime, close: () => { appServer.close(); runtimeServer.close() } }
}

const quote = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').slice(0, limits.STUDIO_VALIDATOR_QUOTE_MAX_CHARS)

export async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => null)
    if (value) return value
    if (Date.now() > end) return null
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** One scenario of one view in a fresh browser context. `options` ({ sample, className })
 * is for the preview renderer (render.mjs). */
export async function openScenario(browser, servers, artifact, view, scenario, viewport, options = {}) {
  const context = await browser.newContext({ viewport })
  const outbound = []
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(servers.app + '/') || url.startsWith(servers.runtime + '/')) return route.continue()
    if (outbound.length < 20) outbound.push(quote(url.replace(/^([a-z]+:\/\/[^/?#]+).*$/i, '$1')))
    return route.abort('blockedbyclient')
  })
  const page = await context.newPage()
  await page.goto(`${servers.app}/host.html`)
  await page.evaluate(
    ([url, v, manifest, s, o]) => window.validator.mount(url, v, manifest, s, o),
    [`${servers.runtime}/frame/${view}`, view, artifact.manifest, scenario, options],
  )
  const snapshot = () => page.evaluate(() => window.validator.snapshot())
  const frame = () => page.frames().find((f) => f.url().startsWith(servers.runtime))
  return { context, page, snapshot, frame, outbound }
}

const has = (frame, selector) => frame.evaluate((sel) => !!document.querySelector(sel), selector)

async function runView(browser, servers, artifact, view) {
  const results = new Map()
  const set = (id, status, findings = []) => {
    const prior = results.get(id)
    if (prior && prior.status !== 'passed') return
    results.set(id, { id, view, status, findings: findings.slice(0, limits.STUDIO_VALIDATOR_FINDINGS_PER_CHECK).map((detail) => ({ detail: quote(detail) })) })
  }
  const deadline = Date.now() + limits.STUDIO_VALIDATOR_VIEW_TIMEOUT_MS
  const remaining = (cap) => Math.max(500, Math.min(cap, deadline - Date.now()))
  const isolation = []

  // Normal: boot, then layout, targets and accessibility at phone size.
  const normal = await openScenario(browser, servers, artifact, view, 'normal', PHONE)
  try {
    const ready = await waitFor(async () => (await normal.snapshot())?.status === 'ready', remaining(10_000))
    await normal.page.waitForTimeout(1500)
    const after = await normal.snapshot()
    if (!ready || !after || after.status !== 'ready') {
      set('runtime.boot', 'failed', [after?.status === 'stopped' ? `stopped: ${after.reason}` : `status: ${after?.status ?? 'none'}`])
      if (after?.status === 'stopped' && (after.reason === 'navigated' || after.reason === 'malformed')) isolation.push(`frame ${after.reason}`)
    } else {
      set('runtime.boot', 'passed')
      const frame = normal.frame()
      if (!frame) {
        set('runtime.mobile_layout', 'error', ['frame not found'])
      } else {
        const width = await frame.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
        set('runtime.mobile_layout', width.scroll > width.client + 1 ? 'failed' : 'passed', width.scroll > width.client + 1 ? [`content ${width.scroll}px wide at ${width.client}px`] : [])

        const small = await frame.evaluate((min) => {
          const out = []
          for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])')) {
            const r = el.getBoundingClientRect()
            if (r.width === 0 && r.height === 0) continue
            // A checkbox or radio counts with its label, which is part of its target.
            let w = r.width
            let h = r.height
            const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest('label')
            const row = label?.parentElement
            if ((el.type === 'checkbox' || el.type === 'radio') && row) {
              const lr = row.getBoundingClientRect()
              w = Math.max(w, lr.width)
              h = Math.max(h, lr.height)
            }
            if (w < min || h < min) out.push(`${el.tagName.toLowerCase()} ${Math.round(w)}x${Math.round(h)}`)
          }
          return out
        }, TARGET_PX)
        set('runtime.touch_targets', small.length > 0 ? 'failed' : 'passed', small)

        try {
          await frame.evaluate(axeSource)
          const violations = await frame.evaluate(async (tags) => {
            const r = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] })
            return r.violations.map((v) => `${v.id} (${v.nodes.length})`)
          }, AXE_TAGS)
          set('runtime.accessibility', violations.length > 0 ? 'failed' : 'passed', violations)
        } catch {
          set('runtime.accessibility', 'error', ['scan failed'])
        }
      }
    }
    isolation.push(...normal.outbound.map((o) => `request to ${o}`))
  } finally {
    await normal.context.close()
  }

  // Required states (rule 7.5): loading while the Bridge is slow, empty with no data,
  // and a plain error when every call fails, with no raw error text on screen.
  const states = []
  if (results.get('runtime.boot')?.status === 'passed') {
    for (const [scenario, selector] of [['slow', '[data-kit-state="loading"]'], ['empty', '[data-kit-state="empty"]'], ['failing', '[data-kit-state="error"]']]) {
      const s = await openScenario(browser, servers, artifact, view, scenario, PHONE)
      try {
        const seen = await waitFor(async () => {
          const f = s.frame()
          return f ? has(f, selector) : false
        }, remaining(scenario === 'slow' ? 2000 : 6000))
        if (!seen) states.push(`no ${selector.slice(17, -2)} state`)
        if (scenario === 'failing' && seen) {
          const leaked = await s.frame().evaluate((sentinel) => document.body.innerText.includes(sentinel), await s.page.evaluate(() => window.validator.sentinel))
          if (leaked) states.push('raw error text shown')
        }
        isolation.push(...s.outbound.map((o) => `request to ${o}`))
        const snap = await s.snapshot()
        if (snap?.status === 'stopped' && (snap.reason === 'navigated' || snap.reason === 'malformed')) isolation.push(`frame ${snap.reason}`)
      } finally {
        await s.context.close()
      }
    }
    set('runtime.states', states.length > 0 ? 'failed' : 'passed', states)
  } else {
    for (const id of ['runtime.mobile_layout', 'runtime.touch_targets', 'runtime.accessibility', 'runtime.states']) set(id, 'failed', ['did not boot'])
  }

  set('runtime.isolation', isolation.length > 0 ? 'failed' : 'passed', isolation)
  for (const id of ['runtime.mobile_layout', 'runtime.touch_targets', 'runtime.accessibility']) if (!results.has(id)) set(id, 'error', ['not measured'])
  return [...results.values()]
}

/** Runs both views and returns the report the server accepts. Throws only on a runner
 * failure (no browser, no servers), which the caller reports as an error. */
export async function runRuntimeValidation(artifact) {
  const servers = await startServers(artifact)
  // Keep Chromium's own OS sandbox on: Playwright turns it off unless asked. Plugin code
  // runs in this renderer, and on a developer machine the files around it hold secrets.
  const browser = await chromium.launch({ chromiumSandbox: true })
  const killer = setTimeout(() => browser.close().catch(() => {}), limits.STUDIO_VALIDATOR_RUNTIME_TIMEOUT_MS)
  try {
    const checks = []
    for (const view of VIEWS) checks.push(...(await runView(browser, servers, artifact, view)))
    return { runner: RUNNER, browser: `chromium ${browser.version()}`, checks }
  } finally {
    clearTimeout(killer)
    await browser.close().catch(() => {})
    servers.close()
  }
}
