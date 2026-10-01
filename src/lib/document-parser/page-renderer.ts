// Renders individual PDF pages to PNG or WebP via pdfjs-dist + @napi-rs/canvas.
// Used by vision path (PR 4) and live classroom slide rendering.
// Supports format option: 'png' (default, backwards compat) or 'webp' (30% smaller).
//
// A 1920×1080 page renders in ~50 ms on dev hardware (experiment 13).
// Page rasters are transient: emit buffer → hand to vision → drop.
// Do not persist these to Storage — the original PDF is already stored
// and its images get extracted via pdf.ts.

import path from 'path'
import { createCanvas, DOMMatrix } from '@napi-rs/canvas'

// pdfjs-dist expects a global DOMMatrix when rendering. @napi-rs/canvas
// exposes a compatible implementation — assign once at module load so
// every renderPage call doesn't have to do it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMMatrix = (globalThis as any).DOMMatrix ?? DOMMatrix

const PDF_WORKER_SRC = path.join(
  process.cwd(),
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
)

/** Supported output formats for rendered pages. */
export type RenderFormat = 'png' | 'webp'

export interface RenderPageOptions {
  /** 1-indexed page number. */
  pageNumber: number
  /**
   * Rendering scale. 2 doubles the DPI vs native (roughly 144 DPI at
   * typical slide dimensions) — plenty for vision formula extraction
   * without blowing up token cost.
   *
   * Effective scale is clamped so the rendered image stays below
   * ~15 MP — Gemini's vision input has a practical ceiling around
   * 20 MB for PNG which in turn is roughly a 4500×4500 image. Clamping
   * protects us from pathological print-to-PDF decks built at 300 DPI.
   */
  scale?: number
  /**
   * Output format. Defaults to 'png' for backwards compatibility.
   * 'webp' produces ~30% smaller files, suitable for live classroom slides.
   */
  format?: RenderFormat
}

/** Gemini vision inputs must stay well under ~20 MB. 15 MP × ~1 B/px
 * compressed ≈ 5-15 MB PNGs, comfortably inside. */
const MAX_RENDERED_PIXELS = 15_000_000

export interface RenderedPage {
  pageNumber: number
  width: number
  height: number
  /** Page size in PDF points (scale-1 viewport) — lets callers map
   *  point-space bboxes onto the rendered pixels regardless of the
   *  effective scale (which the MAX_RENDERED_PIXELS clamp can shrink). */
  pointsWidth: number
  pointsHeight: number
  /** @deprecated Use `buffer` instead. Kept for backwards compatibility. */
  png: Buffer
  /** The rendered image buffer (PNG or WebP depending on format option). */
  buffer: Buffer
  /** MIME type of the rendered image ('image/png' or 'image/webp'). */
  mimeType: string
}

/**
 * NodeCanvasFactory — pdfjs's CanvasFactory contract, backed by
 * @napi-rs/canvas. pdfjs uses this to allocate and reset the canvas
 * used during rendering.
 */
class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height)
    return { canvas, context: canvas.getContext('2d') }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reset(target: any, width: number, height: number) {
    target.canvas.width = width
    target.canvas.height = height
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  destroy(target: any) {
    target.canvas.width = 0
    target.canvas.height = 0
    target.canvas = null
    target.context = null
  }
}

/**
 * Render one or more pages of a PDF buffer to PNG or WebP. Passing an array
 * of page numbers lets us amortize the `getDocument()` cost across
 * all pages rather than re-opening the PDF per call.
 *
 * @param buffer - PDF file buffer
 * @param pageNumbers - Array of 1-indexed page numbers to render
 * @param scale - Rendering scale (default 2)
 * @param format - Output format: 'png' (default) or 'webp'
 */
export async function renderPdfPages(
  buffer: Buffer,
  pageNumbers: number[],
  scale = 2,
  format: RenderFormat = 'png',
): Promise<RenderedPage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC

  const factory = new NodeCanvasFactory()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    CanvasFactory: NodeCanvasFactory as any,
  }).promise

  const rendered: RenderedPage[] = []
  try {
    for (const pn of pageNumbers) {
      if (pn < 1 || pn > doc.numPages) continue
      const page = await doc.getPage(pn)
      const base = page.getViewport({ scale: 1 })
      let viewport = page.getViewport({ scale })
      // Clamp to keep rendered pixel count under the vision limit.
      // For a 1000×750 page at scale=2 → 2000×1500 = 3 MP (fine). For
      // a 2550×3300 page at scale=2 → 16.8 MP (too big). We scale
      // down proportionally and log so pathological inputs are visible.
      const pixels = viewport.width * viewport.height
      if (pixels > MAX_RENDERED_PIXELS) {
        const shrink = Math.sqrt(MAX_RENDERED_PIXELS / pixels)
        const adjustedScale = scale * shrink
        viewport = page.getViewport({ scale: adjustedScale })
      }
      const canvasAndContext = factory.create(viewport.width, viewport.height)
      // The public RenderParameters type on pdfjs-dist omits
      // `canvasFactory`, but the runtime accepts (and needs) it in
      // Node — without it, pdfjs tries to use a browser DOM canvas.
      await page.render({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        canvasContext: canvasAndContext.context as any,
        viewport,
        canvasFactory: factory,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any).promise
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const encoded = await (canvasAndContext.canvas as any).encode(format)
      const imgBuffer = Buffer.from(encoded)
      const mimeType = format === 'webp' ? 'image/webp' : 'image/png'
      rendered.push({
        pageNumber: pn,
        width: viewport.width,
        height: viewport.height,
        pointsWidth: base.width,
        pointsHeight: base.height,
        png: imgBuffer, // backwards compat
        buffer: imgBuffer,
        mimeType,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory.destroy(canvasAndContext as any)
      page.cleanup()
    }
  } finally {
    try {
      await doc.cleanup()
      await doc.destroy()
    } catch {
      // best-effort teardown
    }
  }

  return rendered
}

/** Convenience wrapper for rendering a single page. */
export async function renderPdfPage(
  buffer: Buffer,
  opts: RenderPageOptions,
): Promise<RenderedPage | null> {
  const scale = opts.scale ?? 2
  const format = opts.format ?? 'png'
  const result = await renderPdfPages(buffer, [opts.pageNumber], scale, format)
  return result[0] ?? null
}
