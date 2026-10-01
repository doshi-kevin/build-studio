// Renders a source-page region (an extracted figure/chart/table) to PNG, so
// AI-generated quiz questions can show the actual visual they're about and the
// AI tutor can embed it inline. See docs/designs/quizzes/hybrid-extraction-and-citation.md §16.
//
// Bboxes are stored in PDF points with a bottom-left origin (see
// document-extraction.ts) — the crop converts to top-left pixel space at the
// rendered scale. Units without a bbox (all PPTX units today) fall back to the
// full page image, which for a slide is a natural visual anyway.

import sharp from 'sharp'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { renderPdfPages } from './page-renderer'
import { convertOfficeToPdf } from './office-to-pdf'
import { logger } from '@/lib/logger'
import type { ExtractionBbox } from '@/lib/validations/document-extraction'

const ext = (path: string) => path.toLowerCase().split('.').pop() ?? ''

/**
 * Convertible office types we can turn into a renderable PDF.
 *
 * Word is here for the same reason slides are: LibreOffice paginates a document
 * just as well, and the page image is what carries its figures, tables and
 * formulas — the things text extraction silently drops. While this was
 * decks-only, a DOCX lecture had no page renderer, so it was excluded from the
 * vector index entirely and its reference rail fell back to matching topic
 * names as literal substrings.
 *
 * Note what this does NOT change: `renderPageRegionPng` still crops by bbox,
 * and only PDF extraction records bboxes, so a converted Office page falls back
 * to the whole page — which for a slide or a spreadsheet is the natural visual
 * anyway.
 *
 * Kept to OOXML: `.doc` (WW8) and `.xls` (BIFF) are among LibreOffice's most
 * CVE-dense import filters. `.ppt` predates this and stays.
 *
 * SPREADSHEETS ARE NOT HERE. A workbook converts to hundreds of pictures of
 * number grids — minutes of rendering and an embedding bill per page, for
 * vectors that describe a table's shape rather than an idea. They are indexed
 * from their headers and a few sample rows instead; see
 * src/lib/pinecone/sheet-summary.ts.
 *
 * MUST stay in sync with what the CONVERTER can handle, not with the app image.
 * Conversion no longer runs in this container (issue #182) — it is the isolated
 * Gotenberg service in infra/microservices/deck-converter/, which ships the full
 * LibreOffice filter set. An extension listed here that the converter refuses
 * converts nothing in production, so widen both together.
 */
const OFFICE_EXTS = new Set(['pptx', 'ppt', 'docx'])

/** Can this storage file be rendered to page images (directly or via conversion)? */
export function isRenderableSource(filePath: string): boolean {
  const e = ext(filePath)
  return e === 'pdf' || OFFICE_EXTS.has(e)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

/**
 * Return a renderable PDF buffer for a storage file:
 *  - PDF → downloaded as-is.
 *  - PPTX/PPT → use the cached derived PDF (`<path>.pdf`) if present, else
 *    convert once via the isolated Gotenberg service and cache it for next time.
 *    The cache is checked FIRST, so already-converted decks keep rendering even
 *    when the converter is unconfigured or down.
 *  - anything else → 'unsupported'.
 * Returns null if the source file is missing.
 */
export async function loadRenderablePdf(
  adminDb: AdminDb,
  filePath: string,
): Promise<Buffer | 'unsupported' | null> {
  const e = ext(filePath)

  if (e === 'pdf') {
    const { data: blob, error } = await adminDb.storage.from(COURSE_MATERIALS_BUCKET).download(filePath)
    if (error || !blob) return null
    return Buffer.from(await (blob as Blob).arrayBuffer())
  }

  if (!OFFICE_EXTS.has(e)) return 'unsupported'

  // Cached derived PDF beside the original (same section prefix → same access).
  const derivedPath = `${filePath}.pdf`
  const { data: cached } = await adminDb.storage.from(COURSE_MATERIALS_BUCKET).download(derivedPath)
  if (cached) return Buffer.from(await (cached as Blob).arrayBuffer())

  const { data: orig, error } = await adminDb.storage.from(COURSE_MATERIALS_BUCKET).download(filePath)
  if (error || !orig) return null

  const pdf = await convertOfficeToPdf(Buffer.from(await (orig as Blob).arrayBuffer()), e)
  if (!pdf) return 'unsupported'

  // Cache for subsequent renders (best-effort; ignore upload errors).
  const { error: upErr } = await adminDb.storage
    .from(COURSE_MATERIALS_BUCKET)
    .upload(derivedPath, pdf, { contentType: 'application/pdf', upsert: true })
  if (upErr) logger.warn('loadRenderablePdf: failed to cache derived PDF', { derivedPath })

  return pdf
}

// Padding around the bbox (as a fraction of the page) so the crop keeps a
// little surrounding context — captions and axis labels often sit just
// outside the detected region. 1.5% sliced a table caption in half in e2e
// (a caption line is ~12-16pt ≈ 2% of a US-Letter page); 3.5% (~28pt)
// comfortably includes one caption/label line on either side.
const CROP_PAD = 0.035
// A bbox covering less than this fraction of the page in either dimension is
// treated as unreliable (degenerate detection) → fall back to the full page.
const MIN_CROP_FRACTION = 0.03

/**
 * Render one page of a PDF and crop it to a unit's bbox (PDF points,
 * bottom-left origin). No bbox, or a degenerate one → the full page.
 * Returns null if the page is out of range or rendering fails.
 */
export async function renderPageRegionPng(
  pdf: Buffer,
  page: number,
  bbox?: ExtractionBbox,
): Promise<Buffer | null> {
  const [rendered] = await renderPdfPages(pdf, [page], 2, 'png')
  if (!rendered) return null
  if (!bbox || rendered.pointsWidth <= 0 || rendered.pointsHeight <= 0) return rendered.buffer

  // Point-space fractions (flipping y from bottom-left to top-left origin).
  const fx = bbox.x / rendered.pointsWidth
  const fw = bbox.width / rendered.pointsWidth
  const fh = bbox.height / rendered.pointsHeight
  const fy = 1 - (bbox.y + bbox.height) / rendered.pointsHeight

  if (fw < MIN_CROP_FRACTION || fh < MIN_CROP_FRACTION) return rendered.buffer

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  const left = clamp01(fx - CROP_PAD)
  const top = clamp01(fy - CROP_PAD)
  const right = clamp01(fx + fw + CROP_PAD)
  const bottom = clamp01(fy + fh + CROP_PAD)

  const px = {
    left: Math.round(left * rendered.width),
    top: Math.round(top * rendered.height),
    width: Math.round((right - left) * rendered.width),
    height: Math.round((bottom - top) * rendered.height),
  }
  if (px.width < 8 || px.height < 8) return rendered.buffer

  try {
    return await sharp(rendered.buffer).extract(px).png().toBuffer()
  } catch (err) {
    // A bad bbox should degrade to the full page, never lose the visual.
    logger.warn('renderPageRegionPng: crop failed, returning full page', { page, error: String(err) })
    return rendered.buffer
  }
}
