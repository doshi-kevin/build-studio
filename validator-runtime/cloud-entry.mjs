// Stage 2 runner, container mode: the entry point of the Cloud Run job
// (infra/validator-runner/). One execution handles one validation run:
//
//   1. GET the payload from PAYLOAD_URL, a V4 signed Cloud Storage URL.
//   2. Run both views (runner.mjs).
//   3. PUT the envelope { binding, report } to REPORT_URL, also signed, once.
//
// The report URL is signed with x-goog-if-generation-match: 0, so the object can be
// written only once. If anything wrote it first, the PUT gets 412 and this exits 1, the
// execution fails, and the server ends the run as an error instead of reading a report
// it did not get from this runner. The runner never decides a verdict.
//
// The job's environment holds only VALIDATION_ID, PAYLOAD_URL and REPORT_URL, set as
// execution overrides. Logs never carry the URLs (they are bearer credentials until
// they expire), the payload or the report: only fixed event words and numbers.
import { pathToFileURL } from 'node:url'
import { buildEnvelope, isUuid, PAYLOAD_MAX_BYTES, parsePayload } from './binding.mjs'
import { STUDIO_VALIDATOR_LOG_MAX_BYTES, STUDIO_VALIDATOR_LOG_MAX_LINES } from '../src/lib/studio/limits.ts'

const FETCH_TIMEOUT_MS = 30_000
const STORAGE_PREFIX = 'https://storage.googleapis.com/'
// Part of the V4 signature the app made for the report URL. Sending anything else in a
// signed header, or leaving one out, makes Cloud Storage refuse the PUT.
const REPORT_HEADERS = { 'content-type': 'application/json', 'x-goog-if-generation-match': '0' }

function isStorageUrl(value) {
  if (typeof value !== 'string' || !value.startsWith(STORAGE_PREFIX)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.host === 'storage.googleapis.com' && !url.username && !url.password
  } catch {
    return false
  }
}

/** A logger that writes `event key=number ...` lines and stops at the line and byte caps. */
export function cappedLog(write) {
  let lines = 0
  let bytes = 0
  return (event, fields = {}) => {
    const parts = [event, ...Object.entries(fields).map(([k, v]) => `${k}=${Number.isFinite(v) ? v : 'na'}`)]
    const line = parts.join(' ')
    const size = Buffer.byteLength(line) + 1
    if (lines + 1 > STUDIO_VALIDATOR_LOG_MAX_LINES || bytes + size > STUDIO_VALIDATOR_LOG_MAX_BYTES) return
    lines += 1
    bytes += size
    write(line)
  }
}

/** Reads a response body up to `max` bytes. Returns null when it is larger. */
async function readCapped(response, max, controller) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    controller.abort()
    return null
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      controller.abort()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Fetch with a deadline that covers the whole exchange, body included. */
async function withTimeout(fn) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fn(controller)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One execution. Returns the process exit code: 0 only when the report was stored,
 * 2 for a refused configuration or payload, 1 for every other failure.
 * deps: { env, fetch, runRuntimeValidation, log } so tests can supply fakes.
 */
export async function main({ env, fetch, runRuntimeValidation, log }) {
  const say = cappedLog(log)
  const validationId = env.VALIDATION_ID
  const payloadUrl = env.PAYLOAD_URL
  const reportUrl = env.REPORT_URL
  if (!isUuid(validationId) || !isStorageUrl(payloadUrl) || !isStorageUrl(reportUrl)) {
    say('config_refused')
    return 2
  }
  say('start')

  let bytes
  try {
    bytes = await withTimeout(async (controller) => {
      const response = await fetch(payloadUrl, { method: 'GET', redirect: 'error', signal: controller.signal })
      if (!response.ok) {
        say('payload_fetch_failed', { status: response.status })
        return undefined
      }
      return readCapped(response, PAYLOAD_MAX_BYTES, controller)
    })
  } catch {
    say('payload_fetch_failed')
    return 1
  }
  if (bytes === undefined) return 1
  if (bytes === null) {
    say('payload_refused_too_large')
    return 2
  }

  const parsed = parsePayload(bytes)
  if (!parsed.ok) {
    say(parsed.code === 'too_large' ? 'payload_refused_too_large' : 'payload_refused_invalid')
    return 2
  }
  if (parsed.payload.validationId !== validationId) {
    say('payload_refused_wrong_run')
    return 2
  }
  say('payload_read', { bytes: bytes.byteLength })

  let report
  try {
    const { manifest, studentBundle, professorBundle } = parsed.payload
    report = await runRuntimeValidation({ manifest, studentBundle, professorBundle })
  } catch {
    say('runner_failed')
    return 1
  }
  say('runner_done', { checks: Array.isArray(report?.checks) ? report.checks.length : 0 })

  const body = JSON.stringify(buildEnvelope(parsed.payload, parsed.payloadSha256, report))
  try {
    const status = await withTimeout(async (controller) => {
      const response = await fetch(reportUrl, { method: 'PUT', headers: { ...REPORT_HEADERS }, body, redirect: 'error', signal: controller.signal })
      await response.body?.cancel().catch(() => {})
      return response.status
    })
    if (status < 200 || status > 299) {
      say('report_rejected', { status })
      return 1
    }
  } catch {
    say('report_failed')
    return 1
  }
  say('report_stored', { bytes: Buffer.byteLength(body) })
  return 0
}

// Run only when executed directly (`node dist/cloud-entry.mjs`), never when imported.
const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (direct) {
  // An uncaught error's message could quote a URL or payload text: exit without it.
  process.on('uncaughtException', () => process.exit(1))
  process.on('unhandledRejection', () => process.exit(1))
  const code = await main({
    env: process.env,
    fetch: globalThis.fetch,
    runRuntimeValidation: async (artifact) => (await import('./runner.mjs')).runRuntimeValidation(artifact),
    log: (line) => process.stdout.write(`${line}\n`),
  }).catch(() => 1)
  process.exit(code)
}
