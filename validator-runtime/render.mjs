// The design-review renderer, local mode (docs/designs/studio/studio-builder-quality.md
// 3.8). Reads { manifest, studentBundle, professorBundle, sample, server } as one JSON line
// on stdin, renders both views at desktop and phone width, and prints
// { type: 'result', ok, images: [{ label, mediaType: 'image/jpeg', base64 }], failures } as
// the last JSON line on stdout. Spawned by src/lib/studio/builder/renderer.ts with an empty
// environment.
//
// A draft with server code (`server: true`): each server.call a view makes is printed as a
// { type: 'server.call', id, view, call } line, and the parent answers with a
// { type: 'reply', id, reply } line on stdin. The parent runs the draft's server code in its
// own executor on the preview's records; nothing here runs it.
//
// The same boundary as the Stage 2 runner (runner.mjs): the real frame document and
// policy, the real runtime and kit of the manifest's bridge version, the real host
// controller with the preview bridge, Chromium's OS sandbox on, and every request to
// anything but the two local origins aborted. The views see only the draft's sample data
// and the synthetic class (preview-roster.ts), so a screenshot never shows a real student.
//
// Exit codes: 0 with the result on stdout, 2 for input that is too large or invalid
// (nothing printed), 1 for any other failure.
import { chromium } from '@playwright/test'

const INPUT_MAX_BYTES = 3 * 1024 * 1024
const SHOTS = [
  { view: 'professor', label: 'professor-desktop', width: 1280 },
  { view: 'professor', label: 'professor-phone', width: 390 },
  { view: 'student', label: 'student-desktop', width: 1280 },
  { view: 'student', label: 'student-phone', width: 390 },
]
const VIEWPORT_HEIGHT = 900
const CLIP_MAX_PX = 1800
const IMAGE_MAX_BYTES = 400 * 1024
// A screenshot over the size cap is retaken at the lower quality, then dropped.
const QUALITIES = [70, 50]
const TIMEOUT_MS = 50_000
const SERVER_CALLS_MAX = 40

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// stdin is lines: the input first, then replies to server calls.
const replies = new Map()
let input = null
let resolveInput
const inputReady = new Promise((resolve) => (resolveInput = resolve))
let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  if (buffered.length > INPUT_MAX_BYTES) process.exit(2)
  let i
  while ((i = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, i)
    buffered = buffered.slice(i + 1)
    let message
    try {
      message = JSON.parse(line)
    } catch {
      process.exit(2)
    }
    if (input === null) {
      input = message
      resolveInput()
    } else if (isPlainObject(message) && message.type === 'reply' && replies.has(message.id)) {
      replies.get(message.id)(JSON.stringify(message.reply ?? null))
      replies.delete(message.id)
    }
  }
})
process.stdin.on('end', () => {
  if (input === null) process.exit(2)
})
await inputReady

if (
  !isPlainObject(input) ||
  !isPlainObject(input.manifest) ||
  typeof input.studentBundle !== 'string' ||
  typeof input.professorBundle !== 'string' ||
  !(input.sample === null || input.sample === undefined || isPlainObject(input.sample))
) {
  process.exit(2)
}

let nextCall = 1
/** One view's server.call, asked of the parent. Resolves with the reply as JSON text. */
function serverCall(view, json) {
  if (nextCall > SERVER_CALLS_MAX) return Promise.resolve(JSON.stringify({ result: { ok: false, code: 'failed', message: 'Too many requests.' }, store: null }))
  const id = nextCall++
  return new Promise((resolve) => {
    replies.set(id, resolve)
    process.stdout.write(`${JSON.stringify({ type: 'server.call', id, view, call: JSON.parse(json) })}\n`)
  })
}

async function render() {
  const { openScenario, startServers, waitFor } = await import('./runner.mjs')
  const artifact = { manifest: input.manifest, studentBundle: input.studentBundle, professorBundle: input.professorBundle }
  const servers = await startServers(artifact)
  // Keep Chromium's own OS sandbox on, as the runner does: plugin code runs in this renderer.
  const browser = await chromium.launch({ chromiumSandbox: true })
  const killer = setTimeout(() => browser.close().catch(() => {}), TIMEOUT_MS)
  const images = []
  const failures = []
  try {
    for (const shot of SHOTS) {
      const s = await openScenario(browser, servers, artifact, shot.view, 'normal', { width: shot.width, height: VIEWPORT_HEIGHT }, {
        sample: input.sample ?? null,
        className: 'render-frame',
        server: input.server === true,
        // exposeBinding reaches every frame, the plugin's included: answer the host page only.
        beforeMount:
          input.server === true
            ? (page) =>
                page.exposeBinding('studioServerCall', (source, json) =>
                  source.frame === page.mainFrame() && typeof json === 'string' && json.length <= INPUT_MAX_BYTES
                    ? serverCall(shot.view, json)
                    : Promise.reject(new Error('not available')),
                )
            : undefined,
      })
      try {
        const ready = await waitFor(async () => (await s.snapshot())?.status === 'ready', 10_000)
        if (!ready) {
          failures.push({ label: shot.label, reason: (await s.snapshot())?.reason ?? 'not_ready' })
          continue
        }
        // Let the first reads land and the frame settle at its content height.
        await waitFor(async () => {
          const frame = s.frame()
          return frame ? !(await frame.evaluate(() => !!document.querySelector('[data-kit-state="loading"]'))) : false
        }, input.server === true ? 8_000 : 4_000)
        await s.page.waitForTimeout(600)
        if ((await s.snapshot())?.status !== 'ready') {
          failures.push({ label: shot.label, reason: (await s.snapshot())?.reason ?? 'not_ready' })
          continue
        }
        const height = await s.page.evaluate(() => Math.ceil(document.getElementById('mount').getBoundingClientRect().height))
        const clip = { x: 0, y: 0, width: shot.width, height: Math.min(Math.max(height, 160), CLIP_MAX_PX) }
        for (const quality of QUALITIES) {
          const buffer = await s.page.screenshot({ type: 'jpeg', quality, fullPage: true, clip })
          if (buffer.length > IMAGE_MAX_BYTES) continue
          images.push({ label: shot.label, mediaType: 'image/jpeg', base64: buffer.toString('base64') })
          break
        }
      } finally {
        await s.context.close()
      }
    }
  } finally {
    clearTimeout(killer)
    await browser.close().catch(() => {})
    servers.close()
  }
  return { images, failures }
}

try {
  const { images, failures } = await render()
  // Exit only once the result is flushed: pipes are asynchronous on some platforms.
  process.stdout.write(`${JSON.stringify({ type: 'result', ok: images.length > 0 || failures.length > 0, images, failures })}\n`, () => process.exit(0))
} catch {
  process.exit(1)
}
