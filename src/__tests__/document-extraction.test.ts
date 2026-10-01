// Tests for the document-extraction Zod schema. Pins the contract so
// schema drift (new field required, renamed field) fails loud rather
// than silently rejecting prod rows. Fixtures mirror the shapes
// currently in production on 2026-04-22: 10 completed rows written by
// the officeparser pipeline, plus one 'failed' row. All should
// round-trip through the extended schema unchanged.

import { describe, it, expect } from 'vitest'
import {
  extractionResultSchema,
  extractedImageSchema,
  extractedFormulaSchema,
  extractedFigureSchema,
  extractionSubsystemStatusSchema,
} from '@/lib/validations/document-extraction'

// ── Fixtures ──────────────────────────────────────────────────
// Shape captured from prod DB read on 2026-04-22 (from the "Prod DB state"
// section of the extraction benchmark doc, no longer in the repo). Text + page
// counts anonymised; no row has images/formulas yet.

const PROD_COMPLETED_ROW = {
  status: 'completed',
  extractedAt: '2026-03-10T14:22:08.000Z',
  error: null,
  metadata: {
    pageCount: 28,
    wordCount: 985,
    title: 'Microsoft PowerPoint - CpE646-1.ppt [Compatibility Mode]',
    author: 'Hong Man',
  },
  pages: [
    { pageNumber: 1, text: 'CpE 646 — Pattern Recognition', headings: ['CpE 646'] },
    { pageNumber: 2, text: 'Agenda — Today we cover...', headings: ['Agenda'] },
  ],
}

const PROD_COMPLETED_LARGE_ROW = {
  status: 'completed',
  extractedAt: '2026-03-18T09:12:11.000Z',
  error: null,
  metadata: { pageCount: 114, wordCount: 23814 },
  pages: Array.from({ length: 114 }, (_, i) => ({
    pageNumber: i + 1,
    text: `page ${i + 1} body`,
    headings: [],
  })),
}

const PROD_FAILED_ROW = {
  status: 'failed',
  extractedAt: '2026-03-22T21:04:00.000Z',
  error: 'File too large for extraction (max 100MB)',
  metadata: { pageCount: 0, wordCount: 0 },
  pages: [],
}

const PROD_PROCESSING_ROW = {
  // The previous pipeline wrote status='processing' in actions.ts:583
  // even though the top-level TS type only declared 'completed' | 'failed'.
  // The schema must accept it so rows in flight during a deploy still
  // re-validate on read.
  status: 'processing',
  extractedAt: '2026-04-22T12:00:00.000Z',
  error: null,
  metadata: { pageCount: 0, wordCount: 0 },
  pages: [],
}

