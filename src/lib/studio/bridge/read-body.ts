/**
 * Reads a request body with a hard byte cap, enforced while the stream is read.
 *
 * Content-Length is only a hint: it can be missing (chunked encoding) or simply wrong.
 * So a declared length over the cap is refused straight away, and every body is also
 * counted as it arrives and abandoned the moment it passes the cap. Nothing is parsed
 * until the whole body is known to fit.
 */
export type BodyResult = { ok: true; text: string } | { ok: false; reason: 'too-large' | 'unreadable' }

export async function readBodyCapped(request: Request, maxBytes: number): Promise<BodyResult> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { ok: false, reason: 'unreadable' }
    if (Number(declared) > maxBytes) return { ok: false, reason: 'too-large' }
  }
  if (!request.body) return { ok: true, text: '' }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return { ok: false, reason: 'too-large' }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}
