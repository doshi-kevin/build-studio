// @vitest-environment node
//
// Wiring around normalizedBboxToPoints (unit-tested in vision-table-bbox.test.ts):
// extractFormulasForPage / runVisionFormulaExtraction must attach the CONVERTED
// point-space bbox to a vision table only when page size in points is known, and
// drop it (undefined) otherwise. Gemini is mocked to return one table whose
// model-supplied box is top-left fractional; we assert the y-flipped result and
// the points-size gating. No network, no extra calls.
import { describe, it, expect, vi } from 'vitest'

// US Letter in points; the mock table sits at x:10–90%, y:20–50% from the top.
const W = 612
const H = 792

vi.mock('ai', () => ({
  generateObject: vi.fn(async () => ({
    object: {
      formulas: [],
      imageDescriptions: [],
      tables: [
        {
          html: '<table><tr><td>Year</td><td>N</td></tr></table>',
          rows: 1,
          cols: 2,
          bbox: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 },
        },
      ],
    },
  })),
}))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: () => () => 'mock-model' }))

import { extractFormulasForPage, runVisionFormulaExtraction } from '@/lib/document-parser/vision'

describe('vision table bbox wiring', () => {
  it('converts the model bbox to point-space (y-flipped) when pointsSize is given', async () => {
    const res = await extractFormulasForPage(Buffer.from('png'), 3, { apiKey: 'test' }, {
      width: W,
      height: H,
    })
    expect(res.tables).toHaveLength(1)
    const bbox = res.tables[0].bbox
    expect(bbox).toBeDefined()
    expect(bbox!.x).toBeCloseTo(0.1 * W)
    expect(bbox!.width).toBeCloseTo(0.8 * W)
    expect(bbox!.height).toBeCloseTo(0.3 * H)
    // bottom-left origin: 1 - (0.2 + 0.3) = 0.5 of the height from the bottom.
    expect(bbox!.y).toBeCloseTo(0.5 * H)
  })

  it('drops the bbox (undefined) when pointsSize is absent — standalone images', async () => {
    const res = await extractFormulasForPage(Buffer.from('png'), 3, { apiKey: 'test' })
    expect(res.tables).toHaveLength(1)
    expect(res.tables[0].bbox).toBeUndefined()
  })

  it('orchestrator passes page point-size through, attaching a converted bbox', async () => {
    const res = await runVisionFormulaExtraction({
      pdfBuffer: Buffer.from('pdf'),
      pageNumbers: [1],
      renderPages: async (_b, ps) =>
        ps.map((p) => ({
          pageNumber: p,
          width: 10,
          height: 10,
          pointsWidth: W,
          pointsHeight: H,
          png: Buffer.from('img'),
          buffer: Buffer.from('img'),
          mimeType: 'image/png',
        })),
      visionOptions: { apiKey: 'test' },
    })
    expect(res.tables).toHaveLength(1)
    expect(res.tables[0].bbox).toBeDefined()
    expect(res.tables[0].bbox!.y).toBeCloseTo(0.5 * H)
  })

  it('orchestrator drops the bbox when a page has no point dimensions', async () => {
    const res = await runVisionFormulaExtraction({
      pdfBuffer: Buffer.from('pdf'),
      pageNumbers: [1],
      renderPages: async (_b, ps) =>
        ps.map((p) => ({
          pageNumber: p,
          width: 10,
          height: 10,
          pointsWidth: 0,
          pointsHeight: 0,
          png: Buffer.from('img'),
          buffer: Buffer.from('img'),
          mimeType: 'image/png',
        })),
      visionOptions: { apiKey: 'test' },
    })
    expect(res.tables).toHaveLength(1)
    expect(res.tables[0].bbox).toBeUndefined()
  })
})
