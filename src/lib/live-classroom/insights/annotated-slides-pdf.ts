// Client-side, on-demand PDF export of a deck's slides with the professor's
// annotations burned in. Generated in the browser from the same data the
// viewer already holds — no server route, job, or new dependency (jspdf is
// already used elsewhere, loaded dynamically to keep it out of the main bundle).
//
// FLATTENING (important): eraser strokes use destination-out compositing, which
// subtracts from whatever is on the canvas. If we drew strokes directly onto the
// slide-image canvas, an eraser would punch transparent holes through the SLIDE
// itself. So strokes are drawn onto a separate transparent canvas, then that
// canvas is composited over the slide-image canvas — the eraser only removes
// ink, never the slide.

import { drawStrokes } from '@/lib/live-classroom/drawings/render'
import type { AnnotatedDeck } from './annotated-slides'

// JPEG (not PNG) keeps a 30-slide deck of 2×-scaled images from ballooning to
// tens of MB and crashing mobile during generation.
const JPEG_QUALITY = 0.85

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim()
  return cleaned.length > 0 ? cleaned : 'annotated-slides'
}

// Load a signed slide image for canvas use. crossOrigin is required so the
// canvas isn't tainted (private-bucket URLs are cross-origin); resolves null on
// failure so one bad slide doesn't abort the whole export.
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!url) return resolve(null)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/**
 * Generate and download a PDF of every slide in the deck, annotations overlaid.
 * One page per slide. Throws only on a jspdf/document failure; individual slide
 * image failures degrade to a labeled placeholder page.
 */
export async function downloadAnnotatedDeckPdf(deck: AnnotatedDeck, filename: string): Promise<void> {
  const { jsPDF } = await import('jspdf')

  // Fallback page size for slides whose image failed to load (16:9-ish).
  const FALLBACK_W = 1280
  const FALLBACK_H = 720

  let doc: import('jspdf').jsPDF | null = null

  for (let i = 0; i < deck.slideUrls.length; i++) {
    const img = await loadImage(deck.slideUrls[i])
    const w = img?.naturalWidth || FALLBACK_W
    const h = img?.naturalHeight || FALLBACK_H

    // Composite canvas (opaque): slide image first, then ink on top.
    const composite = document.createElement('canvas')
    composite.width = w
    composite.height = h
    const cctx = composite.getContext('2d')
    if (!cctx) continue

    if (img) {
      cctx.drawImage(img, 0, 0, w, h)
    } else {
      // Placeholder so the annotations still have a page even if the slide
      // image couldn't be fetched.
      cctx.fillStyle = '#f4f4f5'
      cctx.fillRect(0, 0, w, h)
      cctx.fillStyle = '#71717a'
      cctx.font = '32px sans-serif'
      cctx.textAlign = 'center'
      cctx.fillText('Slide image unavailable', w / 2, h / 2)
    }

    const strokes = deck.strokesBySlide[i]
    if (strokes && strokes.length > 0) {
      // Separate transparent layer for the ink so destination-out erasers only
      // subtract ink, never the slide underneath.
      const inkCanvas = document.createElement('canvas')
      inkCanvas.width = w
      inkCanvas.height = h
      const ictx = inkCanvas.getContext('2d')
      if (ictx) {
        drawStrokes(ictx, strokes, { x: 0, y: 0, width: w, height: h })
        cctx.drawImage(inkCanvas, 0, 0)
      }
    }

    const dataUrl = composite.toDataURL('image/jpeg', JPEG_QUALITY)

    // jsPDF force-swaps [w, h] to match the orientation, so a hardcoded
    // 'portrait' turns a 1920×1080 slide into a 1080×1920 page and clips it.
    const orientation = w >= h ? 'landscape' : 'portrait'
    if (!doc) {
      doc = new jsPDF({ unit: 'px', format: [w, h], orientation })
    } else {
      doc.addPage([w, h], orientation)
    }
    doc.addImage(dataUrl, 'JPEG', 0, 0, w, h, undefined, 'FAST')
  }

  if (!doc) return
  doc.save(`${sanitizeFilename(filename)}.pdf`)
}
