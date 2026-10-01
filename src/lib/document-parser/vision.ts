// Vision-based formula extraction. Only invoked by the worker when
// the deterministic text path can't recover LaTeX (print-to-PDF
// PPT exports flatten OMML into glyph positioning — see lab notes).
//
// Cost lever #1: shouldCallVision() gates per-page so we don't burn
// tokens on title slides or plain-text pages. Expected savings on a
// mixed-discipline corpus: 40-70% (lab experiment 18).
//
// Cost lever #2: 5-way parallelism with exponential backoff on 429
// to respect Gemini Flash rate limits without serialising everything.
// Reduced from 10 per Gemini's own review.
//
// Cost lever #3: env-configured caps (pages-per-doc, MB-per-doc) so
// one misconfigured 500-page slide deck can't bankrupt the queue.

import { generateObject } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import sharp from 'sharp'
import { z } from 'zod'

import { FORMULA_EXTRACTION_MODEL } from '@/lib/ai/config'
import { logger } from '@/lib/logger'
import { recordAiUsage, type AiAttribution } from '@/lib/ai/usage'
import type { ExtractedFormulaData, ExtractedFigureData, ExtractedTableData } from '@/lib/validations/document-extraction'
import { renderPdfPages, type RenderedPage } from './page-renderer'

// ── Gating heuristics ──────────────────────────────────────────

// NOTE: all four are GLOBAL (`g`) — we use `.match(re).length` to COUNT
// occurrences, and the thresholds below (`greekHits >= 2`, `noiseHits >= 3`)
// only make sense with a real count. Without `g`, `.match()` returns the first
// hit only (length 1), silently disabling the greek and ppt-noise triggers.

// Mathematical Alphanumeric Symbols block (𝐰 𝐱 𝐳 𝜕 etc.) — a strong
// signal that PPT's equation editor rendered into this page.
const MATH_ALPHANUMERIC = /[\u{1D400}-\u{1D7FF}]/gu

// Ambient math operators / relations.
const MATH_OPERATORS = /[∑∫∏√∞≤≥≠±×÷∈∀∃∧∨⇒⇔∴∂⋯⋮]/g

// Greek letters often stand in for variables.
const GREEK = /[α-ωΑ-Ω]/g

// Placeholder glyphs that PPT's equation editor leaves in the text
// stream when it flattens math — high-density clusters are a signal
// that a formula was present.
const PPT_EQUATION_NOISE = /["!#$%&]/g

export interface PageTextSignal {
  pageNumber: number
  /** Concatenated text for the page — whitespace-normalized. */
  text: string
  /** Distinct font size bucket count for the page (0 if unknown). */
  fontSizeBuckets?: number
}

export interface ShouldCallVisionResult {
  callVision: boolean
  reasons: string[]
}

/**
 * Should we send this page to the vision model? Pure function so it
 * can be reused by the UI, admin dashboards, and backfill scripts.
 */
export function shouldCallVision(signal: PageTextSignal): ShouldCallVisionResult {
  const { text } = signal
  const reasons: string[] = []

  // Blank or near-blank pages: skip unconditionally.
  if (text.length < 10) {
    return { callVision: false, reasons: ['page too sparse'] }
  }

  const alphaHits = (text.match(MATH_ALPHANUMERIC) || []).length
  const opHits = (text.match(MATH_OPERATORS) || []).length
  const greekHits = (text.match(GREEK) || []).length
  const noiseHits = (text.match(PPT_EQUATION_NOISE) || []).length
  const noiseDensity = noiseHits / text.length
  const fontSizeBuckets = signal.fontSizeBuckets ?? 0

  if (alphaHits > 0) reasons.push(`math-alpha=${alphaHits}`)
  if (opHits > 0) reasons.push(`math-ops=${opHits}`)
  if (greekHits >= 2) reasons.push(`greek=${greekHits}`)
  if (noiseDensity > 0.03 && noiseHits >= 3) {
    reasons.push(`ppt-noise=${noiseHits}(${(noiseDensity * 100).toFixed(1)}%)`)
  }
  if (fontSizeBuckets >= 4) reasons.push(`font-sizes=${fontSizeBuckets}`)

  const callVision =
    alphaHits > 0 ||
    opHits > 0 ||
    greekHits >= 2 ||
    (noiseDensity > 0.03 && noiseHits >= 3)

  return { callVision, reasons }
}

/** Scanned-PDF predicate: almost no text despite having pages. */
export function isLikelyScannedPdf(opts: { pageCount: number; wordCount: number }): boolean {
  return opts.pageCount > 0 && opts.wordCount < 10
}

// ── Vision call ────────────────────────────────────────────────

const FormulaExtractionSchema = z.object({
  formulas: z.array(
    z.object({
      latex: z.string().describe('LaTeX source for the expression, WITHOUT delimiters.'),
      surroundingText: z
        .string()
        .describe('Short nearby text so the formula can be located on the page.')
        .default(''),
      kind: z
        .enum(['inline', 'display'])
        .describe('inline = inside a sentence; display = its own block.')
        .default('display'),
    }),
  ),
  imageDescriptions: z
    .array(z.object({ description: z.string() }))
    .describe('One-line descriptions of any non-text diagrams visible on the page.')
    .default([]),
  tables: z
    .array(
      z.object({
        html: z.string().describe('The table as clean HTML <table> with <tr>/<td>, merged cells via colspan/rowspan.'),
        rows: z.number().int().describe('number of rows (incl. header)'),
        cols: z.number().int().describe('number of columns'),
        bbox: z
          .object({
            x: z.number().describe('left edge, fraction of image width (0-1)'),
            y: z.number().describe('top edge, fraction of image height (0-1)'),
            width: z.number().describe('fraction of image width (0-1)'),
            height: z.number().describe('fraction of image height (0-1)'),
          })
          .nullable()
          .describe('Bounding box of the table region on the page image, as fractions from the TOP-LEFT corner. Include the table caption if directly adjacent. null if unsure.')
          .default(null),
      }),
    )
    .describe('Any real data tables on the page (especially borderless ones). Empty if none.')
    .default([]),
})

/**
 * Convert a model-supplied normalized bbox (fractions of the page image,
 * TOP-LEFT origin) into the stored convention (PDF points, BOTTOM-LEFT
 * origin — same space the geometric detector writes, see asset-crop.ts).
 * The model's geometry is untrusted: values are clamped into the page and
 * implausible boxes (degenerate, inverted, or covering ~the whole page —
 * which is no better than the full-page fallback) return undefined, so a
 * bad guess can never slice the table. Exported for tests.
 */
export function normalizedBboxToPoints(
  b: { x: number; y: number; width: number; height: number } | null | undefined,
  pointsWidth: number,
  pointsHeight: number,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!b || !(pointsWidth > 0) || !(pointsHeight > 0)) return undefined
  const vals = [b.x, b.y, b.width, b.height]
  if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return undefined
  const x0 = Math.min(Math.max(b.x, 0), 1)
  const y0 = Math.min(Math.max(b.y, 0), 1)
  const x1 = Math.min(Math.max(b.x + b.width, 0), 1)
  const y1 = Math.min(Math.max(b.y + b.height, 0), 1)
  const w = x1 - x0
  const h = y1 - y0
  // Too small to be a real table, or so large the full-page fallback is
  // equivalent anyway (and a near-full box suggests the model guessed).
  if (w < 0.05 || h < 0.02) return undefined
  if (w > 0.98 && h > 0.95) return undefined
  return {
    x: x0 * pointsWidth,
    y: (1 - y1) * pointsHeight, // flip to bottom-left origin
    width: w * pointsWidth,
    height: h * pointsHeight,
  }
}

