// Tests for the Live Classroom PPT→PDF normalization boundary
// (src/lib/live-classroom/deck-converter.ts) and the upload schema's new
// `extension` field. The module reads GOTENBERG_URL at import time, so each
// case loads it fresh with vi.resetModules() after setting env.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDeckUploadUrlSchema } from '@/lib/validations/live-classroom'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const ENDPOINT = 'http://converter.test'
const originalFetch = global.fetch

async function loadModule(env: { url?: string }) {
  vi.resetModules()
  if (env.url === undefined) delete process.env.GOTENBERG_URL
  else process.env.GOTENBERG_URL = env.url
  process.env.GOTENBERG_SKIP_AUTH = 'true' // no metadata server in tests
  return import('@/lib/live-classroom/deck-converter')
}

afterEach(() => {
  global.fetch = originalFetch
  delete process.env.GOTENBERG_URL
  delete process.env.GOTENBERG_SKIP_AUTH
})

describe('deck-converter', () => {
  it('isPptxEnabled reflects GOTENBERG_URL presence', async () => {
    expect((await loadModule({ url: ENDPOINT })).isPptxEnabled()).toBe(true)
    expect((await loadModule({ url: '' })).isPptxEnabled()).toBe(false)
  })

  it('ensurePdf passes a PDF through untouched (no converter call)', async () => {
    const mod = await loadModule({ url: ENDPOINT })
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch
    const buf = Buffer.from('%PDF-1.4 fake')
    const out = await mod.ensurePdf(buf, 'pdf')
    expect(out).toBe(buf)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('converts PPTX via /forms/libreoffice/convert and returns the PDF bytes', async () => {
    const mod = await loadModule({ url: ENDPOINT })
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF
    const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${ENDPOINT}/forms/libreoffice/convert`)
      expect(init.method).toBe('POST')
      expect(init.body).toBeInstanceOf(FormData)
      // Gotenberg requires the field to be named exactly "files".
      expect((init.body as FormData).get('files')).toBeTruthy()
      // SKIP_AUTH → no Authorization header.
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
      return { ok: true, arrayBuffer: async () => pdfBytes.buffer } as Response
    })
    global.fetch = fetchSpy as unknown as typeof fetch

    const out = await mod.ensurePdf(Buffer.from('pptx-bytes'), 'pptx', 'source.pptx')
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(Buffer.from(out).subarray(0, 4).toString()).toBe('%PDF')
  })

  it('throws ConvertError with status on a non-200 response', async () => {
    const mod = await loadModule({ url: ENDPOINT })
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'libreoffice exploded',
    })) as unknown as typeof fetch
    await expect(mod.convertOfficeToPdf(Buffer.from('x'), 'a.pptx')).rejects.toMatchObject({
      name: 'ConvertError',
      status: 500,
    })
  })

  it('throws ConvertError on a network/timeout failure', async () => {
    const mod = await loadModule({ url: ENDPOINT })
    global.fetch = vi.fn(async () => {
      throw new Error('The operation was aborted')
    }) as unknown as typeof fetch
    await expect(mod.convertOfficeToPdf(Buffer.from('x'), 'a.pptx')).rejects.toBeInstanceOf(
      mod.ConvertError,
    )
  })

  it('ensurePdf rejects unsupported extensions', async () => {
    const mod = await loadModule({ url: ENDPOINT })
    await expect(mod.ensurePdf(Buffer.from('x'), 'docx')).rejects.toBeInstanceOf(mod.ConvertError)
  })

  it('convertOfficeToPdf throws when the converter is not configured', async () => {
    const mod = await loadModule({ url: '' })
    await expect(mod.convertOfficeToPdf(Buffer.from('x'), 'a.pptx')).rejects.toBeInstanceOf(
      mod.ConvertError,
    )
  })

  it('checkConverterHealth reports disabled when unconfigured', async () => {
    const mod = await loadModule({ url: '' })
    expect(await mod.checkConverterHealth()).toEqual({
      enabled: false,
      ok: false,
      status: 0,
      ms: 0,
    })
  })
})

describe('createDeckUploadUrlSchema.extension', () => {
  const roomId = '11111111-1111-4111-8111-111111111111'

  it('defaults to pdf', () => {
    expect(createDeckUploadUrlSchema.parse({ roomId }).extension).toBe('pdf')
  })

  it('accepts pptx and ppt', () => {
    expect(createDeckUploadUrlSchema.parse({ roomId, extension: 'pptx' }).extension).toBe('pptx')
    expect(createDeckUploadUrlSchema.parse({ roomId, extension: 'ppt' }).extension).toBe('ppt')
  })

  it('rejects unsupported extensions', () => {
    expect(createDeckUploadUrlSchema.safeParse({ roomId, extension: 'docx' }).success).toBe(false)
  })
})
