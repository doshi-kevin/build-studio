// @vitest-environment node
// The container entry (validator-runtime/cloud-entry.mjs) against a fake Cloud Storage:
// it refuses anything but signed storage URLs and its own run, PUTs the envelope once
// with exactly the signed headers, fails the execution on 412 or any other refusal, and
// never logs a URL, the payload or the report.
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { cappedLog, main } from '../../validator-runtime/cloud-entry.mjs'
import { PAYLOAD_MAX_BYTES } from '../../validator-runtime/binding.mjs'
import { STUDIO_VALIDATOR_LOG_MAX_BYTES, STUDIO_VALIDATOR_LOG_MAX_LINES } from '@/lib/studio/limits'

const ID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const PAYLOAD_URL = 'https://storage.googleapis.com/proj-studio-validator/runs/x/payload.json?X-Goog-Signature=payloadsig'
const REPORT_URL = 'https://storage.googleapis.com/proj-studio-validator/runs/x/report.json?X-Goog-Signature=reportsig'
const ENV = { VALIDATION_ID: ID, PAYLOAD_URL, REPORT_URL }
const PAYLOAD = {
  format: 'studio-validator-payload-v1',
  validationId: ID,
  nonce: 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5',
  manifest: { name: 'SECRET-MANIFEST-NAME' },
  studentBundle: 'SECRET-STUDENT-CODE',
  professorBundle: 'SECRET-PROFESSOR-CODE',
}
const REPORT = { runner: { name: 'scholera-local-runner', version: '1.0.0' }, browser: 'chromium 1', checks: [{ id: 'runtime.boot', view: 'student', status: 'passed', findings: [{ detail: 'SECRET-FINDING' }] }] }

interface Call { url: string; init: RequestInit }

function setup(opts: { payload?: string | Uint8Array; putStatus?: number; env?: Record<string, string | undefined>; getStatus?: number } = {}) {
  const body = opts.payload ?? JSON.stringify(PAYLOAD)
  const calls: Call[] = []
  const lines: string[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    if ((init.method ?? 'GET') === 'GET') return new Response(body as BodyInit, { status: opts.getStatus ?? 200 })
    return new Response('', { status: opts.putStatus ?? 200 })
  })
  const runRuntimeValidation = vi.fn(async () => REPORT)
  const run = () => main({ env: opts.env ?? ENV, fetch, runRuntimeValidation, log: (line: string) => lines.push(line) })
  return { run, calls, lines, runRuntimeValidation, puts: () => calls.filter((c) => c.init.method === 'PUT') }
}

function expectCleanLogs(lines: string[]) {
  const all = lines.join('\n')
  for (const secret of ['storage.googleapis.com', 'payloadsig', 'reportsig', 'SECRET-', PAYLOAD.nonce, ID]) {
    expect(all).not.toContain(secret)
  }
}