const FORMULA_PROMPT = `From this lecture slide/page, extract three things:
1. All mathematical formulas as LaTeX (with a short phrase of nearby text to locate each). Do NOT include prose, headings, or bullets — only real math.
2. One-line descriptions of any non-text diagrams/figures (not plain text boxes).
3. Any real DATA TABLES as clean HTML (<table>/<tr>/<td>, merged cells via colspan/rowspan), with row/column counts, plus each table's bounding box as fractions of the image (x, y from the TOP-LEFT corner; include the caption line if adjacent). Only genuine tables — not lists or columns of prose. Return an empty tables list if there are none.`

export interface VisionOptions {
  /** Override Gemini key for tests. Defaults to GOOGLE_GENERATIVE_AI_API_KEY env. */
  apiKey?: string
  /** Retries on 429 / transient errors. Default: 3. */
  maxRetries?: number
  /** Cost-ledger attribution for the vision call (institution/section/user). */
  attribution?: AiAttribution
}

/** One vision call yields formulas, figure descriptions, and table HTML. */
export interface VisionPageResult {
  formulas: ExtractedFormulaData[]
  figures: ExtractedFigureData[]
  tables: ExtractedTableData[]
}

/**
 * Run the vision model on a single page PNG and return extracted
 * formulas AND figure descriptions (the schema already returns both;
 * we used to discard the descriptions). Throws only after all retries
 * are exhausted.
 */