// ── Tests ─────────────────────────────────────────────────────
describe('extractionResultSchema', () => {
  it('round-trips a completed prod row without images or formulas', () => {
    const parsed = extractionResultSchema.parse(PROD_COMPLETED_ROW)
    expect(parsed.status).toBe('completed')
    expect(parsed.images).toBeUndefined()
    expect(parsed.formulas).toBeUndefined()
    expect(parsed.textStatus).toBeUndefined()
  })

  it('round-trips a large 114-page row (no images)', () => {
    const parsed = extractionResultSchema.parse(PROD_COMPLETED_LARGE_ROW)
    expect(parsed.pages).toHaveLength(114)
  })

  it('round-trips a failed row with an error message', () => {
    const parsed = extractionResultSchema.parse(PROD_FAILED_ROW)
    expect(parsed.status).toBe('failed')
    expect(parsed.error).toMatch(/too large/)
  })

  it("accepts status='processing' for in-flight jobs from the old pipeline", () => {
    const parsed = extractionResultSchema.parse(PROD_PROCESSING_ROW)
    expect(parsed.status).toBe('processing')
  })

  it("accepts the new 'partial' status for multi-subsystem jobs", () => {
    const parsed = extractionResultSchema.parse({
      ...PROD_COMPLETED_ROW,
      status: 'partial',
      textStatus: 'completed',
      imagesStatus: 'completed',
      formulasStatus: 'failed',
    })
    expect(parsed.status).toBe('partial')
    expect(parsed.formulasStatus).toBe('failed')
  })

  it('accepts a row with images[] populated by the new pipeline', () => {
    const parsed = extractionResultSchema.parse({
      ...PROD_COMPLETED_ROW,
      images: [
        {
          pageNumber: 17,
          storagePath: 'extracted-images/sec1/item1/page017_img1.png',
          storageUrl: 'https://ywdqaoahfmmzcsczxvxn.supabase.co/storage/v1/.../page017_img1.png',
          bbox: { x: 120.5, y: 340, width: 194, height: 368 },
          pixelWidth: 194,
          pixelHeight: 368,
          bytes: 20248,
        },
      ],
      imagesStatus: 'completed',
    })
    expect(parsed.images).toHaveLength(1)
    expect(parsed.images?.[0].pageNumber).toBe(17)
    expect(parsed.imagesStatus).toBe('completed')
  })

  it('accepts a row with formulas[] populated by the vision pass', () => {
    const parsed = extractionResultSchema.parse({
      ...PROD_COMPLETED_ROW,
      formulas: [
        {
          pageNumber: 15,
          latex: '\\text{Margin} = \\min_{j} \\frac{y_j(\\mathbf{w}^T\\mathbf{x}_j+b)}{\\|\\mathbf{w}\\|_2}',
          surroundingText: 'Margin = ... ; we want to maximize the margin.',
          kind: 'display',
          source: 'vision',
        },
      ],
      formulasStatus: 'completed',
    })
    expect(parsed.formulas).toHaveLength(1)
    expect(parsed.formulas?.[0].source).toBe('vision')
    expect(parsed.formulas?.[0].kind).toBe('display')
  })

  it('rejects images[] entries missing required fields', () => {
    const bad = extractionResultSchema.safeParse({
      ...PROD_COMPLETED_ROW,
      images: [{ pageNumber: 1, storagePath: 'path', storageUrl: 'url' }], // missing pixelWidth/pixelHeight
    })
    expect(bad.success).toBe(false)
  })

  it('rejects formulas with unknown source', () => {
    const bad = extractionResultSchema.safeParse({
      ...PROD_COMPLETED_ROW,
      formulas: [{ pageNumber: 1, latex: 'x', source: 'magic' }],
    })
    expect(bad.success).toBe(false)
  })
})

describe('subsystem status enum', () => {
  it('allows all five subsystem states', () => {
    for (const s of ['pending', 'processing', 'completed', 'failed', 'skipped']) {
      expect(extractionSubsystemStatusSchema.parse(s)).toBe(s)
    }
  })

  it('rejects the legacy top-level "partial" value at the subsystem level', () => {
    // 'partial' is only meaningful at the top level — a single subsystem is
    // either pending, processing, completed, failed, or skipped, nothing in
    // between. Guarding against a copy/paste bug.
    const bad = extractionSubsystemStatusSchema.safeParse('partial')
    expect(bad.success).toBe(false)
  })
})

describe('extractedImageSchema', () => {
  it('requires pixel dimensions to be positive', () => {
    const bad = extractedImageSchema.safeParse({
      pageNumber: 1,
      storagePath: 'path',
      storageUrl: 'url',
      pixelWidth: 0,
      pixelHeight: 100,
    })
    expect(bad.success).toBe(false)
  })

  it('accepts an image with only required fields', () => {
    const ok = extractedImageSchema.parse({
      pageNumber: 1,
      storagePath: 'extracted-images/a/b/page001_img1.png',
      storageUrl: 'https://example.com/png',
      pixelWidth: 100,
      pixelHeight: 200,
    })
    expect(ok.pageNumber).toBe(1)
    expect(ok.bbox).toBeUndefined()
    expect(ok.bytes).toBeUndefined()
  })
})

