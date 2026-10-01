// Core document parsing logic. Takes a file buffer and type, parses it
// with officeparser, and returns structured extraction data (text per
// page/slide, metadata, word count). fullText is NOT stored — reconstruct
// from pages if needed via getFullText().

import path from 'path'
import { parseOffice, type OfficeParserAST, type OfficeContentNode } from 'officeparser'
import { createAdminClient } from '@/lib/supabase/admin'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { logger } from '@/lib/logger'
import { extractNodeText, countWords, extractHeadings } from './utils'

// Resolve the pdfjs-dist worker path at module level so officeparser
// can find it in the Next.js server action environment (where
// require.resolve inside the library fails due to bundler mangling).
const PDF_WORKER_SRC = path.join(
  process.cwd(),
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
)

// ── Types ────────────────────────────────────────────────────────

export interface ExtractionPage {
  pageNumber: number
  text: string
  headings: string[]
}

export interface ExtractedImage {
  url: string
  path: string
  name: string
  mimeType: string
  altText?: string
  pageNumber?: number
}

export interface ExtractionMetadata {
  pageCount: number
  wordCount: number
  imageCount?: number
  author?: string
  title?: string
}

export interface ExtractionResult {
  status: 'completed' | 'failed'
  extractedAt: string
  error: string | null
  metadata: ExtractionMetadata
  pages: ExtractionPage[]
  images?: ExtractedImage[]
}

/**
 * Reconstruct full text from page-level text on demand.
 * Avoids storing the same text twice in the database.
 */
export function getFullText(pages: ExtractionPage[]): string {
  return pages.map((p) => p.text).join('\n')
}

/**
 * Build a structured text dump with page/slide context for LLM consumption.
 * Format: "Page 1:\n<content>\n\nPage 2:\n<content>\n..."
 * Optionally prepends document title/author metadata if available.
 * Skips pages with no text content.
 */
export function getTextForLLM(
  pages: ExtractionPage[],
  metadata?: ExtractionMetadata,
): string {
  const parts: string[] = []

  // Prepend metadata header if available
  if (metadata?.title || metadata?.author) {
    const headerParts: string[] = []
    if (metadata.title) headerParts.push(`Title: ${metadata.title}`)
    if (metadata.author) headerParts.push(`Author: ${metadata.author}`)
    parts.push(headerParts.join('\n'))
  }

  for (const page of pages) {
    if (!page.text.trim()) continue
    parts.push(`Page ${page.pageNumber}:\n${page.text.trim()}`)
  }

  return parts.join('\n\n')
}

// ── Tutor context (text + tables + figures + code, with cite markers) ──

export interface ExtractionUnitsForLLM {
  // `assetId`, when set, tags the unit's block `[ASSET <id>]` so the model can
  // reference the visual (quiz: sourceAssetId; tutor: asset:// image) — the
  // server validates every reference before rendering anything.
  tables?: Array<{ pageNumber: number; html: string; assetId?: string }>
  figures?: Array<{ pageNumber: number; description: string; assetId?: string }>
  code?: Array<{ pageNumber: number; code: string; language?: string }>
  charts?: Array<{ pageNumber: number; title?: string; data: string; assetId?: string }>
}