export async function extractFormulasForPage(
  pagePng: Buffer,
  pageNumber: number,
  opts: VisionOptions = {},
  /** Page size in PDF points — when present, model table bboxes are converted
   *  to stored point-space; without it (standalone images) bboxes are dropped. */
  pointsSize?: { width: number; height: number },
): Promise<VisionPageResult> {
  const apiKey = opts.apiKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) {
    throw new Error('GOOGLE_GENERATIVE_AI_API_KEY missing — cannot run formula vision')
  }
  const google = createGoogleGenerativeAI({ apiKey })
  const maxRetries = opts.maxRetries ?? 3


  let lastError: unknown = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { object, usage } = await generateObject({
        model: google(FORMULA_EXTRACTION_MODEL),
        schema: FormulaExtractionSchema,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: FORMULA_PROMPT },
              { type: 'image', image: pagePng, mediaType: 'image/png' },
            ],
          },
        ],
      })

      void recordAiUsage({
        feature: 'formula_extraction',
        model: FORMULA_EXTRACTION_MODEL,
        ...opts.attribution,
        usage,
        metadata: { pageNumber },
      })

      return {
        formulas: object.formulas.map((f) => ({
          pageNumber,
          latex: f.latex,
          surroundingText: f.surroundingText || undefined,
          kind: f.kind,
          source: 'vision' as const,
        })),
        // Previously discarded — now stamped as figure units (Phase 2).
        figures: (object.imageDescriptions ?? [])
          .map((d) => d.description?.trim())
          .filter((desc): desc is string => !!desc)
          .map((description) => ({
            pageNumber,
            description,
            source: 'vision' as const,
          })),
        // Table HTML on flagged (borderless/merged/low-confidence) pages (Phase 3b).
        // The model's bbox (validated) gives VLM-recovered tables a tight crop
        // instead of the full-page fallback.
        tables: (object.tables ?? [])
          .filter((t) => t.html?.trim())
          .map((t) => ({
            pageNumber,
            html: t.html,
            rows: t.rows,
            cols: t.cols,
            source: 'vision' as const,
            bbox: pointsSize
              ? normalizedBboxToPoints(t.bbox, pointsSize.width, pointsSize.height)
              : undefined,
          })),
      }
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      const is429 = /429|rate[- ]?limit|quota/i.test(message)
      if (attempt < maxRetries && is429) {
        // 1s, 2s, 4s — simple exponential backoff.
        const delay = Math.pow(2, attempt) * 1000
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      if (attempt < maxRetries && !is429) {
        // Non-rate-limit errors get ONE retry only. If it's flaky
        // infra it'll recover; if it's deterministic (bad input)
        // we bail fast.
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
      }
      break
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('vision extraction failed after retries')
}

/**
 * Standalone-image path (Phase 5c). A raster upload has no native layer, so the
 * whole image goes to the VLM as a single page-1 call. We normalize to PNG first
 * (Gemini wants raster; sharp also rasterizes the odd SVG/webp/gif) so the call
 * always sends image/png. Everything it returns is tagged source 'vision'.
 */
export async function runVisionOnImage(input: {
  imageBuffer: Buffer
  visionOptions?: VisionOptions
}): Promise<VisionPageResult> {
  const png = await sharp(input.imageBuffer).png().toBuffer()
  return extractFormulasForPage(png, 1, input.visionOptions)
}

// ── Orchestration ──────────────────────────────────────────────

export interface RunVisionFormulaExtractionInput {
  pdfBuffer: Buffer
  /** Page numbers that the worker has decided need vision. */
  pageNumbers: number[]
  /** Max concurrent vision calls. Default 5. */
  concurrency?: number
  /** Override the page renderer (tests). */
  renderPages?: (buffer: Buffer, pages: number[]) => Promise<RenderedPage[]>
  visionOptions?: VisionOptions
}

export interface RunVisionFormulaExtractionResult {
  formulas: ExtractedFormulaData[]
  figures: ExtractedFigureData[]
  tables: ExtractedTableData[]
  perPageErrors: Array<{ pageNumber: number; error: string }>
  callsMade: number
}

/**
 * High-level orchestrator used by the worker. Renders each target
 * page to PNG (via the injected renderer for testability) and runs
 * the vision model with bounded concurrency, surfacing per-page
 * errors rather than aborting the whole job.
 */
export async function runVisionFormulaExtraction(
  input: RunVisionFormulaExtractionInput,
): Promise<RunVisionFormulaExtractionResult> {
  const { pdfBuffer, pageNumbers } = input
  const concurrency = input.concurrency ?? 5
  const renderer = input.renderPages ?? ((b, ps) => renderPdfPages(b, ps, 2))

  if (pageNumbers.length === 0) {
    return { formulas: [], figures: [], tables: [], perPageErrors: [], callsMade: 0 }
  }

  const rendered = await renderer(pdfBuffer, pageNumbers)

  // Simple bounded-concurrency pool — no external dep.
  const formulas: ExtractedFormulaData[] = []
  const figures: ExtractedFigureData[] = []
  const tables: ExtractedTableData[] = []
  const perPageErrors: { pageNumber: number; error: string }[] = []
  let callsMade = 0
  let cursor = 0

  async function worker() {
    while (cursor < rendered.length) {
      const idx = cursor++
      const page = rendered[idx]
      try {
        callsMade += 1
        const pageResult = await extractFormulasForPage(
          page.png,
          page.pageNumber,
          input.visionOptions,
          page.pointsWidth > 0 && page.pointsHeight > 0
            ? { width: page.pointsWidth, height: page.pointsHeight }
            : undefined,
        )
        formulas.push(...pageResult.formulas)
        figures.push(...pageResult.figures)
        tables.push(...pageResult.tables)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('runVisionFormulaExtraction: page failed', {
          pageNumber: page.pageNumber,
          error: message,
        })
        perPageErrors.push({ pageNumber: page.pageNumber, error: message })
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, rendered.length) }, () =>
    worker(),
  )
  await Promise.all(workers)

  return { formulas, figures, tables, perPageErrors, callsMade }
}
