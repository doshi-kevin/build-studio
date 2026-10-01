// Tests for the document-parser office→PDF adapter
// (src/lib/document-parser/office-to-pdf.ts) after issue #182 moved conversion
// out of this process and into the isolated Gotenberg service.
//
// What matters here, and why each case exists:
//   - the conversion goes to the SERVICE, and this process never spawns anything
//     (the whole point of #182 — a crafted deck must not run inside the app),
//   - it passes a timeout SHORTER than the converter client's 120s default,
//     because the citation-preview route dies at 60s,
//   - the source extension reaches the service, since LibreOffice picks its
//     import filter from the filename and a wrong one silently mis-parses,
//   - every failure path returns NULL rather than throwing — callers degrade to
//     "couldn't render" and an upload must never crash on a bad file.
//
// The module reads GOTENBERG_URL at import time (via deck-converter), so each
// case loads it fresh with vi.resetModules() after setting env.

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const ENDPOINT = 'http://converter.test'
const originalFetch = global.fetch

async function loadModule(url?: string) {
  vi.resetModules()
  if (url === undefined) delete process.env.GOTENBERG_URL
  else process.env.GOTENBERG_URL = url
  process.env.GOTENBERG_SKIP_AUTH = 'true' // no metadata server in tests
  return import('@/lib/document-parser/office-to-pdf')
}

afterEach(() => {
  global.fetch = originalFetch
  delete process.env.GOTENBERG_URL
  delete process.env.GOTENBERG_SKIP_AUTH
})

describe('convertOfficeToPdf (document-parser adapter)', () => {
  it('converts via the isolated service and returns the PDF bytes', async () => {
    const mod = await loadModule(ENDPOINT)
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF
    const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${ENDPOINT}/forms/libreoffice/convert`)
      expect(init.method).toBe('POST')
      // The extension must survive — LibreOffice picks its import filter from it.
      const file = (init.body as FormData).get('files') as File
      expect(file.name).toBe('input.pptx')
      return { ok: true, arrayBuffer: async () => pdfBytes.buffer } as Response
    })
    global.fetch = fetchSpy as unknown as typeof fetch

    const out = await mod.convertOfficeToPdf(Buffer.from('deck'), 'pptx')

    expect(out).toBeInstanceOf(Buffer)
    expect(out!.subarray(0, 4).toString()).toBe('%PDF')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('aborts an ordinary call at its own 45s ceiling, not the client default', async () => {
    const mod = await loadModule(ENDPOINT)
    expect(mod.OFFICE_CONVERT_TIMEOUT_MS).toBeLessThan(60_000)

    // Asserting the exported constant is not enough: what matters is that the
    // constant is the deadline a DEFAULT call actually runs under. If the adapter
    // stopped forwarding it, the converter client's own 120s default would apply
    // and the citation-preview route would die at 60s with nothing to show. So
    // drive the clock and watch where the abort lands.
    global.fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          ;(init.signal as AbortSignal).addEventListener('abort', () =>
            reject(new Error('The operation was aborted')),
          )
        }),
    ) as unknown as typeof fetch

    vi.useFakeTimers()
    try {
      let settled = false
      const call = mod.convertOfficeToPdf(Buffer.from('deck'), 'pptx').then((v) => {
        settled = true
        return v
      })

      await vi.advanceTimersByTimeAsync(44_000)
      expect(settled).toBe(false) // still in flight just under the ceiling

      await vi.advanceTimersByTimeAsync(2_000) // t=46s: past 45s, far short of 120s
      expect(settled).toBe(true)
      expect(await call).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('honours a caller-supplied timeout', async () => {
    const mod = await loadModule(ENDPOINT)
    global.fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Never settles on its own — only the adapter's abort ends it.
          ;(init.signal as AbortSignal).addEventListener('abort', () =>
            reject(new Error('The operation was aborted')),
          )
        }),
    ) as unknown as typeof fetch

    const out = await mod.convertOfficeToPdf(Buffer.from('deck'), 'pptx', 5)

    expect(out).toBeNull()
  })

  it('returns null when the converter is not configured', async () => {
    const mod = await loadModule('') // GOTENBERG_URL unset
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch

    expect(await mod.convertOfficeToPdf(Buffer.from('deck'), 'pptx')).toBeNull()
    // No converter, no call — and crucially no local fallback either.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns null (never throws) when the service rejects the file', async () => {
    const mod = await loadModule(ENDPOINT)
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'malformed document',
    })) as unknown as typeof fetch

    await expect(mod.convertOfficeToPdf(Buffer.from('junk'), 'pptx')).resolves.toBeNull()
  })

  it('rejects a 200 body that is not a PDF', async () => {
    const mod = await loadModule(ENDPOINT)
    // Gotenberg signals failure with a non-200, so this is something in between
    // answering — a proxy error page, or a truncated body. It matters because the
    // caller CACHES whatever comes back as `<path>.pdf` with upsert: accepting it
    // would make those bytes the permanent derived PDF for that file, breaking
    // every later preview until the object is deleted by hand.
    global.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('<html>502 Bad Gateway</html>').buffer,
    })) as unknown as typeof fetch

    await expect(mod.convertOfficeToPdf(Buffer.from('deck'), 'pptx')).resolves.toBeNull()
  })

  it('sanitises the extension into the filename it sends', async () => {
    const mod = await loadModule(ENDPOINT)
    let name = ''
    global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      name = ((init.body as FormData).get('files') as File).name
      return { ok: true, arrayBuffer: async () => new Uint8Array([0x25]).buffer } as Response
    }) as unknown as typeof fetch

    // A path-traversal-shaped ext must not become part of the sent filename.
    await mod.convertOfficeToPdf(Buffer.from('deck'), '../../etc/passwd')

    expect(name).toBe('input.etcpasswd')
  })
})
