/**
 * Renders a draft's two views for the builder's design review (docs/designs/studio/
 * studio-builder-quality.md 3.8): professor and student, at desktop and phone width,
 * on the draft's sample data and the synthetic class, as JPEG screenshots.
 *
 * Rendering runs plugin code, so it never happens in this process.
 *
 *   unavailable (the default, and always in production)
 *       No renderer. The review runs on the code alone.
 *   local (STUDIO_BUILDER_RENDERER=local; refused in production unless the database is on this machine)
 *       Spawns validator-runtime/render.mjs with the same minimal environment as the
 *       local Stage 2 runner (no Scholera secrets), which runs Playwright's Chromium with
 *       its OS sandbox on. For development: a developer machine is not an isolated
 *       environment. A production renderer would be a Cloud Run Job, like the validator's.
 *
 * Whatever the child prints is untrusted. Only JPEGs within the size caps come back.
 */
import 'server-only'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { logger } from '@/lib/logger'
import { STUDIO_BUILDER_REVIEW_IMAGE_MAX_BYTES, STUDIO_BUILDER_REVIEW_IMAGES_MAX } from '../limits'
import type { StudioManifest } from '../manifest'
import type { PreviewSample } from '../runtime/preview-bridge'
import { runnerEnvironment } from '../validator/runtime-runner'

export type RendererMode = 'unavailable' | 'local'

/** True only for a database on this machine: a deployed app never has one. */
const loopbackDatabase = (url: string | undefined) => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url ?? '').hostname)
  } catch {
    return false
  }
}

/** Local rendering runs where a developer machine is the environment: a dev server, or the guarded
 * production build (e2e/serve-guarded.mjs), which talks only to a loopback database. */
export function rendererMode(env: Record<string, string | undefined> = process.env): RendererMode {
  const local = env.NODE_ENV !== 'production' || loopbackDatabase(env.NEXT_PUBLIC_SUPABASE_URL)
  return env.STUDIO_BUILDER_RENDERER === 'local' && local ? 'local' : 'unavailable'
}

export interface RenderedImage {
  label: string
  mediaType: 'image/jpeg'
  bytes: Uint8Array
}

/** A view that never reached a running state: its screenshot label and why the frame stopped. */
export interface RenderFailure {
  label: string
  reason: string
}

export type RenderOutcome = { ok: true; images: RenderedImage[]; failures: RenderFailure[] } | { ok: false; reason: 'unavailable' | 'timeout' | 'failed' }

export interface RenderInput {
  manifest: StudioManifest
  bundles: { student: string; professor: string }
  sample: PreviewSample | null
}

export const RENDER_TIMEOUT_MS = 60_000
// Four images at the cap, in base64, plus the JSON around them.
const STDOUT_MAX_CHARS = Math.ceil((STUDIO_BUILDER_REVIEW_IMAGES_MAX * STUDIO_BUILDER_REVIEW_IMAGE_MAX_BYTES * 4) / 3) + 64 * 1024
const LABEL = /^[a-z][a-z-]{0,39}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

/** The images in the child's output that pass every check, at most the review's cap.
 * Null when the output isn't the renderer's shape at all. */
export function parseRenderOutput(stdout: string): RenderedImage[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { images?: unknown }).images)) return null
  const images: RenderedImage[] = []
  for (const item of (parsed as { images: unknown[] }).images) {
    if (images.length >= STUDIO_BUILDER_REVIEW_IMAGES_MAX) break
    if (!item || typeof item !== 'object') continue
    const { label, mediaType, base64 } = item as Record<string, unknown>
    if (typeof label !== 'string' || !LABEL.test(label) || mediaType !== 'image/jpeg' || typeof base64 !== 'string' || !BASE64.test(base64)) continue
    // Checked before decoding, so an oversized string is never turned into bytes.
    if (Math.floor((base64.length * 3) / 4) > STUDIO_BUILDER_REVIEW_IMAGE_MAX_BYTES + 2) continue
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
    if (bytes.length > STUDIO_BUILDER_REVIEW_IMAGE_MAX_BYTES || !isJpeg(bytes)) continue
    images.push({ label, mediaType: 'image/jpeg', bytes })
  }
  return images
}

/** Views the child says didn't run, with whitelisted labels and reasons only: it is untrusted output. */
export function parseRenderFailures(stdout: string): RenderFailure[] {
  try {
    const list = (JSON.parse(stdout) as { failures?: unknown }).failures
    if (!Array.isArray(list)) return []
    return list
      .filter((f): f is RenderFailure => !!f && typeof f === 'object' && LABEL.test(String((f as RenderFailure).label)) && /^[a-z_-]{1,30}$/.test(String((f as RenderFailure).reason)))
      .slice(0, STUDIO_BUILDER_REVIEW_IMAGES_MAX)
      .map((f) => ({ label: f.label, reason: f.reason }))
  } catch {
    return []
  }
}

export function renderPreview(input: RenderInput, env: Record<string, string | undefined> = process.env): Promise<RenderOutcome> {
  if (rendererMode(env) !== 'local') return Promise.resolve({ ok: false, reason: 'unavailable' })
  const payload = JSON.stringify({
    manifest: input.manifest,
    studentBundle: input.bundles.student,
    professorBundle: input.bundles.professor,
    sample: input.sample,
  })
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: RenderOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    // The repository root, when the server runs from a build that doesn't ship validator-runtime.
    const root = env.STUDIO_BUILDER_RENDERER_ROOT || process.cwd()
    const child = spawn(process.execPath, [join(root, 'validator-runtime', 'render.mjs')], {
      cwd: root,
      env: runnerEnvironment(env),
      stdio: 'pipe',
      windowsHide: true,
    })
    let out = ''
    const timer = setTimeout(() => {
      logger.warn('studio/builder.renderPreview: timed out')
      child.kill('SIGKILL')
      finish({ ok: false, reason: 'timeout' })
    }, RENDER_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      if (out.length > STDOUT_MAX_CHARS) {
        child.kill('SIGKILL')
        finish({ ok: false, reason: 'failed' })
      }
    })
    child.stderr.resume()
    child.on('close', (code) => {
      if (code !== 0) {
        logger.warn('studio/builder.renderPreview: renderer exited', { code })
        return finish({ ok: false, reason: 'failed' })
      }
      const images = parseRenderOutput(out)
      const failures = parseRenderFailures(out)
      finish(images && (images.length > 0 || failures.length > 0) ? { ok: true, images, failures } : { ok: false, reason: 'failed' })
    })
    child.on('error', () => finish({ ok: false, reason: 'failed' }))
    child.stdin.on('error', () => {
      // The child exited before reading its input; `close` reports it.
    })
    child.stdin.end(payload)
  })
}
