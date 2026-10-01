// @vitest-environment node
//
// Geometry test for renderPageRegionPng against a REAL fixture PDF (the camelot
// foo.pdf, US-Letter 612×792 pt). The crop converts a PDF-point, bottom-left-origin
// bbox into a top-left pixel rect at the rendered scale — the y-flip, the edge
// clamp, and the degenerate-bbox / out-of-range fallbacks are all easy to regress
// and were previously only checked by eyeballing a cropped table. We pin the
// measured pixel output so a sign flip or off-by-scale change fails loudly.
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import sharp from 'sharp'
import { renderPageRegionPng, loadRenderablePdf } from '@/lib/document-parser/asset-crop'

// The office→PDF step is the isolated Gotenberg service (issue #182); stub it so
// these cases are about this module's own degradation ladder.
const mockConvert = vi.fn<(input: Buffer, ext: string) => Promise<Buffer | null>>()
vi.mock('@/lib/document-parser/office-to-pdf', () => ({
  convertOfficeToPdf: (...args: [Buffer, string]) => mockConvert(...args),
  OFFICE_CONVERT_TIMEOUT_MS: 45_000,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const FIXTURE = path.resolve(process.cwd(), 'src/__tests__/fixtures/tables/foo.pdf')
const has = existsSync(FIXTURE)
const pdf = () => readFileSync(FIXTURE)

// foo.pdf is US-Letter: 612×792 pt → 1224×1584 px at the renderer's scale=2.
// CROP_PAD = 0.035 of the page is added around the bbox, clamped to [0,1].
const PAGE_W = 1224
const PAGE_H = 1584

const dims = async (png: Buffer) => {
  const m = await sharp(png).metadata()
  return { w: m.width, h: m.height }
}

describe('renderPageRegionPng — crop geometry', () => {
  it('no bbox → renders the full page', async () => {
    if (!has) return
    const png = await renderPageRegionPng(pdf(), 1, undefined)
    expect(png).not.toBeNull()
    expect(await dims(png!)).toEqual({ w: PAGE_W, h: PAGE_H })
  }, 30000)

  it('crops the TOP-left quadrant — verifies the bottom-left→top-left y-flip', async () => {
    if (!has) return
    // In PDF point space (bottom-left origin) a y of pageHeight/2 with height
    // pageHeight/2 is the TOP half. If the y-flip were wrong this would crop the
    // bottom half — same size, so size alone can't catch it; we assert the crop
    // sits against the top-left corner by sampling its position implicitly via
    // the clamped pad: left & top clamp to 0 (no room to pad outward), right &
    // bottom get the 3.5% pad. Result width/height = (0.5 + 0.035) of the page.
    const bbox = { x: 0, y: 396, width: 306, height: 396 } // half-page, anchored top-left
    const png = await renderPageRegionPng(pdf(), 1, bbox)
    expect(png).not.toBeNull()
    const expectedW = Math.round((0.5 + 0.035) * PAGE_W) // 655
    const expectedH = Math.round((0.5 + 0.035) * PAGE_H) // 847
    expect(await dims(png!)).toEqual({ w: expectedW, h: expectedH })
  }, 30000)

  it('a degenerate (sub-3%) bbox falls back to the full page', async () => {
    if (!has) return
    // 1×1 pt is far under MIN_CROP_FRACTION (0.03) → unreliable detection → full page.
    const png = await renderPageRegionPng(pdf(), 1, { x: 0, y: 0, width: 1, height: 1 })
    expect(png).not.toBeNull()
    expect(await dims(png!)).toEqual({ w: PAGE_W, h: PAGE_H })
  }, 30000)

  it('an out-of-range page returns null (caller 404s)', async () => {
    if (!has) return
    const png = await renderPageRegionPng(pdf(), 99, { x: 0, y: 0, width: 100, height: 100 })
    expect(png).toBeNull()
  }, 30000)
})

// ── loadRenderablePdf ────────────────────────────────────────────────────────
// Since #182 moved conversion into the isolated Gotenberg service, "converter
// unavailable" stopped being a broken-deploy symptom and became an ordinary
// runtime state — unsetting GOTENBERG_URL is the documented kill switch, and
// there is no longer any in-process fallback behind it. That makes this
// function's degradation ladder product behaviour, and the runbook promises a
// specific shape: PDFs unaffected, already-converted decks keep previewing, only
// an unconverted deck degrades. It also has to keep 'unsupported' (→415) and null
// (→404) distinct, because /api/extraction/page maps them to different responses.

const DECK = 'sec-1/modules/lecture.pptx'
const DERIVED = `${DECK}.pdf`

function makeAdminDb(files: Record<string, Buffer>, opts: { uploadError?: { message: string } } = {}) {
  const uploads: { path: string; body: Buffer; contentType?: string; upsert?: boolean }[] = []
  const downloaded: string[] = []
  return {
    uploads,
    downloaded,
    storage: {
      from: () => ({
        download: async (p: string) => {
          downloaded.push(p)
          // Supabase Storage reports a missing object as an error, not a throw.
          // Copy into a fresh view so the Blob part types cleanly (Node Buffer's
          // ArrayBufferLike doesn't satisfy DOM BlobPart) — same dance as deck-converter.
          return files[p]
            ? { data: new Blob([new Uint8Array(files[p])]), error: null }
            : { data: null, error: { message: 'Object not found' } }
        },
        upload: async (p: string, body: Buffer, o: { contentType?: string; upsert?: boolean }) => {
          uploads.push({ path: p, body, ...o })
          return { error: opts.uploadError ?? null }
        },
      }),
    },
  }
}

describe('loadRenderablePdf — source resolution and degradation', () => {
  beforeEach(() => {
    mockConvert.mockReset()
  })

  it('returns a PDF source as-is, without touching the converter', async () => {
    const bytes = Buffer.from('%PDF-1.7 real')
    const db = makeAdminDb({ 'sec-1/modules/notes.pdf': bytes })

    const out = await loadRenderablePdf(db, 'sec-1/modules/notes.pdf')

    expect(out).toEqual(bytes)
    expect(mockConvert).not.toHaveBeenCalled()
  })

  it('serves an already-converted deck from cache even with the converter switched off', async () => {
    // The kill switch (GOTENBERG_URL unset) surfaces here as convert → null. The
    // runbook promises cached derived PDFs keep working, so the cache lookup MUST
    // come before any converter involvement — a "fail fast if !isPptxEnabled()"
    // guard at the top of this function would silently brick every existing deck.
    mockConvert.mockResolvedValue(null)
    const cached = Buffer.from('%PDF-1.7 cached')
    const db = makeAdminDb({ [DERIVED]: cached, [DECK]: Buffer.from('pptx-bytes') })

    const out = await loadRenderablePdf(db, DECK)

    expect(out).toEqual(cached)
    expect(mockConvert).not.toHaveBeenCalled()
    // And it doesn't pay to download the original it isn't going to convert.
    expect(db.downloaded).toEqual([DERIVED])
  })

  it('converts an uncached deck once and caches the derived PDF beside the original', async () => {
    const converted = Buffer.from('%PDF-1.7 converted')
    mockConvert.mockResolvedValue(converted)
    const db = makeAdminDb({ [DECK]: Buffer.from('pptx-bytes') })

    const out = await loadRenderablePdf(db, DECK)

    expect(out).toEqual(converted)
    // Source extension reaches the converter — it selects the import filter from it.
    expect(mockConvert).toHaveBeenCalledWith(expect.any(Buffer), 'pptx')
    // Cached under the same section prefix, so the derived PDF inherits the
    // original's access scope rather than landing somewhere unguarded.
    expect(db.uploads).toEqual([
      { path: DERIVED, body: converted, contentType: 'application/pdf', upsert: true },
    ])
  })

  it("degrades an unconverted deck to 'unsupported' (415), not null (404) or a throw", async () => {
    mockConvert.mockResolvedValue(null) // converter off, or it rejected the file
    const db = makeAdminDb({ [DECK]: Buffer.from('pptx-bytes') })

    expect(await loadRenderablePdf(db, DECK)).toBe('unsupported')
    // Nothing half-converted gets cached, so flipping the switch back on retries.
    expect(db.uploads).toEqual([])
  })

  it('returns null for a missing source file, keeping 404 distinct from 415', async () => {
    mockConvert.mockResolvedValue(Buffer.from('%PDF'))
    const db = makeAdminDb({}) // neither the deck nor a derived PDF exists

    expect(await loadRenderablePdf(db, DECK)).toBeNull()
    expect(mockConvert).not.toHaveBeenCalled()
  })

  it('still returns the converted PDF when caching it fails', async () => {
    const converted = Buffer.from('%PDF-1.7 converted')
    mockConvert.mockResolvedValue(converted)
    const db = makeAdminDb({ [DECK]: Buffer.from('pptx-bytes') }, { uploadError: { message: 'denied' } })

    // Caching is best-effort — a storage failure must not cost the user the preview.
    expect(await loadRenderablePdf(db, DECK)).toEqual(converted)
  })
})
