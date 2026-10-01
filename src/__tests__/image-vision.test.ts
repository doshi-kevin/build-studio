// @vitest-environment node
//
// Phase 5c — standalone-image path. Tier 0 is a no-op stub (no native layer);
// the whole image goes to the VLM as one page-1 call, everything tagged 'vision'.
// extractImage validates the buffer with the real sharp; runVisionOnImage runs
// against a mocked Gemini (no network).
import { describe, it, expect, vi } from 'vitest'
import sharp from 'sharp'

vi.mock('ai', () => ({
  generateObject: vi.fn(async () => ({
    object: {
      formulas: [{ latex: 'a^2 + b^2 = c^2', surroundingText: 'pythagoras', kind: 'display' }],
      imageDescriptions: [{ description: 'a right triangle with labelled sides' }],
      tables: [{ html: '<table><tr><td>x</td></tr></table>', rows: 1, cols: 1 }],
    },
  })),
}))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: () => () => 'mock-model' }))

import { extractImage } from '@/lib/document-parser/image'
import { runVisionOnImage } from '@/lib/document-parser/vision'

const opts = { sectionId: 's', moduleItemId: 'm' }

async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .png()
    .toBuffer()
}

describe('extractImage — Tier-0 stub (Phase 5c)', () => {
  it('returns a one-page stub with vision pending for a decodable image', async () => {
    const res = await extractImage(await tinyPng(), opts)
    expect(res.status).toBe('completed')
    expect(res.pages).toEqual([{ pageNumber: 1, text: '', headings: [] }])
    expect(res.textStatus).toBe('skipped')
    expect(res.formulasStatus).toBe('pending')
    expect(res.tablesStatus).toBe('pending')
  })

  it('fails fast (before any VLM call) on a non-image buffer', async () => {
    const res = await extractImage(Buffer.from('not an image'), opts)
    expect(res.status).toBe('failed')
    expect(res.formulasStatus).toBe('failed')
  })
})

describe('runVisionOnImage — whole image → VLM, all source vision (Phase 5c)', () => {
  it('returns formulas, figures, and tables tagged vision on page 1', async () => {
    const res = await runVisionOnImage({ imageBuffer: await tinyPng(), visionOptions: { apiKey: 'test' } })
    expect(res.formulas).toHaveLength(1)
    expect(res.formulas[0]).toMatchObject({ pageNumber: 1, source: 'vision' })
    expect(res.figures).toHaveLength(1)
    expect(res.figures[0]).toMatchObject({ pageNumber: 1, source: 'vision' })
    expect(res.tables).toHaveLength(1)
    expect(res.tables[0]).toMatchObject({ pageNumber: 1, source: 'vision' })
  })
})
