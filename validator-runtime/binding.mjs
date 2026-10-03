// The payload a Stage 2 runner receives and the envelope it returns, shared by the local
// entry (cli.mjs) and the container entry (cloud-entry.mjs).
//
// The binding ties a report to one run and one exact payload: the server compares
// validationId with the run, the nonce's hash with the run's callback hash, and
// payloadSha256 with the hash it recorded when it built the payload. The hash is over
// the bytes as received, never a re-serialization, so any change to them is caught.
import { createHash } from 'node:crypto'

export const PAYLOAD_FORMAT = 'studio-validator-payload-v1'
export const PAYLOAD_MAX_BYTES = 2 * 1024 * 1024
export const RUNTIME_VERSION = 'v1'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NONCE_RE = /^[A-Za-z0-9_-]{20,200}$/

export const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value)

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Parses payload bytes. Returns { ok: true, payload, payloadSha256 } or
 * { ok: false, code: 'too_large' | 'invalid' }. Never throws.
 */
export function parsePayload(bytes) {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.byteLength > PAYLOAD_MAX_BYTES) return { ok: false, code: 'too_large' }
  let data
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf))
  } catch {
    return { ok: false, code: 'invalid' }
  }
  if (
    !isPlainObject(data) ||
    data.format !== PAYLOAD_FORMAT ||
    !isUuid(data.validationId) ||
    typeof data.nonce !== 'string' ||
    !NONCE_RE.test(data.nonce) ||
    !isPlainObject(data.manifest) ||
    typeof data.studentBundle !== 'string' ||
    typeof data.professorBundle !== 'string'
  ) {
    return { ok: false, code: 'invalid' }
  }
  const payload = {
    format: data.format,
    validationId: data.validationId,
    nonce: data.nonce,
    manifest: data.manifest,
    studentBundle: data.studentBundle,
    professorBundle: data.professorBundle,
  }
  return { ok: true, payload, payloadSha256: createHash('sha256').update(buf).digest('hex') }
}

/** The runner's whole output: the binding plus the report exactly as the runner made it. */
export function buildEnvelope(payload, payloadSha256, report) {
  return {
    binding: { validationId: payload.validationId, nonce: payload.nonce, payloadSha256, runtimeVersion: RUNTIME_VERSION },
    report,
  }
}