describe('extractedFormulaSchema', () => {
  it("defaults kind to 'display' when omitted", () => {
    const parsed = extractedFormulaSchema.parse({
      pageNumber: 1,
      latex: '\\pi',
      source: 'omml',
    })
    expect(parsed.kind).toBe('display')
  })
})

describe('extractedFigureSchema', () => {
  it('accepts a valid VLM figure description', () => {
    const parsed = extractedFigureSchema.parse({
      pageNumber: 14,
      description: 'an encoder-decoder diagram with attention arrows',
      source: 'vision',
    })
    expect(parsed.source).toBe('vision')
  })

  it('rejects an empty description (min(1))', () => {
    expect(extractedFigureSchema.safeParse({ pageNumber: 1, description: '', source: 'vision' }).success).toBe(false)
  })

  it('rejects an unknown source', () => {
    expect(extractedFigureSchema.safeParse({ pageNumber: 1, description: 'x', source: 'omml' }).success).toBe(false)
  })

  it('rejects pageNumber < 1', () => {
    expect(extractedFigureSchema.safeParse({ pageNumber: 0, description: 'x', source: 'native' }).success).toBe(false)
  })
})

// ── Behaviour pins ───────────────────────────────────────────
// Shapes the schema accepts today that consumers (chat/RAG,
// StudentModuleItemRow) need to stay aware of. Reviewer flagged each
// of these as worth pinning so a future tightening PR can't
// silently reject live prod rows, and a new consumer doesn't
// assume a stricter guarantee than actually holds.

describe('schema permissiveness (pinned, intentional)', () => {
  it("allows status='completed' with zero pages — prod has failed-but-marked-completed rows", () => {
    // extractDocumentContent writes pages:[] on large-file failure paths
    // while still returning success:true in some branches — see
    // src/app/(dashboard)/professor/courses/[sectionId]/modules/actions.ts
    // circa the MAX_EXTRACTION_SIZE guard. Chat/RAG consumers must handle
    // "completed but empty" as a no-op, not assume pages.length > 0.
    const parsed = extractionResultSchema.parse({
      ...PROD_COMPLETED_ROW,
      pages: [],
      metadata: { pageCount: 0, wordCount: 0 },
    })
    expect(parsed.status).toBe('completed')
    expect(parsed.pages).toHaveLength(0)
  })

  it("allows status='partial' without any subsystem status populated", () => {
    // Worker may briefly write partial mid-flight before tagging subsystems.
    // Consumers reading an in-flight row should not crash on undefined.
    const parsed = extractionResultSchema.parse({
      ...PROD_COMPLETED_ROW,
      status: 'partial',
    })
    expect(parsed.status).toBe('partial')
    expect(parsed.textStatus).toBeUndefined()
    expect(parsed.imagesStatus).toBeUndefined()
    expect(parsed.formulasStatus).toBeUndefined()
  })

  it('allows duplicate or out-of-order pageNumber across pages/images/formulas', () => {
    // We deliberately do NOT enforce uniqueness or monotonicity at the
    // schema layer — re-extraction or vision fan-in may temporarily
    // produce duplicates before the worker consolidates. RAG retrieval
    // by pageNumber must dedupe at the consumer side, not trust the row.
    const parsed = extractionResultSchema.parse({
      ...PROD_COMPLETED_ROW,
      pages: [
        { pageNumber: 2, text: 'second', headings: [] },
        { pageNumber: 1, text: 'first', headings: [] },
        { pageNumber: 2, text: 'second again', headings: [] },
      ],
      formulas: [
        { pageNumber: 5, latex: 'x=1', source: 'vision' as const, kind: 'display' as const },
        { pageNumber: 5, latex: 'x=2', source: 'vision' as const, kind: 'display' as const },
      ],
    })
    expect(parsed.pages.map((p) => p.pageNumber)).toEqual([2, 1, 2])
    expect(parsed.formulas).toHaveLength(2)
  })
})
