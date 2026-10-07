// Screenshot evidence for the generation-quality judge (Step 12A). Reads
// { manifest, studentBundle, professorBundle, sample, outDir } as JSON on stdin, writes JPEGs
// into outDir and prints { shots, failures } as JSON on stdout. Spawned by capture.ts with a
// minimal environment, like the builder's renderer.
//
// It goes through the Stage 2 runner's servers and host page (runner.mjs): the real frame
// document and policy, the real runtime and kit of the manifest's bridge version, the real
// host with the preview bridge and the synthetic class, Chromium's sandbox on, and every
// request to anything but the two local origins blocked. It never touches render.mjs, the
// builder's own renderer.
//
// Shots: the normal state of both views at desktop and phone width (the required ones), and
// both views at desktop width with no data (empty), while loading (slow) and when every
// request fails (failing). Each is the whole frame as it lays out, not cut at a fixed
// height. The frame itself is capped at STUDIO_FRAME_MAX_HEIGHT_PX by the host; a view
// taller than that is marked truncated.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { openScenario, startServers, waitFor } from '../../validator-runtime/runner.mjs'

const INPUT_MAX_BYTES = 3 * 1024 * 1024
const VIEWPORT_HEIGHT = 900
const QUALITY = 80
const TIMEOUT_MS = 180_000
const DEVICES = { desktop: 1280, phone: 390 }
const SHOTS = [
  { view: 'professor', device: 'desktop', scenario: 'normal' },
  { view: 'professor', device: 'phone', scenario: 'normal' },
  { view: 'student', device: 'desktop', scenario: 'normal' },
  { view: 'student', device: 'phone', scenario: 'normal' },
  { view: 'professor', device: 'desktop', scenario: 'empty' },
  { view: 'student', device: 'desktop', scenario: 'empty' },
  { view: 'professor', device: 'desktop', scenario: 'slow' },
  { view: 'student', device: 'desktop', scenario: 'slow' },
  { view: 'professor', device: 'desktop', scenario: 'failing' },
  { view: 'student', device: 'desktop', scenario: 'failing' },
]
const STATE = { empty: 'empty', slow: 'loading', failing: 'error' }
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const chunks = []
let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  if (size > INPUT_MAX_BYTES) process.exit(2)
  chunks.push(chunk)
}
const raw = Buffer.concat(chunks)
// Echoed back, so the caller can check these screenshots are of exactly what it sent.
const inputSha256 = createHash('sha256').update(raw).digest('hex')
let input
try {
  input = JSON.parse(raw.toString('utf8'))
} catch {
  process.exit(2)
}
if (
  !isPlainObject(input) ||
  !isPlainObject(input.manifest) ||
  typeof input.studentBundle !== 'string' ||
  typeof input.professorBundle !== 'string' ||
  typeof input.outDir !== 'string' ||
  !(input.sample === null || input.sample === undefined || isPlainObject(input.sample))
) {
  process.exit(2)
}

async function capture() {
  const artifact = { manifest: input.manifest, studentBundle: input.studentBundle, professorBundle: input.professorBundle }
  mkdirSync(input.outDir, { recursive: true })
  const servers = await startServers(artifact)
  const browser = await chromium.launch({ chromiumSandbox: true })
  const killer = setTimeout(() => browser.close().catch(() => {}), TIMEOUT_MS)
  const shots = []
  const failures = []
  try {
    for (const shot of SHOTS) {
      const id = `${shot.view}-${shot.device}-${shot.scenario}`
      const width = DEVICES[shot.device]
      const s = await openScenario(browser, servers, artifact, shot.view, shot.scenario, { width, height: VIEWPORT_HEIGHT }, {
        sample: input.sample ?? null,
        className: 'render-frame',
      })
      try {
        await s.page.emulateMedia({ reducedMotion: 'reduce' })
        const ready = await waitFor(async () => (await s.snapshot())?.status === 'ready', 10_000)
        if (!ready) {
          failures.push({ id, reason: (await s.snapshot())?.reason ?? 'not_ready' })
          continue
        }
        const hasState = (state) => async () => {
          const frame = s.frame()
          return frame ? frame.evaluate((sel) => !!document.querySelector(sel), `[data-kit-state="${state}"]`) : false
        }
        if (shot.scenario === 'normal') {
          // Let the first reads land and the frame settle at its content height.
          await waitFor(async () => !(await hasState('loading')()), 4_000)
          await s.page.waitForTimeout(600)
        } else {
          // Screenshot whatever is there; whether the state appeared is recorded either way.
          await waitFor(hasState(STATE[shot.scenario]), shot.scenario === 'slow' ? 2_000 : 6_000)
          if (shot.scenario !== 'slow') await s.page.waitForTimeout(400)
        }
        const after = await s.snapshot()
        if (after?.status !== 'ready') {
          failures.push({ id, reason: after?.reason ?? 'not_ready' })
          continue
        }
        const stateShown = shot.scenario === 'normal' ? null : await hasState(STATE[shot.scenario])()
        const frame = s.frame()
        const content = frame ? await frame.evaluate(() => ({ scroll: document.documentElement.scrollHeight, client: document.documentElement.clientHeight })) : null
        const height = await s.page.evaluate(() => Math.ceil(document.getElementById('mount').getBoundingClientRect().height))
        const file = `${id}.jpg`
        const bytes = await s.page.screenshot({ type: 'jpeg', quality: QUALITY, fullPage: true, clip: { x: 0, y: 0, width, height: Math.max(height, 160) } })
        writeFileSync(join(input.outDir, file), bytes)
        shots.push({
          id,
          file,
          view: shot.view,
          device: shot.device,
          width,
          scenario: shot.scenario,
          height: Math.max(height, 160),
          truncated: content ? content.scroll > content.client + 2 : false,
          stateShown,
        })
      } finally {
        await s.context.close()
      }
    }
  } finally {
    clearTimeout(killer)
    await browser.close().catch(() => {})
    servers.close()
  }
  return { shots, failures }
}

try {
  const result = await capture()
  process.stdout.write(JSON.stringify({ ...result, inputSha256 }), () => process.exit(0))
} catch {
  process.exit(1)
}
