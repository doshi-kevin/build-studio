// Real files for the demo: generated PDFs (lecture slide decks and handouts),
// uploads into the same Storage buckets and paths the app itself writes, and the
// per-page WebP render that the Live Classroom viewer reads.
//
// Rendering is best-effort. If pdfjs or the canvas binding fails on this
// machine, the caller seeds the deck row without slide images and the run
// carries on — a missing deck is a smaller problem than a failed seed.

import { jsPDF } from 'jspdf'
import { db, warn } from './context'

export interface Slide {
  heading: string
  bullets: string[]
}

const PAGE_W = 960
const PAGE_H = 540

/** A plain, legible slide deck. Deliberately text-only: it is demo scaffolding,
 *  not a design artifact, and it has to render identically everywhere. */
export function makeSlidePdf(deckTitle: string, subtitle: string, slides: Slide[]): Buffer {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'px', format: [PAGE_W, PAGE_H] })

  doc.setFillColor(15, 23, 42)
  doc.rect(0, 0, PAGE_W, PAGE_H, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(40)
  doc.text(doc.splitTextToSize(deckTitle, PAGE_W - 120), 60, 230)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(20)
  doc.setTextColor(148, 163, 184)
  doc.text(subtitle, 60, 300)

  for (const slide of slides) {
    doc.addPage([PAGE_W, PAGE_H], 'landscape')
    doc.setFillColor(255, 255, 255)
    doc.rect(0, 0, PAGE_W, PAGE_H, 'F')
    doc.setFillColor(37, 99, 235)
    doc.rect(0, 0, PAGE_W, 8, 'F')

    doc.setTextColor(15, 23, 42)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(30)
    doc.text(doc.splitTextToSize(slide.heading, PAGE_W - 120), 60, 100)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(19)
    doc.setTextColor(51, 65, 85)
    let y = 180
    for (const b of slide.bullets) {
      const lines = doc.splitTextToSize(`•  ${b}`, PAGE_W - 140) as string[]
      doc.text(lines, 70, y)
      y += lines.length * 28 + 10
    }
  }
  return Buffer.from(doc.output('arraybuffer'))
}

export interface HandoutPage {
  pageNumber: number
  text: string
  headings: string[]
}

export interface HandoutResult {
  buffer: Buffer
  /** One entry per real PDF page, built from the exact same layout pass —
   *  so a citation naming a page number always matches what's actually on
   *  that page, instead of a second, independently-guessed mapping. */
  pages: HandoutPage[]
}

/** A multi-page text handout, used for module lecture materials. */
export function makeHandoutPdf(title: string, sections: Array<{ heading: string; body: string }>): HandoutResult {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' })
  const W = doc.internal.pageSize.getWidth()
  const M = 64
  let y = 96

  const pages: HandoutPage[] = [{ pageNumber: 1, text: '', headings: [] }]
  const current = () => pages[pages.length - 1]
  const startPage = () => { pages.push({ pageNumber: pages.length + 1, text: '', headings: [] }) }
  const append = (s: string) => { current().text = current().text ? `${current().text} ${s}` : s }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  const titleLines = doc.splitTextToSize(title, W - M * 2) as string[]
  doc.text(titleLines, M, y)
  current().headings.push(title)
  append(title)
  // Advance by the lines actually drawn — a fixed 40 meant a title that wrapped
  // to two lines collided with the first heading underneath it.
  y += titleLines.length * 26 + 18

  for (const s of sections) {
    if (y > 660) { doc.addPage(); y = 96; startPage() }
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(14)
    doc.text(s.heading, M, y)
    current().headings.push(s.heading)
    append(s.heading)
    y += 22
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(11)
    const lines = doc.splitTextToSize(s.body, W - M * 2) as string[]
    for (const line of lines) {
      if (y > 720) { doc.addPage(); y = 96; startPage() }
      doc.text(line, M, y)
      append(line)
      y += 16
    }
    y += 18
  }
  return { buffer: Buffer.from(doc.output('arraybuffer')), pages }
}

// ── Storage ───────────────────────────────────────────────────────────

export async function upload(
  bucket: string,
  path: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await db.storage.from(bucket).upload(path, body, { contentType, upsert: true })
  if (error) throw new Error(`upload ${bucket}/${path}: ${error.message}`)
}

/** A long-lived signed URL, matching what the app stores in module item content. */
export async function signedUrl(bucket: string, path: string, seconds = 60 * 60 * 24 * 365): Promise<string> {
  const { data, error } = await db.storage.from(bucket).createSignedUrl(path, seconds)
  if (error || !data) throw new Error(`sign ${bucket}/${path}: ${error?.message ?? 'no url'}`)
  return data.signedUrl
}

/**
 * Render every page of `pdf` to WebP and upload it as `{prefix}/page-{n}.webp`,
 * which is the layout the deck viewer reads. Returns the page count, or null
 * when rendering is unavailable here.
 */
export async function renderDeckPages(
  pdf: Buffer,
  bucket: string,
  prefix: string,
  pageCount: number,
): Promise<number | null> {
  try {
    const { renderPdfPages } = await import('@/lib/document-parser/page-renderer')
    const pages = Array.from({ length: pageCount }, (_, i) => i + 1)
    const rendered = await renderPdfPages(pdf, pages, 1.6, 'webp')
    if (rendered.length === 0) return null
    for (const page of rendered) {
      await upload(bucket, `${prefix}/page-${page.pageNumber}.webp`, page.buffer, 'image/webp')
    }
    return rendered.length
  } catch (err) {
    warn(`slide render unavailable (${(err as Error).message}) — decks seeded without images`)
    return null
  }
}

/** A small real JPEG for a proctoring violation snapshot — @napi-rs/canvas is
 *  already a transitive dep of the app's own PDF pipeline (next.config.ts
 *  serverExternalPackages), so this reuses it rather than embedding a static
 *  blob. Best-effort like renderDeckPages: a failed canvas binding on this
 *  machine should drop the one snapshot, not the whole seed run. */
export async function placeholderSnapshotJpeg(label: string): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(320, 240)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#111827'
  ctx.fillRect(0, 0, 320, 240)
  ctx.fillStyle = '#374151'
  ctx.fillRect(0, 200, 320, 40)
  ctx.fillStyle = '#f9fafb'
  ctx.font = 'bold 14px sans-serif'
  ctx.fillText(label, 12, 226)
  return canvas.toBuffer('image/jpeg')
}

/** Remove every object under `prefix`. Postgres cascades do not touch Storage,
 *  so without this a --reset leaves the buckets full of orphans. */
export async function deleteStoragePrefix(bucket: string, prefix: string): Promise<number> {
  let removed = 0
  const walk = async (dir: string): Promise<void> => {
    const { data, error } = await db.storage.from(bucket).list(dir, { limit: 1000 })
    if (error || !data) return
    const files: string[] = []
    for (const entry of data) {
      const full = dir ? `${dir}/${entry.name}` : entry.name
      // A folder has no id in the list response; recurse into it.
      if (entry.id === null) await walk(full)
      else files.push(full)
    }
    if (files.length > 0) {
      await db.storage.from(bucket).remove(files)
      removed += files.length
    }
  }
  await walk(prefix)
  return removed
}
