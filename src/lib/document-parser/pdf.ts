// Non-AI PDF extractor. Replaces officeparser for PDFs. Uses pdfjs-dist
// directly for text (getTextContent) and walks each page's operator
// list for image XObjects, resolving them from both page.objs and
// page.commonObjs (shared across pages — officeparser misses ~5/27 of
// these without the retry (benchmark doc no longer in the repo)
// experiment 12). sharp encodes raw RGBA/RGB/gray → PNG. Each image
// streams to Supabase Storage then the buffer is released so memory
// stays bounded (experiment 17 confirmed 312 MB peak RSS on a 91-page
// 2.1 MB PDF under a 512 MB cap — safe on 1 GB Cloud Run).
//
// Text is sorted top→bottom / left→right with a 2pt y tolerance so the
// raw-stream reading order (which is often wrong for slides with
// sidebar call-outs) doesn't garble paragraphs. Images >16 MP are
// skipped with a warning rather than fed to sharp, which prevents an
// OOM on pathological scanned slides.

import { createHash } from 'node:crypto'
import path from 'path'
import sharp from 'sharp'
import type { SupabaseClient } from '@supabase/supabase-js'

import { createAdminClient } from '@/lib/supabase/admin'
import { COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { logger } from '@/lib/logger'
import type {
  ExtractionResultData,
  ExtractedImageData,
  ExtractedTableData,
  ExtractionPageData,
} from '@/lib/validations/document-extraction'
import { detectTablesForPage, type RawPath, type TextBox } from './pdf-tables'

// ── Worker path resolution ─────────────────────────────────────
// pdfjs-dist's worker is a separate .mjs file. Next.js bundler would
// mangle a require.resolve() call, so we resolve from cwd() at runtime.
// This matches the pattern in the legacy index.ts.
const PDF_WORKER_SRC = path.join(
  process.cwd(),
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
)

// ── Limits ─────────────────────────────────────────────────────
/** Skip images whose raw pixel count exceeds this. Guards sharp against OOM. */
const DEFAULT_MAX_IMAGE_PIXELS = 16_000_000 // 16 MP

/**
 * Per-page cap on ruling-line path coordinates collected for table detection.
 * A real ruled table is tens of lines; this bounds a maliciously vector-heavy
 * PDF (CWE-400) so it can't exhaust the extraction worker. Tables on a page that
 * blows the cap are simply not detected geometrically (text still extracts).
 */
const MAX_PAGE_PATH_COORDS = 500_000

/** Per-dep timeout when pulling an image XObject from the pdfjs worker. */
const OBJ_RESOLVE_TIMEOUT_MS = 500

/** Y-axis tolerance for grouping text items into the same visual line. */
const LINE_Y_TOLERANCE_PT = 2

// ── Types ──────────────────────────────────────────────────────

export interface ExtractPdfOptions {
  /** Course section id — used in the Storage path. */
  sectionId: string
  /** Module item id — used in the Storage path. */
  moduleItemId: string
  /** Override the 16 MP guard (e.g. for test fixtures with larger images). */
  maxImagePixels?: number
  /** Inject a pre-made admin client (tests). Defaults to createAdminClient(). */
  adminClient?: SupabaseClient
  /** Override storage bucket (tests). Defaults to course-materials. */
  storageBucket?: string
}

export type ExtractPdfResult = ExtractionResultData

// ── Types for pdfjs bits we touch ──────────────────────────────
// pdfjs-dist ships types, but they're awkward for our runtime usage
// (especially page.objs which is an internal). Narrow interfaces
// keep the rest of the file honest without pulling in all of pdfjs.
interface PdfTextItem {
  str: string
  transform: number[]
  width: number
  height: number
  fontName?: string
  hasEOL?: boolean
}

interface PdfImageObj {
  data?: Uint8Array | Uint8ClampedArray
  width: number
  height: number
  kind?: number // 1 = grayscale, 2 = RGB, 3 = RGBA (pdfjs' ImageKind enum)
}

type PdfOpsArg = unknown

interface PdfObjStore {
  has(name: string): boolean
  get(name: string, cb: (data: PdfImageObj | null) => void): void
}

// ── Small helpers ──────────────────────────────────────────────

/** Multiply two PDF affine matrices (stored as [a,b,c,d,e,f]). */
function matMul(a: number[], b: number[]): number[] {
  return [
    b[0] * a[0] + b[1] * a[2],
    b[0] * a[1] + b[1] * a[3],
    b[2] * a[0] + b[3] * a[2],
    b[2] * a[1] + b[3] * a[3],
    b[4] * a[0] + b[5] * a[2] + a[4],
    b[4] * a[1] + b[5] * a[3] + a[5],
  ]
}

/** Wrap page.objs.get / page.commonObjs.get in a timeout-safe promise. */
function waitForObj(
  store: PdfObjStore,
  name: string,
  timeoutMs = OBJ_RESOLVE_TIMEOUT_MS,
): Promise<PdfImageObj | null> {
  return new Promise((resolve) => {
    let done = false
    const to = setTimeout(() => {
      if (!done) {
        done = true
        resolve(null)
      }
    }, timeoutMs)
    try {
      store.get(name, (data) => {
        if (!done) {
          done = true
          clearTimeout(to)
          resolve(data)
        }
      })
    } catch {
      if (!done) {
        done = true
        clearTimeout(to)
        resolve(null)
      }
    }
  })
}

async function resolveImageObj(
  pageObjs: PdfObjStore,
  commonObjs: PdfObjStore,
  name: string,
): Promise<PdfImageObj | null> {
  if (pageObjs.has(name)) {
    const o = await new Promise<PdfImageObj | null>((r) => pageObjs.get(name, r))
    if (o?.data) return o
  }
  if (commonObjs.has(name)) {
    const o = await new Promise<PdfImageObj | null>((r) => commonObjs.get(name, r))
    if (o?.data) return o
  }
  const o1 = await waitForObj(pageObjs, name)
  if (o1?.data) return o1
  const o2 = await waitForObj(commonObjs, name)
  if (o2?.data) return o2
  return null
}

/**
 * Content hash of a decoded image, used to drop exact duplicates within a
 * single document. Keyed on dimensions + pixel kind so two differently-shaped
 * buffers can never collide, then the raw pixel bytes. sha256 is deterministic,
 * so a reused XObject hashes identically on every page. This is intentionally
 * NOT a perceptual hash: near-duplicates (annotated slide sequences, before/after
 * frames) must hash differently so they're kept, not merged — see issue #556.
 */
export function imageContentHash(img: PdfImageObj): string {
  return createHash('sha256')
    .update(`${img.width}x${img.height}x${img.kind ?? 0}:`)
    .update(Buffer.from(img.data as Uint8Array))
    .digest('hex')
}

/** Encode a raw pdfjs image buffer as PNG via sharp. */
async function encodeImagePng(img: PdfImageObj): Promise<Buffer> {
  const channels = img.kind === 1 ? 1 : img.kind === 2 ? 3 : 4
  return await sharp(Buffer.from(img.data as Uint8Array), {
    raw: { width: img.width, height: img.height, channels },
  })
    .png({ compressionLevel: 6 })
    .toBuffer()
}

/**
 * Sort text items in visual reading order.
 *
 * pdfjs returns items in content-stream order, which for slides
 * exported from PowerPoint often interleaves callouts, headers, and
 * main body text. This sort groups items by line (y within tolerance)
 * and then left-to-right within each line.
 *
 * PDF native coords have y increasing upward, so we sort y descending.
 */
function sortReadingOrder(items: PdfTextItem[]): PdfTextItem[] {
  return [...items].sort((a, b) => {
    const [, , , , , aY] = a.transform
    const [, , , , aX] = a.transform
    const [, , , , , bY] = b.transform
    const [, , , , bX] = b.transform
    const dy = bY - aY
    if (Math.abs(dy) > LINE_Y_TOLERANCE_PT) return dy
    return aX - bX
  })
}

// ── Main extractor ─────────────────────────────────────────────

/**
 * Extract text and images from a PDF buffer. Images are streamed to
 * Supabase Storage as they're produced — the returned ExtractedImage
 * entries carry storage paths and public URLs, not image bytes.
 */
export async function extractPdf(
  buffer: Buffer,
  opts: ExtractPdfOptions,
): Promise<ExtractPdfResult> {
  const startedAt = Date.now()
  const admin = opts.adminClient ?? createAdminClient()
  const bucket = opts.storageBucket ?? COURSE_MATERIALS_BUCKET
  const maxImagePixels = opts.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS
  const storageFolder = `extracted-images/${opts.sectionId}/${opts.moduleItemId}`

  // Dynamic import: pdfjs-dist is `serverExternalPackages`d and has a
  // hefty init path — we want to defer loading until the first PDF hits.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC

  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null

  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    }).promise

    const OPS = pdfjs.OPS
    const pages: ExtractionPageData[] = []
    const images: ExtractedImageData[] = []
    const tables: ExtractedTableData[] = []
    // Content hashes of images already emitted, document-wide. Slides reuse
    // the same figure across pages (a diagram repeated with the slide chrome,
    // a recap later on); pdfjs hands us byte-identical decoded pixels each
    // time, so hashing the raw buffer collapses exact duplicates to the first
    // occurrence and skips the redundant sharp encode + upload. Measured on 8
    // real course decks this removes ~9% of extracted images with zero false
    // positives. Near-duplicate (annotated-sequence) collapsing is deliberately
    // NOT done: on the same decks perceptual matching merged distinct teaching
    // frames (before/after DOM output, different alert text) — see issue #556.
    const seenImageHashes = new Set<string>()
    // Pages with a borderless/merged/low-confidence table geometry can't trust —
    // routed to the VLM by the worker (Phase 3b), then this list is cleared.
    const tableVisionPages: number[] = []
    let totalWords = 0
    const docMetadata: { title?: string; author?: string } = {}

    try {
      const meta = await doc.getMetadata()
      const info = meta.info as { Title?: string; Author?: string } | undefined
      if (info?.Title) docMetadata.title = info.Title
      if (info?.Author) docMetadata.author = info.Author
    } catch {
      // Metadata is best-effort — no-op if the PDF has none.
    }

    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      if (pageNo === 1 || pageNo % 10 === 0) {
      }
      const page = await doc.getPage(pageNo)

      // ── Text extraction ──
      const tc = await page.getTextContent({ includeMarkedContent: false })
      const textItems: PdfTextItem[] = []
      for (const raw of tc.items) {
        // pdfjs TextContent is TextItem | TextMarkedContent; only TextItem
        // has .str. Narrow by duck-typing — the union's branches don't
        // share a common field we can discriminate on cleanly.
        const candidate = raw as Partial<PdfTextItem>
        if (typeof candidate.str === 'string' && Array.isArray(candidate.transform)) {
          textItems.push(candidate as PdfTextItem)
        }
      }
      const sorted = sortReadingOrder(textItems)
      const pageText = sorted.map((it) => it.str).join('').trim()
      totalWords += pageText.split(/\s+/).filter(Boolean).length

      pages.push({
        pageNumber: pageNo,
        text: pageText,
        headings: [], // headings detection is a v2 concern; see plan file
      })

      // ── Image extraction: pre-warm deps, then walk ops with CTM ──
      const ops = await page.getOperatorList()
      for (let j = 0; j < ops.fnArray.length; j++) {
        if (ops.fnArray[j] !== OPS.dependency) continue
        const deps = ops.argsArray[j] as string[]
        for (const dep of deps) {
          if (!/^img_/.test(dep)) continue
          const pageObjs = page.objs as unknown as PdfObjStore
          const commonObjs = page.commonObjs as unknown as PdfObjStore
          if (!pageObjs.has(dep) && !commonObjs.has(dep)) {
            await Promise.all([
              waitForObj(pageObjs, dep),
              waitForObj(commonObjs, dep),
            ])
          }
        }
      }

      const ctmStack: number[][] = [[1, 0, 0, 1, 0, 0]]
      let pageImageIndex = 0
      const pagePaths: RawPath[] = [] // ruling-line paths for table detection
      let pagePathCoords = 0 // running coord budget (DoS guard, MAX_PAGE_PATH_COORDS)

      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i]
        const args = ops.argsArray[i] as PdfOpsArg[]
        if (fn === OPS.save) {
          ctmStack.push([...ctmStack[ctmStack.length - 1]])
        } else if (fn === OPS.restore) {
          if (ctmStack.length > 1) ctmStack.pop()
        } else if (fn === OPS.transform) {
          const m = args as number[]
          ctmStack[ctmStack.length - 1] = matMul(ctmStack[ctmStack.length - 1], m)
        } else if (fn === OPS.constructPath) {
          // Collect path coords (flat [segType,x,y,...]) for table-line detection.
          // pdfjs encodes constructPath args as [opMask, [Float32Array coords], minMax].
          if (pagePathCoords < MAX_PAGE_PATH_COORDS) {
            const a1 = args[1]
            const rawCoords = Array.isArray(a1) ? (a1 as unknown[])[0] : a1
            if (rawCoords) {
              const coords = Array.from(rawCoords as ArrayLike<number>)
              pagePathCoords += coords.length
              pagePaths.push({ coords, ctm: [...ctmStack[ctmStack.length - 1]] })
            }
          }
        } else if (fn === OPS.paintImageXObject || fn === OPS.paintXObject) {
          const imgName = args[0] as string
          const ctm = ctmStack[ctmStack.length - 1]
          const pageObjs = page.objs as unknown as PdfObjStore
          const commonObjs = page.commonObjs as unknown as PdfObjStore

          const imgObj = await resolveImageObj(pageObjs, commonObjs, imgName)
          if (!imgObj || !imgObj.data) continue

          // OOM guard: skip over-sized images rather than hand them to sharp.
          if (imgObj.width * imgObj.height > maxImagePixels) {
            logger.warn('extractPdf: skipping oversized image', {
              moduleItemId: opts.moduleItemId,
              pageNumber: pageNo,
              pixelCount: imgObj.width * imgObj.height,
              limit: maxImagePixels,
            })
            continue
          }

          // Skip exact duplicates already emitted for this document. The hash is
          // recorded only after a successful upload below (not here), so a transient
          // encode/upload failure on the first occurrence doesn't permanently
          // suppress a later, identical occurrence that could have succeeded.
          const imgHash = imageContentHash(imgObj)
          if (seenImageHashes.has(imgHash)) continue

          let pngBuffer: Buffer
          try {
            pngBuffer = await encodeImagePng(imgObj)
          } catch (err) {
            logger.warn('extractPdf: sharp encode failed', {
              moduleItemId: opts.moduleItemId,
              pageNumber: pageNo,
              error: err instanceof Error ? err.message : String(err),
            })
            continue
          }

          pageImageIndex += 1
          const filename = `page${String(pageNo).padStart(3, '0')}_img${pageImageIndex}.png`
          const storagePath = `${storageFolder}/${filename}`

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: uploadErr } = await (admin as any).storage
            .from(bucket)
            .upload(storagePath, pngBuffer, {
              contentType: 'image/png',
              cacheControl: '31536000',
              upsert: true,
            })
          if (uploadErr) {
            logger.warn('extractPdf: storage upload failed', {
              moduleItemId: opts.moduleItemId,
              pageNumber: pageNo,
              storagePath,
              error: uploadErr.message,
            })
            continue
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: pub } = (admin as any).storage
            .from(bucket)
            .getPublicUrl(storagePath)

          images.push({
            pageNumber: pageNo,
            storagePath,
            storageUrl: pub.publicUrl,
            bbox: {
              x: +ctm[4].toFixed(1),
              y: +ctm[5].toFixed(1),
              width: +Math.abs(ctm[0] || ctm[2]).toFixed(1),
              height: +Math.abs(ctm[3] || ctm[1]).toFixed(1),
            },
            pixelWidth: imgObj.width,
            pixelHeight: imgObj.height,
            bytes: pngBuffer.length,
          })
          // Record the hash only now that the image is actually emitted, so
          // duplicates are skipped but a failed earlier occurrence isn't final.
          seenImageHashes.add(imgHash)
          // pngBuffer goes out of scope next iteration — GC reclaims it.
        }
      }

      // ── Table detection: deterministic geometric grid, or flag to VLM ──
      try {
        const textBoxes: TextBox[] = sorted.map((it) => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
          h: it.height,
        }))
        const det = detectTablesForPage(pagePaths, textBoxes, pageNo)
        tables.push(...det.tables)
        if (det.flagForVision) tableVisionPages.push(pageNo)
      } catch (err) {
        logger.warn('extractPdf: table detection failed', {
          moduleItemId: opts.moduleItemId,
          pageNumber: pageNo,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      page.cleanup()
    }


    return {
      status: 'completed',
      extractedAt: new Date(startedAt).toISOString(),
      error: null,
      metadata: {
        pageCount: doc.numPages,
        wordCount: totalWords,
        imageCount: images.length,
        ...docMetadata,
      },
      pages,
      images: images.length > 0 ? images : undefined,
      tables: tables.length > 0 ? tables : undefined,
      tableVisionPages: tableVisionPages.length > 0 ? tableVisionPages : undefined,
      textStatus: 'completed',
      imagesStatus: 'completed',
      tablesStatus: 'completed',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown PDF parse error'
    logger.error('extractPdf: parse failed', err, { moduleItemId: opts.moduleItemId })
    return {
      status: 'failed',
      extractedAt: new Date(startedAt).toISOString(),
      error: message,
      metadata: { pageCount: 0, wordCount: 0 },
      pages: [],
      textStatus: 'failed',
      imagesStatus: 'failed',
      formulasStatus: 'failed',
      tablesStatus: 'failed',
    }
  } finally {
    if (doc) {
      try {
        await doc.cleanup()
        await doc.destroy()
      } catch {
        // Best-effort cleanup — don't mask a real error with a teardown error.
      }
    }
  }
}