/** Compact a stored HTML table into pipe-separated rows for the LLM (cheaper than HTML). */
function htmlTableToText(html: string): string {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
    [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((c) =>
        c[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .trim(),
      )
      .join(' | '),
  )
  return rows.join('\n')
}

/**
 * Build a per-document context block for the AI tutor that includes page text
 * AND the structured units the tutor otherwise can't see (tables, figure
 * descriptions, code), each tagged with a `[Title, page N]` marker the tutor is
 * told to cite. Figures are labeled AI-described so the model treats them as
 * lower-trust than native text.
 */
export function getExtractionContextForLLM(
  docTitle: string,
  pages: ExtractionPage[],
  metadata?: ExtractionMetadata,
  units?: ExtractionUnitsForLLM,
): string {
  const byPage = <T extends { pageNumber: number }>(arr?: T[]) => {
    const map = new Map<number, T[]>()
    for (const u of arr ?? []) {
      const list = map.get(u.pageNumber) ?? []
      list.push(u)
      map.set(u.pageNumber, list)
    }
    return map
  }
  const tablesByPage = byPage(units?.tables)
  const figuresByPage = byPage(units?.figures)
  const codeByPage = byPage(units?.code)
  const chartsByPage = byPage(units?.charts)
  const textByPage = new Map(pages.map((p) => [p.pageNumber, p.text]))

  // Iterate the union of page numbers from text AND units, so a unit on a page
  // with no extracted text (e.g. a vision-read table on an image-only page) is
  // still surfaced rather than silently dropped.
  const pageNums = [
    ...new Set([
      ...pages.map((p) => p.pageNumber),
      ...(units?.tables ?? []).map((u) => u.pageNumber),
      ...(units?.figures ?? []).map((u) => u.pageNumber),
      ...(units?.code ?? []).map((u) => u.pageNumber),
      ...(units?.charts ?? []).map((u) => u.pageNumber),
    ]),
  ].sort((a, b) => a - b)

  const parts: string[] = []
  if (metadata?.author) parts.push(`Author: ${metadata.author}`)

  const tag = (assetId?: string) => (assetId ? ` [ASSET ${assetId}]` : '')

  for (const num of pageNums) {
    const block: string[] = []
    const text = textByPage.get(num)?.trim()
    if (text) block.push(text)
    for (const t of tablesByPage.get(num) ?? []) block.push(`Table${tag(t.assetId)}:\n${htmlTableToText(t.html)}`)
    for (const ch of chartsByPage.get(num) ?? []) block.push(`Chart${tag(ch.assetId)}${ch.title ? ` (${ch.title})` : ''}:\n${ch.data}`)
    for (const f of figuresByPage.get(num) ?? []) block.push(`Figure${tag(f.assetId)} (AI-described): ${f.description}`)
    for (const c of codeByPage.get(num) ?? []) block.push(`Code${c.language ? ` (${c.language})` : ''}:\n${c.code}`)
    if (block.length === 0) continue
    parts.push(`[${docTitle}, page ${num}]\n${block.join('\n\n')}`)
  }

  return parts.join('\n\n')
}

// ── Page/Slide Extraction ────────────────────────────────────────

/**
 * For PDFs: top-level nodes with type 'page' contain page content.
 * For PPTX: top-level nodes with type 'slide' contain slide content.
 */
function extractPages(ast: OfficeParserAST): ExtractionPage[] {
  const pages: ExtractionPage[] = []
  const boundaryType = ast.type === 'pptx' ? 'slide' : 'page'

  for (const node of ast.content) {
    if (node.type === boundaryType) {
      const pageNumber = getPageNumber(node, boundaryType)
      const text = extractNodeText(node)
      const headings = node.children ? extractHeadings(node.children) : []

      pages.push({ pageNumber, text, headings })
    }
  }

  // If no explicit page/slide boundaries found, treat entire content as page 1
  if (pages.length === 0) {
    const text = ast.toText()
    if (text.trim()) {
      pages.push({
        pageNumber: 1,
        text,
        headings: extractHeadings(ast.content),
      })
    }
  }

  return pages
}

/**
 * Extract the page/slide number from a boundary node's metadata.
 */
function getPageNumber(node: OfficeContentNode, boundaryType: string): number {
  if (!node.metadata) return 1
  if (boundaryType === 'slide' && 'slideNumber' in node.metadata) {
    return (node.metadata as { slideNumber: number }).slideNumber
  }
  if (boundaryType === 'page' && 'pageNumber' in node.metadata) {
    return (node.metadata as { pageNumber: number }).pageNumber
  }
  return 1
}

// ── Core Parser ──────────────────────────────────────────────────

/**
 * Parse a document buffer and return structured extraction data.
 * Supports PDF and PPTX formats.
 */
export async function parseDocument(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const ast = await parseOffice(buffer, {
      ignoreNotes: false,
      putNotesAtLast: true,
      extractAttachments: true,
      pdfWorkerSrc: PDF_WORKER_SRC,
    })

    const pages = extractPages(ast)
    const wordCount = countWords(pages.map((p) => p.text).join('\n'))
    const pageCount = pages.length || ast.metadata.pages || 0

    // Extract image attachments (base64-encoded) for later upload
    const rawImages = (ast.attachments || [])
      .filter((a) => a.type === 'image')
      .map((a) => ({
        name: a.name,
        mimeType: a.mimeType,
        data: a.data,
        altText: a.altText,
        extension: a.extension,
      }))

    return {
      status: 'completed',
      extractedAt: new Date().toISOString(),
      error: null,
      metadata: {
        pageCount,
        wordCount,
        imageCount: rawImages.length,
        author: ast.metadata.author || undefined,
        title: ast.metadata.title || undefined,
      },
      pages,
      // rawImages is only used during extraction flow, NOT stored in DB.
      // The caller uploads them to storage and replaces with ExtractedImage[].
      _rawImages: rawImages,
    } as ExtractionResult & { _rawImages: RawImage[] }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown parse error'
    logger.error('parseDocument: Parse failed', err)
    return {
      status: 'failed',
      extractedAt: new Date().toISOString(),
      error: message,
      metadata: { pageCount: 0, wordCount: 0 },
      pages: [],
    }
  }
}

/** Transient type used during extraction — not stored in DB. */
export interface RawImage {
  name: string
  mimeType: string
  data: string // base64
  altText?: string
  extension: string
}

// ── Storage Download ─────────────────────────────────────────────

/**
 * Download a file from Supabase Storage as a Buffer.
 * Uses the admin client to bypass RLS on storage.
 */
export async function downloadFileBuffer(filePath: string): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data, error } = await adminDb.storage
    .from(COURSE_MATERIALS_BUCKET)
    .download(filePath)

  if (error || !data) {
    throw new Error(`Failed to download file: ${error?.message || 'No data returned'}`)
  }

  // Supabase download returns a Blob — convert to Buffer
  const arrayBuffer = await (data as Blob).arrayBuffer()
  return Buffer.from(arrayBuffer)
}