describe('cloud-entry main', () => {
  it.each([
    ['a missing report URL', { VALIDATION_ID: ID, PAYLOAD_URL }],
    ['a missing validation id', { PAYLOAD_URL, REPORT_URL }],
    ['a validation id that is not a uuid', { ...ENV, VALIDATION_ID: 'run-1' }],
    ['a non-storage payload URL', { ...ENV, PAYLOAD_URL: 'https://evil.example/payload.json' }],
    ['a plain-http storage URL', { ...ENV, REPORT_URL: 'http://storage.googleapis.com/b/report.json' }],
    ['a look-alike storage host', { ...ENV, REPORT_URL: 'https://storage.googleapis.com.evil.example/r' }],
    ['credentials in the URL', { ...ENV, PAYLOAD_URL: 'https://u:p@storage.googleapis.com/p' }],
  ])('refuses to start with %s, and fetches nothing', async (_label, env) => {
    const t = setup({ env })
    expect(await t.run()).toBe(2)
    expect(t.calls).toHaveLength(0)
    expectCleanLogs(t.lines)
  })

  it('refuses a payload for another run, with no PUT', async () => {
    const t = setup({ payload: JSON.stringify({ ...PAYLOAD, validationId: '00000000-0000-4000-8000-000000000000' }) })
    expect(await t.run()).toBe(2)
    expect(t.runRuntimeValidation).not.toHaveBeenCalled()
    expect(t.puts()).toHaveLength(0)
  })

  it('refuses an invalid payload, with no PUT', async () => {
    const t = setup({ payload: JSON.stringify({ ...PAYLOAD, format: 'other' }) })
    expect(await t.run()).toBe(2)
    expect(t.puts()).toHaveLength(0)
  })

  it('aborts a payload over 2 MiB with exit 2 and no PUT', async () => {
    const t = setup({ payload: new Uint8Array(PAYLOAD_MAX_BYTES + 1).fill(0x20) })
    expect(await t.run()).toBe(2)
    expect(t.runRuntimeValidation).not.toHaveBeenCalled()
    expect(t.puts()).toHaveLength(0)
    expect(t.lines).toContain('payload_refused_too_large')
  })

  it('fails when the payload GET is refused', async () => {
    const t = setup({ getStatus: 403 })
    expect(await t.run()).toBe(1)
    expect(t.puts()).toHaveLength(0)
  })

  it('runs the payload and PUTs the bound envelope with exactly the two signed headers', async () => {
    const raw = JSON.stringify(PAYLOAD)
    const t = setup({ payload: raw })
    expect(await t.run()).toBe(0)
    expect(t.runRuntimeValidation).toHaveBeenCalledWith({ manifest: PAYLOAD.manifest, studentBundle: PAYLOAD.studentBundle, professorBundle: PAYLOAD.professorBundle })
    expect(t.calls[0].url).toBe(PAYLOAD_URL)
    const puts = t.puts()
    expect(puts).toHaveLength(1)
    expect(puts[0].url).toBe(REPORT_URL)
    expect(puts[0].init.headers).toEqual({ 'content-type': 'application/json', 'x-goog-if-generation-match': '0' })
    expect(JSON.parse(String(puts[0].init.body))).toEqual({
      binding: { validationId: ID, nonce: PAYLOAD.nonce, payloadSha256: createHash('sha256').update(raw).digest('hex'), runtimeVersion: 'v1' },
      report: REPORT,
    })
    expectCleanLogs(t.lines)
  })

  it.each([412, 403, 500])('exits 1 when the report PUT returns %i', async (status) => {
    const t = setup({ putStatus: status })
    expect(await t.run()).toBe(1)
    expect(t.lines).toContain(`report_rejected status=${status}`)
    expectCleanLogs(t.lines)
  })

  it('exits 1 when the runner throws or the PUT fails on the network', async () => {
    const t = setup()
    t.runRuntimeValidation.mockRejectedValueOnce(new Error(`boom ${PAYLOAD_URL}`))
    expect(await t.run()).toBe(1)
    expect(t.puts()).toHaveLength(0)
    expectCleanLogs(t.lines)

    const lines: string[] = []
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (init.method === 'PUT') throw new TypeError(`fetch failed ${url}`)
      return new Response(JSON.stringify(PAYLOAD))
    })
    expect(await main({ env: ENV, fetch, runRuntimeValidation: async () => REPORT, log: (l: string) => lines.push(l) })).toBe(1)
    expectCleanLogs(lines)
  })

  it('keeps logging within the line and byte caps', () => {
    const lines: string[] = []
    const say = cappedLog((l: string) => lines.push(l))
    for (let i = 0; i < 1000; i++) say('event', { i })
    expect(lines).toHaveLength(STUDIO_VALIDATOR_LOG_MAX_LINES)

    const wide: string[] = []
    const sayWide = cappedLog((l: string) => wide.push(l))
    for (let i = 0; i < 150; i++) sayWide('x'.repeat(1000))
    const bytes = wide.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
    expect(bytes).toBeLessThanOrEqual(STUDIO_VALIDATOR_LOG_MAX_BYTES)
    expect(wide.length).toBe(Math.floor(STUDIO_VALIDATOR_LOG_MAX_BYTES / 1001))
  })

  it('logs only numbers as field values', () => {
    const lines: string[] = []
    cappedLog((l: string) => lines.push(l))('event', { status: PAYLOAD_URL as unknown as number })
    expect(lines).toEqual(['event status=na'])
  })
})
