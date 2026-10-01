// @vitest-environment node
//
// Phases 2 & 3b of hybrid extraction (docs/designs §13.4): the vision call returns
// imageDescriptions (→ figures) and now also table HTML (→ tables, source 'vision').
// Gemini is mocked — no network, no new calls.
import { describe, it, expect, vi } from 'vitest'

// Mock the Gemini call: one formula, two image descriptions (one blank), one table.
vi.mock('ai', () => ({
  generateObject: vi.fn(async () => ({
    object: {
      formulas: [{ latex: 'E = mc^2', surroundingText: 'energy', kind: 'display' }],
      imageDescriptions: [{ description: 'a bar chart of revenue by year' }, { description: '   ' }],
      // one real table + one blank shell (the model sometimes emits empty <table>s)
      tables: [
        { html: '<table><tr><td>Year</td><td>N</td></tr></table>', rows: 1, cols: 2 },
        { html: '   ', rows: 0, cols: 0 },
      ],
    },
  })),
}))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: () => () => 'mock-model' }))

import { extractFormulasForPage, runVisionFormulaExtraction } from '@/lib/document-parser/vision'

describe('vision — figure descriptions (Phase 2)', () => {
  it('returns figures from imageDescriptions, dropping blank ones', async () => {
    const res = await extractFormulasForPage(Buffer.from('png'), 7, { apiKey: 'test' })
    expect(res.formulas).toHaveLength(1)
    expect(res.formulas[0].source).toBe('vision')
    // two descriptions in, one blank → exactly one figure
    expect(res.figures).toHaveLength(1)
    expect(res.figures[0]).toMatchObject({
      pageNumber: 7,
      description: 'a bar chart of revenue by year',
      source: 'vision',
    })
    // Phase 3b: table HTML comes back on the same call, tagged source 'vision'
    expect(res.tables).toHaveLength(1)
    expect(res.tables[0]).toMatchObject({ pageNumber: 7, rows: 1, cols: 2, source: 'vision' })
    expect(res.tables[0].html).toContain('<td>Year</td>')
  })

  it('orchestrator aggregates figures across pages (no extra calls)', async () => {
    const res = await runVisionFormulaExtraction({
      pdfBuffer: Buffer.from('pdf'),
      pageNumbers: [1, 2],
      renderPages: async (_b, ps) =>
        ps.map((p) => ({
          pageNumber: p,
          width: 10,
          height: 10,
          pointsWidth: 5,
          pointsHeight: 5,
          png: Buffer.from('img'),
          buffer: Buffer.from('img'),
          mimeType: 'image/png',
        })),
      visionOptions: { apiKey: 'test' },
    })
    expect(res.callsMade).toBe(2)
    expect(res.formulas).toHaveLength(2)
    expect(res.figures).toHaveLength(2) // one per page, riding the same calls
    expect(res.tables).toHaveLength(2) // table HTML rides the same calls too
    expect(res.figures.every((f) => f.source === 'vision')).toBe(true)
  })
})
