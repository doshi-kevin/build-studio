// Office → PDF normalization boundary. Named for the Live Classroom deck pipeline
// it was built for; it is now the app's ONLY office-conversion path — the citation
// preview / extraction pipeline routes through it too via
// document-parser/office-to-pdf.ts, so that LibreOffice no longer runs inside the
// app container (GitHub issue #182).
//
// The whole live-classroom render pipeline is PDF-based (pdfjs rasterization +
// parseDocument text extraction). PowerPoint has no faithful pure-JS renderer,
// so we convert it to PDF first via an isolated Gotenberg service on Cloud Run
// (industry standard; keeps LibreOffice out of the main app image). Once it's a
// PDF, the existing pipeline runs completely unchanged.
//
// Auth: the converter is deployed `--no-allow-unauthenticated`, so we attach a
// Google ID token fetched from the Cloud Run metadata server (audience = the
// converter URL). Locally, set GOTENBERG_SKIP_AUTH=true and run Gotenberg
// unauthenticated (`docker run -p 3000:3000 gotenberg/gotenberg:8`).
//
// Graceful degradation: when GOTENBERG_URL is unset, isPptxEnabled() is false —
// callers hide PPTX in the UI and reject stray PPTX requests with a clear
// message, while PDF uploads keep working untouched.
//
// SERVER-ONLY: imported only by route handlers / server actions. Reads no
// secrets, but speaks to internal infra — never import into a client tree.

import { logger } from '@/lib/logger'

const GOTENBERG_URL = (process.env.GOTENBERG_URL ?? '').replace(/\/+$/, '')
const SKIP_AUTH = process.env.GOTENBERG_SKIP_AUTH === 'true'

// LibreOffice conversion is slow on large decks; give it real headroom. The
// render route already runs on a 900s Cloud Run timeout, so this is safe.
const CONVERT_TIMEOUT_MS = 120_000
const TOKEN_TIMEOUT_MS = 5_000
const HEALTH_TIMEOUT_MS = 5_000

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'

/** True when PPTX support is configured (converter URL present). Callers use
 *  this to gate the UI and reject PPTX uploads when the converter isn't wired. */
export function isPptxEnabled(): boolean {
  return GOTENBERG_URL.length > 0
}

/** Typed conversion failure. Callers map this to a deck_failed('convert')
 *  broadcast + a clear professor-facing message. */
export class ConvertError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ConvertError'
    this.status = status
  }
}

// ── ID token (cached) ────────────────────────────────────────────────
// Metadata tokens are valid ~1h and the endpoint is rate-limited, so cache
// in-module and refresh ~10 min before expiry. Audience MUST be the full
// converter URL or Cloud Run rejects the call with 401.
let cachedToken: { token: string; expiresAt: number } | null = null

async function getIdentityToken(audience: string): Promise<string | null> {
  if (SKIP_AUTH) return null
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS)
  try {
    const res = await fetch(`${METADATA_TOKEN_URL}?audience=${encodeURIComponent(audience)}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: controller.signal,
    })
    if (!res.ok) {
      logger.warn('deckConverter.getIdentityToken: metadata non-200', { status: res.status })
      return null
    }
    const token = (await res.text()).trim()
    if (!token) return null
    cachedToken = { token, expiresAt: Date.now() + 50 * 60 * 1000 }
    return token
  } catch (err) {
    logger.warn('deckConverter.getIdentityToken: fetch failed', { err: String(err) })
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getIdentityToken(GOTENBERG_URL)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// ── Conversion ───────────────────────────────────────────────────────

/**
 * Convert an Office document buffer (pptx/ppt) to a PDF buffer via Gotenberg.
 * Throws ConvertError on misconfiguration, non-200, or timeout. The filename's
 * extension matters — Gotenberg/LibreOffice picks the import filter from it.
 *
 * `timeoutMs` defaults to the deck pipeline's ceiling. A caller on a shorter
 * request budget MUST pass its own, or the route dies before the converter
 * answers and the clean 422 becomes a raw 504. Current callers:
 *   · live-classroom render (900s route)          → default
 *   · chat / assistant upload (120s routes)       → 100s
 *   · citation preview + extraction (60s route)   → 45s
 *     (OFFICE_CONVERT_TIMEOUT_MS in document-parser/office-to-pdf.ts; that path
 *     goes through loadRenderablePdf, which has no per-call knob, so quiz
 *     visual generation shares the same 45s ceiling it had before.)
 */
export async function convertOfficeToPdf(
  buffer: Buffer,
  filename: string,
  opts: { timeoutMs?: number } = {},
): Promise<Buffer> {
  if (!isPptxEnabled()) {
    throw new ConvertError('PowerPoint conversion is not configured (GOTENBERG_URL unset)')
  }

  const start = Date.now()
  // Gotenberg requires the file field to be named exactly "files". Copy into a
  // fresh ArrayBuffer-backed view so the Blob part types cleanly (Node Buffer's
  // ArrayBufferLike doesn't satisfy the DOM BlobPart ArrayBufferView<ArrayBuffer>).
  const bytes = new Uint8Array(buffer.byteLength)
  bytes.set(buffer)
  const form = new FormData()
  form.append('files', new Blob([bytes]), filename)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CONVERT_TIMEOUT_MS)
  try {
    logger.info('deckConverter.convertOfficeToPdf: start', { filename, inBytes: buffer.length })
    const res = await fetch(`${GOTENBERG_URL}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      headers: await authHeaders(), // do NOT set Content-Type — fetch sets the multipart boundary
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      logger.error('deckConverter.convertOfficeToPdf: non-200', null, { status: res.status, detail })
      throw new ConvertError(`Converter responded ${res.status}`, res.status)
    }
    const out = Buffer.from(await res.arrayBuffer())
    logger.info('deckConverter.convertOfficeToPdf: done', {
      filename,
      inBytes: buffer.length,
      outBytes: out.length,
      ms: Date.now() - start,
    })
    return out
  } catch (err) {
    if (err instanceof ConvertError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    const aborted = msg.toLowerCase().includes('abort')
    logger.error('deckConverter.convertOfficeToPdf: failed', err, { filename, aborted })
    throw new ConvertError(aborted ? 'Conversion timed out' : `Conversion failed: ${msg}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Normalization boundary: return a PDF buffer for any supported deck source.
 * PDFs pass through untouched; PPT/PPTX are converted via Gotenberg. This is
 * the single seam the render route calls — everything downstream is PDF.
 */
export async function ensurePdf(buffer: Buffer, ext: string, filename = `deck.${ext}`): Promise<Buffer> {
  if (ext === 'pdf') return buffer
  if (ext === 'pptx' || ext === 'ppt') return convertOfficeToPdf(buffer, filename)
  throw new ConvertError(`Unsupported deck source extension: ${ext}`)
}

// ── Health ───────────────────────────────────────────────────────────

export interface ConverterHealth {
  enabled: boolean
  ok: boolean
  status: number
  ms: number
}

/** Ping the converter's /health endpoint. Used by the diagnostic route so the
 *  team can confirm "is the converter alive?" without the GCP console. */
export async function checkConverterHealth(): Promise<ConverterHealth> {
  if (!isPptxEnabled()) return { enabled: false, ok: false, status: 0, ms: 0 }
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const res = await fetch(`${GOTENBERG_URL}/health`, {
      headers: await authHeaders(),
      signal: controller.signal,
    })
    return { enabled: true, ok: res.ok, status: res.status, ms: Date.now() - start }
  } catch {
    return { enabled: true, ok: false, status: 0, ms: Date.now() - start }
  } finally {
    clearTimeout(timer)
  }
}
