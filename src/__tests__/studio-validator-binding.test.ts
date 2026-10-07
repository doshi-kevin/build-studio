// @vitest-environment node
// The runner's payload and envelope contract (validator-runtime/binding.mjs). The server
// compares payloadSha256 with the hash it recorded over the bytes it uploaded, so the
// runner must hash the exact bytes it received, never a re-serialization.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildEnvelope, PAYLOAD_MAX_BYTES, parsePayload, RUNTIME_VERSION } from '../../validator-runtime/binding.mjs'
import { RUNTIMES } from '../../validator-runtime/runner.mjs'
import { BRIDGE_VERSIONS } from '@/lib/studio/runtime/protocol'

const VALID = {
  format: 'studio-validator-payload-v1',
  validationId: '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
  nonce: 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5',
  manifest: { name: 'Quiz' },
  studentBundle: 'console.log(1)',
  professorBundle: 'console.log(2)',
}
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

describe('parsePayload', () => {
  it('accepts a valid payload and hashes the exact bytes received', () => {
    const compact = JSON.stringify(VALID)
    const spaced = JSON.stringify(VALID, null, 2)
    const a = parsePayload(compact)
    const b = parsePayload(Buffer.from(spaced, 'utf8'))
    expect(a).toEqual({ ok: true, payload: VALID, payloadSha256: sha(compact) })
    expect(b.ok && b.payloadSha256).toBe(sha(spaced))
    expect(sha(compact)).not.toBe(sha(spaced))
  })

  it('accepts a Uint8Array view without reading outside it', () => {
    const bytes = Buffer.from(`xx${JSON.stringify(VALID)}yy`, 'utf8')
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 2, bytes.byteLength - 4)
    const parsed = parsePayload(view)
    expect(parsed.ok && parsed.payloadSha256).toBe(sha(JSON.stringify(VALID)))
  })

  it('refuses a payload over 2 MiB as too_large', () => {
    const big = JSON.stringify({ ...VALID, studentBundle: 'x'.repeat(PAYLOAD_MAX_BYTES) })
    expect(parsePayload(big)).toEqual({ ok: false, code: 'too_large' })
  })

  it.each([
    ['wrong format', { ...VALID, format: 'studio-validator-payload-v2' }],
    ['bad uuid', { ...VALID, validationId: 'not-a-uuid' }],
    ['short nonce', { ...VALID, nonce: 'abc' }],
    ['nonce with padding', { ...VALID, nonce: `${VALID.nonce}=` }],
    ['non-string student bundle', { ...VALID, studentBundle: 42 }],
    ['non-string professor bundle', { ...VALID, professorBundle: null }],
    ['array manifest', { ...VALID, manifest: [] }],
  ])('refuses %s as invalid', (_label, payload) => {
    expect(parsePayload(JSON.stringify(payload))).toEqual({ ok: false, code: 'invalid' })
  })

  it('refuses bytes that are not JSON or not UTF-8', () => {
    expect(parsePayload('{"format":')).toEqual({ ok: false, code: 'invalid' })
    expect(parsePayload(Buffer.from([0xff, 0xfe, 0x7b, 0x7d]))).toEqual({ ok: false, code: 'invalid' })
    expect(parsePayload('[]')).toEqual({ ok: false, code: 'invalid' })
  })
})

describe('buildEnvelope', () => {
  it('binds the report to the run, the nonce, the payload hash and the runtime version', () => {
    const report = { runner: { name: 'r', version: '1' }, browser: 'chromium', checks: [] }
    expect(buildEnvelope(VALID, 'ab'.repeat(32), report)).toEqual({
      binding: { validationId: VALID.validationId, nonce: VALID.nonce, payloadSha256: 'ab'.repeat(32), runtimeVersion: 'v1' },
      report,
    })
    expect(RUNTIME_VERSION).toBe('v1')
  })
})

describe('the runner’s bridge versions', () => {
  it('are exactly the bridge versions a manifest may name, so no version goes unserved', () => {
    expect(RUNTIMES).toEqual([...BRIDGE_VERSIONS])
  })
})
