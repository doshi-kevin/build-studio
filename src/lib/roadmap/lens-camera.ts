// Camera arithmetic for the professor roadmap's DOSSIER LENS — the framing the
// map takes on while the student card claims the left strip, and its inverse
// when the card closes.
//
// Extracted from RoadmapPrototype.tsx for one reason beyond testability: the
// open and close paths each need the lens' zoom step, and while they were two
// hand-written copies of `Math.max(0.8, prev.zoom * 0.85)` in two effects,
// changing the step in one place would have drifted the zoom a little on every
// open/close cycle with nothing to catch it. One definition, one inverse.
//
// Pure: no React, no @xyflow, no DOM. The caller passes the measured canvas
// size and the live viewport; `Camera` is structurally React Flow's `Viewport`.

/** React Flow's viewport, structurally — x/y are ABSOLUTE canvas pixels. */
export interface Camera {
  x: number
  y: number
  zoom: number
}

/** The lens steps the zoom down a notch so the card covers paper, not weeks. */
export const LENS_ZOOM_STEP = 0.85
/** …but never below resetView's legibility floor — under it the card titles
 *  render illegibly and the journey overlay is pointless. */
export const LENS_ZOOM_FLOOR = 0.8

/* The dossier card's own geometry (roadmap-prototype.css §21: left 24px, width
   min(344, 100% − 48px)), plus a 12px gutter. */
const CARD_LEFT = 24
const CARD_MAX_W = 344
const CARD_GUTTER = 12

/**
 * Horizontal centre of the canvas the dossier card does NOT cover — the lens'
 * framing centre. Width-derived rather than measured once because full-screening
 * the canvas moves it: a stale value leaves the spine pin holding the map
 * off-centre for the new width with no gesture left to recover x.
 */
export function freeCenterXFor(w: number): number {
  const cardRight = CARD_LEFT + Math.min(CARD_MAX_W, w - 2 * CARD_LEFT) + CARD_GUTTER
  return cardRight + (w - cardRight) / 2
}

/** The zoom the lens holds, given the camera it opened over. */
export function lensZoomFor(prevZoom: number): number {
  return Math.max(LENS_ZOOM_FLOOR, prevZoom * LENS_ZOOM_STEP)
}

/**
 * ON: pin the flow point at today's canvas centre to the free area's centre,
 * at the stepped-down zoom.
 */
export function lensFraming(prev: Camera, w: number, h: number): Camera {
  const zoom = lensZoomFor(prev.zoom)
  const px = (w / 2 - prev.x) / prev.zoom
  const py = (h / 2 - prev.y) / prev.zoom
  return { x: freeCenterXFor(w) - px * zoom, y: h / 2 - py * zoom, zoom }
}

/**
 * OFF: undo the lens' framing while KEEPING the reader's place.
 *
 * Two different things move the camera while the card is open — the lens (shift
 * + zoom step) and the reader (the map stays live under the card, unlike the
 * frozen node-modal view). Closing must undo the first and preserve the second,
 * so this inverts the framing rather than restoring the `prev` snapshot: take
 * the flow point now at the free area's centre, undo the zoom RATIO (so any
 * zoom the reader added survives), and put that point back at the canvas centre.
 *
 * INVARIANT: with no gesture in between — `cur === lensFraming(prev, w, h)` —
 * this returns `prev` exactly. The untouched case still lands where a plain
 * snapshot restore used to put it.
 *
 * `panZoom` is the canvas' Pan & zoom mode. In default mode onMove pins the
 * spine to the centre line, so the reader has no horizontal offset worth
 * inverting and landing anywhere but w/2 would be yanked there a frame later.
 */
export function unlensFraming(
  prev: Camera,
  cur: Camera,
  w: number,
  h: number,
  panZoom: boolean,
): Camera {
  const zoom = cur.zoom * (prev.zoom / lensZoomFor(prev.zoom))
  const py = (h / 2 - cur.y) / cur.zoom
  const x = panZoom ? w / 2 - ((freeCenterXFor(w) - cur.x) / cur.zoom) * zoom : w / 2
  return { x, y: h / 2 - py * zoom, zoom }
}
