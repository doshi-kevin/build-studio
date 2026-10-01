// @vitest-environment node
//
// Which reader a real .docx goes to, and why it matters that the answer changed.
//
// A .docx is a zip, so it used to fall straight through to the pure-JS reader
// (extractDocx). That reader cannot paginate and reports pageCount 1, so every
// concept it extracts cites page 1. Self-consistent, until OFFICE_EXTS in
// asset-crop gained 'docx' — from then on the material viewer and the vector
// index converted the SAME file and got REAL page numbers, and the reference
// rail showed a concept on page 1 and on page 14 at once.
//
// So the route now converts first. The fallback is the load-bearing half: if the
// converter is unavailable, the document must still be READ (page-1 anchors beat
// no text, no topics and no vectors), which is why this branch does not mirror
// the legacy .doc branch that fails hard.
//
// Pinned here because both halves are invisible to a typecheck and to a happy-path
// e2e run: with the converter up, the fallback never executes; with it down, the
// wrong route still "works" and just quietly mislabels every page.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockConvert = vi.fn()
const mockExtractPdf = vi.fn()
const mockExtractDocx = vi.fn()

vi.mock('@/lib/document-parser/office-to-pdf', () => ({
  convertOfficeToPdf: (...a: unknown[]) => mockConvert(...a),
  OFFICE_CONVERT_TIMEOUT_MS: 45_000,
}))
vi.mock('@/lib/document-parser/pdf', () => ({
  extractPdf: (...a: unknown[]) => mockExtractPdf(...a),
}))
vi.mock('@/lib/document-parser/docx', () => ({
  extractDocx: (...a: unknown[]) => mockExtractDocx(...a),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// A minimal buffer that passes the zip sniff: every OOXML file starts with PK\x03\x04.
const zipDocx = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)])
// A .doc (WW8 binary) is NOT a zip.
const legacyDoc = () => Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

const OPTS = { fileType: 'docx' as const, sectionId: 'sec-1', moduleItemId: 'item-1' }

beforeEach(() => {
  mockConvert.mockClear()
  mockExtractPdf.mockClear()
  mockExtractDocx.mockClear()
  mockExtractPdf.mockResolvedValue({ status: 'completed', metadata: { pageCount: 14 } })
  mockExtractDocx.mockResolvedValue({ status: 'completed', metadata: { pageCount: 1 } })
})

describe('extractDocument — the .docx route', () => {
  it('converts a real .docx and reads it as a PDF, so its pages are real', async () => {
    mockConvert.mockResolvedValue(Buffer.from('%PDF-1.4 converted'))
    const { extractDocument } = await import('@/lib/document-parser/index-v2')

    const res = await extractDocument(zipDocx(), OPTS)

    expect(mockConvert).toHaveBeenCalledTimes(1)
    expect(mockExtractPdf).toHaveBeenCalledTimes(1)
    // The whole point: NOT the pure-JS reader, which would report pageCount 1.
    expect(mockExtractDocx).not.toHaveBeenCalled()
    expect(res.metadata?.pageCount).toBe(14)
  })

  it('falls back to the text reader when the converter is unavailable', async () => {
    // convertOfficeToPdf returns null (not throws) when GOTENBERG_URL is unset
    // or the conversion fails.
    mockConvert.mockResolvedValue(null)
    const { extractDocument } = await import('@/lib/document-parser/index-v2')

    const res = await extractDocument(zipDocx(), OPTS)

    expect(mockConvert).toHaveBeenCalledTimes(1)
    expect(mockExtractDocx).toHaveBeenCalledTimes(1)
    // Degraded, not failed: the material still gets text, topics and vectors.
    expect(res.status).toBe('completed')
    expect(mockExtractPdf).not.toHaveBeenCalled()
  })

  it('still routes a legacy .doc through conversion, and still fails hard without it', async () => {
    // The pre-existing branch: a .doc is not a zip, the OOXML readers cannot open
    // it at all, so there is nothing to fall back TO.
    mockConvert.mockResolvedValue(null)
    const { extractDocument } = await import('@/lib/document-parser/index-v2')

    const res = await extractDocument(legacyDoc(), { ...OPTS, fileType: 'doc' })

    expect(res.status).toBe('failed')
    expect(mockExtractDocx).not.toHaveBeenCalled()
  })
})
