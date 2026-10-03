// The design-review renderer, local mode (docs/designs/studio/studio-builder-quality.md
// 3.8). Reads { manifest, studentBundle, professorBundle, sample } as JSON on stdin,
// renders both views at desktop and phone width, and prints
// { ok, images: [{ label, mediaType: 'image/jpeg', base64 }] } as JSON on stdout.
// Spawned by src/lib/studio/builder/renderer.ts with an empty environment.
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

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const chunks = []
let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  if (size > INPUT_MAX_BYTES) process.exit(2)
  chunks.push(chunk)
}

let input
try {
  input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
} catch {
  process.exit(2)
}
if (
  !isPlainObject(input) ||
  !isPlainObject(input.manifest) ||
  typeof input.studentBundle !== 'string' ||
  typeof input.professorBundle !== 'string' ||
  !(input.sample === null || input.sample === undefined || isPlainObject(input.sample))
) {
  process.exit(2)
}

async function render() {
  const { openScenario, startServers, waitFor } = await import('./runner.mjs')
  const artifact = { manifest: input.manifest, studentBundle: input.studentBundle, professorBundle: input.professorBundle }
  const servers = await startServers(artifact)
  // Keep Chromium's own OS sandbox on, as the runner does: plugin code runs in this renderer.
  const browser = await chromium.launch({ chromiumSandbox: true })
  const killer = setTimeout(() => browser.close().catch(() => {}), TIMEOUT_MS)
  const images = []
  try {
    for (const shot of SHOTS) {
      const s = await openScenario(browser, servers, artifact, shot.view, 'normal', { width: shot.width, height: VIEWPORT_HEIGHT }, {
        sample: input.sample ?? null,
        className: 'render-frame',
      })
      try {
        const ready = await waitFor(async () => (await s.snapshot())?.status === 'ready', 10_000)
        if (!ready) continue
        // Let the first reads land and the frame settle at its content height.
        await waitFor(async () => {
          const frame = s.frame()
          return frame ? !(await frame.evaluate(() => !!document.querySelector('[data-kit-state="loading"]'))) : false
        }, 4_000)
        await s.page.waitForTimeout(600)
        if ((await s.snapshot())?.status !== 'ready') continue
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
  return images
}

try {
  const images = await render()
  // Exit only once the result is flushed: pipes are asynchronous on some platforms.
  process.stdout.write(JSON.stringify({ ok: images.length > 0, images }), () => process.exit(0))
} catch {
  process.exit(1)
}
