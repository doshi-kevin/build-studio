// Pure, framework-agnostic canvas math for rendering annotation strokes over
// a slide image. Extracted from SlideAnnotationLayer so the same logic drives
// three renderers without drift: the live/post-class on-screen canvas overlay,
// and the client-side PDF exporter.
//
// COORDINATE SYSTEM: stroke points are stored in NORMALIZED slide coordinates —
// (0,0) top-left of the slide image, (1,1) bottom-right — invariant to viewport,
// fullscreen, and letterboxing. `computeSlideRect` maps that space onto the
// rectangle where the slide is actually painted inside a given canvas.
//
// DPR-AGNOSTIC: these helpers draw in the coordinate space of whatever transform
// the caller has already applied to `ctx`. The screen layer sets a
// devicePixelRatio transform before calling drawStrokes; the PDF exporter draws
// at native scale 1. Neither concern lives here.

import type { Stroke } from './types'

export interface SlideRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Given a canvas (CSS) size and the slide image's intrinsic aspect ratio,
 * return the rectangle where the slide is actually painted inside the canvas
 * under `object-contain`. Matches the <img> element's behavior exactly so a
 * canvas overlay's stroke coords align with what the user sees.
 */
export function computeSlideRect(
  canvasWidth: number,
  canvasHeight: number,
  slideAspect: number,
): SlideRect {
  if (canvasWidth <= 0 || canvasHeight <= 0 || slideAspect <= 0) {
    return { x: 0, y: 0, width: canvasWidth, height: canvasHeight }
  }
  const canvasAspect = canvasWidth / canvasHeight
  if (slideAspect > canvasAspect) {
    // Slide is wider than canvas → fits the canvas width, letterbox top/bottom.
    const w = canvasWidth
    const h = canvasWidth / slideAspect
    return { x: 0, y: (canvasHeight - h) / 2, width: w, height: h }
  } else {
    // Slide is taller (or equal) → fits the canvas height, pillarbox left/right.
    const h = canvasHeight
    const w = canvasHeight * slideAspect
    return { x: (canvasWidth - w) / 2, y: 0, width: w, height: h }
  }
}

/**
 * Draw a set of strokes onto `ctx`, mapping normalized slide coords into the
 * given slide rectangle. Eraser strokes (sentinel color '__eraser__') use
 * destination-out compositing so they physically subtract from existing ink
 * instead of painting over it — so callers that want a flattened image must
 * draw strokes onto a SEPARATE transparent canvas and composite that over the
 * slide image, or the eraser will punch holes through the image.
 *
 * Stroke widths are stored as if the slide were 1000px wide; they're scaled to
 * the actual slide width so visual thickness is consistent across sizes.
 * Resets globalCompositeOperation to 'source-over' before returning.
 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  slide: SlideRect,
): void {
  const widthScale = slide.width / 1000

  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue
    if (stroke.color === '__eraser__') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = 'rgba(0,0,0,1)'
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = stroke.color
    }
    ctx.lineWidth = Math.max(1, stroke.width * widthScale)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    const [first, ...rest] = stroke.points
    ctx.moveTo(slide.x + first.x * slide.width, slide.y + first.y * slide.height)
    for (const p of rest) {
      ctx.lineTo(slide.x + p.x * slide.width, slide.y + p.y * slide.height)
    }
    ctx.stroke()
  }
  // Reset compositing for the caller's next render cycle.
  ctx.globalCompositeOperation = 'source-over'
}
