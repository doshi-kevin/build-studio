// Zod schemas for document extraction data stored in
// module_items.content.extraction. Shape covers three subsystems:
// text (pages + metadata), images (per-page PNG refs in Storage),
// and formulas (LaTeX, per-page). Each subsystem has its own status
// flag so the worker can report partial progress (e.g. text+images
// done but vision for formulas still running or skipped).
//
// New fields are optional so prod rows written by the previous
// pipeline still round-trip through these schemas.

import { z } from 'zod'

// ── Status enums ───────────────────────────────────────────────
// Top-level job status. 'partial' means at least one subsystem
// completed but another failed (e.g. text ok but images bucket
// write failed).
export const extractionStatusSchema = z.enum([
  'processing',
  'completed',
  'partial',
  'failed',
])

// Per-subsystem status. 'skipped' applies when a subsystem was
// deliberately not attempted (e.g. formulas on a page with no
// math-signal hit, or vision on a doc above the per-file cap).
export const extractionSubsystemStatusSchema = z.enum([
  'pending',
  'processing',
  'completed',
  'failed',
  'skipped',
])

// ── Page text ──────────────────────────────────────────────────
export const extractionPageSchema = z.object({
  pageNumber: z.number().int().min(1),
  text: z.string(),
  headings: z.array(z.string()),
})

// ── Images ─────────────────────────────────────────────────────
// `bbox` coordinates are in the PDF's native user space (points),
// with origin at the bottom-left of the page per PDF convention.
// Width/height are the rendered size, not the raw pixel dimensions.
export const extractionBboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
})

export const extractedImageSchema = z.object({
  pageNumber: z.number().int().min(1),
  storagePath: z.string().min(1),
  storageUrl: z.string().min(1),
  bbox: extractionBboxSchema.optional(),
  pixelWidth: z.number().int().positive(),
  pixelHeight: z.number().int().positive(),
  bytes: z.number().int().nonnegative().optional(),
  altText: z.string().optional(),
})

// ── Formulas ───────────────────────────────────────────────────
export const extractedFormulaSchema = z.object({
  pageNumber: z.number().int().min(1),
  latex: z.string().min(1),
  surroundingText: z.string().optional(),
  kind: z.enum(['inline', 'display']).default('display'),
  source: z.enum(['omml', 'vision']),
  bbox: extractionBboxSchema.optional(),
})

// ── Tables ─────────────────────────────────────────────────────
// Stored as HTML (not markdown pipes) so merged cells and multi-row
// headers survive. `source` is the citation-trust dial: 'native' =
// read from OOXML a:tbl/w:tbl (exact), 'geometric' = pdfplumber-style
// lattice/stream, 'vision' = transcribed by the VLM.
export const extractedTableSchema = z.object({
  pageNumber: z.number().int().min(1),
  html: z.string().min(1),
  rows: z.number().int().nonnegative(),
  cols: z.number().int().nonnegative(),
  source: z.enum(['native', 'geometric', 'vision']),
  bbox: extractionBboxSchema.optional(),
})

// ── Code ───────────────────────────────────────────────────────
// A code block detected by font (monospace runs) or, later, by the
// VLM when code is rendered as a screenshot. `language` is best-effort.
export const extractedCodeSchema = z.object({
  pageNumber: z.number().int().min(1),
  code: z.string().min(1),
  language: z.string().optional(),
  source: z.enum(['native', 'vision']),
  bbox: extractionBboxSchema.optional(),
})

// ── Charts ─────────────────────────────────────────────────────
// A chart's underlying DATA, not a picture of it. Read exactly from the
// OOXML c:chart/c:ser part ($0, source 'native'), so the quiz generator can
// build questions like "what was 2022 enrollment?" that a description can't
// answer. `data` is the series as CSV (category column + one column per
// series). Raster charts (PDF/image) carry no data and stay a `figure`.
export const extractedChartSchema = z.object({
  pageNumber: z.number().int().min(1),
  title: z.string().optional(),
  data: z.string().min(1),
  source: z.enum(['native', 'vision']),
  bbox: extractionBboxSchema.optional(),
})

// ── Figures ────────────────────────────────────────────────────
// A described visual region (diagram / chart-as-image / photo). Holds
// a one-line description, NOT a stored file (those are `images`).
// `source` is the citation-trust dial: 'native' = author alt-text,
// 'ocr' = scraped labels, 'vision' = VLM-generated description.
export const extractedFigureSchema = z.object({
  pageNumber: z.number().int().min(1),
  description: z.string().min(1),
  source: z.enum(['native', 'ocr', 'vision']),
  bbox: extractionBboxSchema.optional(),
})

// ── Metadata ───────────────────────────────────────────────────
// pageCount/wordCount are the deterministic-path headline numbers.
// imageCount/formulaCount are informational and may lag behind
// images[].length during a running job — trust the array, not the
// count, once status === 'completed'.
export const extractionMetadataSchema = z.object({
  pageCount: z.number().int().min(0),
  wordCount: z.number().int().min(0),
  imageCount: z.number().int().min(0).optional(),
  formulaCount: z.number().int().min(0).optional(),
  author: z.string().optional(),
  title: z.string().optional(),
})

// ── Top-level extraction result ────────────────────────────────
// Stored under module_items.content.extraction.
// All new fields (images, formulas, textStatus, imagesStatus,
// formulasStatus, jobId) are optional so prod rows written by the
// pre-queue pipeline round-trip cleanly.
export const extractionResultSchema = z.object({
  status: extractionStatusSchema,
  extractedAt: z.string(),
  error: z.string().nullable(),
  metadata: extractionMetadataSchema,
  pages: z.array(extractionPageSchema),
  images: z.array(extractedImageSchema).optional(),
  formulas: z.array(extractedFormulaSchema).optional(),
  tables: z.array(extractedTableSchema).optional(),
  code: z.array(extractedCodeSchema).optional(),
  charts: z.array(extractedChartSchema).optional(),
  figures: z.array(extractedFigureSchema).optional(),
  textStatus: extractionSubsystemStatusSchema.optional(),
  imagesStatus: extractionSubsystemStatusSchema.optional(),
  formulasStatus: extractionSubsystemStatusSchema.optional(),
  tablesStatus: extractionSubsystemStatusSchema.optional(),
  // Transient: pages where Tier-0 found a borderless/merged/low-confidence table
  // it won't trust. The PDF extractor sets it; the worker routes those pages to
  // the VLM and clears it before persisting (it is never stored).
  tableVisionPages: z.array(z.number().int().min(1)).optional(),
  jobId: z.string().uuid().optional(),
})

// ── Type exports ───────────────────────────────────────────────
export type ExtractionStatus = z.infer<typeof extractionStatusSchema>
export type ExtractionSubsystemStatus = z.infer<typeof extractionSubsystemStatusSchema>
export type ExtractionPageData = z.infer<typeof extractionPageSchema>
export type ExtractionBbox = z.infer<typeof extractionBboxSchema>
export type ExtractedImageData = z.infer<typeof extractedImageSchema>
export type ExtractedFormulaData = z.infer<typeof extractedFormulaSchema>
export type ExtractedTableData = z.infer<typeof extractedTableSchema>
export type ExtractedCodeData = z.infer<typeof extractedCodeSchema>
export type ExtractedChartData = z.infer<typeof extractedChartSchema>
export type ExtractedFigureData = z.infer<typeof extractedFigureSchema>
export type ExtractionMetadataData = z.infer<typeof extractionMetadataSchema>
export type ExtractionResultData = z.infer<typeof extractionResultSchema>
