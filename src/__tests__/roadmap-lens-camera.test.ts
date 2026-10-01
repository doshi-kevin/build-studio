// Dossier-lens camera arithmetic (src/lib/roadmap/lens-camera.ts).
//
// These do NOT restate the formulas — they assert the two properties the
// formulas exist to satisfy, either of which can break while every line still
// looks plausible:
//
// 1. ROUND TRIP. Open the lens, close it without touching the map, and the
//    camera must land exactly where it started. The close path does not restore
//    the snapshot it took on open (a reader who scrolled would be teleported);
//    it re-derives the position by inverting the framing, so "unmoved returns to
//    prev" is a claim about the arithmetic, not a tautology. A sign flip, a
//    forgotten zoom ratio, or a zoom step that stops matching between the two
//    directions all surface here — and as a drift of a few percent per cycle,
//    which is exactly the kind of thing that ships.
// 2. THE READER'S PLACE SURVIVES. Whatever they zoomed or scrolled to under the
//    card is kept, and only the lens' own shift + zoom step is undone. The bug
//    this replaced ("sometimes it doesn't come back") was the opposite trade:
//    any gesture and the close restored nothing at all, leaving the map parked
//    off-centre at the reduced zoom with no horizontal gesture left to fix it.
//
// Widths cover the two the fix was measured at in the browser (1600, 2560) plus
// a narrow canvas where the card's own width clamp kicks in.

import { describe, it, expect } from 'vitest'
import {
  freeCenterXFor,
  lensFraming,
  lensZoomFor,
  unlensFraming,
  LENS_ZOOM_FLOOR,
  type Camera,
} from '@/lib/roadmap/lens-camera'

const SIZES: [number, number][] = [[1600, 900], [2560, 1400], [1024, 768], [420, 700]]

/** Cameras worth opening the lens over. */
const PREVS: Camera[] = [
  { x: 800, y: -1200, zoom: 1 },        // resetView-ish
  { x: 350, y: 0, zoom: 1.6 },          // zoomed in
  { x: -240, y: 640, zoom: 0.94 },      // step lands just above the floor
  { x: 120, y: -80, zoom: 0.9 },        // step lands just BELOW it → clamped
  { x: 0, y: 0, zoom: 0.5 },            // already under the floor: the lens
]                                        // zooms IN, and close must undo that too

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6)
const sameCamera = (got: Camera, want: Camera) => {
  near(got.x, want.x); near(got.y, want.y); near(got.zoom, want.zoom)
}

describe('lens camera — round trip', () => {
  it('returns the exact camera it opened over when nothing moved', () => {
    for (const [w, h] of SIZES) {
      for (const prev of PREVS) {
        const framed = lensFraming(prev, w, h)
        sameCamera(unlensFraming(prev, framed, w, h, true), prev)
      }
    }
  })

  it('undoes the zoom step in both directions, including at the legibility floor', () => {
    // The floor is the trap: `prev.zoom * step` below it clamps, so the close
    // path cannot divide by the step — it has to divide by the zoom the lens
    // ACTUALLY held. A clamped open and a naive close drift apart every cycle.
    const clamped = { x: 120, y: -80, zoom: 0.9 }
    expect(lensZoomFor(clamped.zoom)).toBe(LENS_ZOOM_FLOOR)
    expect(lensZoomFor(1.6)).toBeCloseTo(1.36, 6)

    const framed = lensFraming(clamped, 1600, 900)
    expect(framed.zoom).toBe(LENS_ZOOM_FLOOR)
    expect(unlensFraming(clamped, framed, 1600, 900, true).zoom).toBeCloseTo(0.9, 6)
  })

  it('survives repeated open/close cycles without drifting', () => {
    // Any per-cycle error compounds; ten cycles turns a 1% slip into ~10%.
    let cam: Camera = { x: 640, y: -900, zoom: 1.2 }
    for (let i = 0; i < 10; i++) {
      cam = unlensFraming(cam, lensFraming(cam, 2560, 1400), 2560, 1400, true)
    }
    sameCamera(cam, { x: 640, y: -900, zoom: 1.2 })
  })
})

describe('lens camera — the reader keeps their place', () => {
  const w = 1600, h = 900
  const prev: Camera = { x: 800, y: -1200, zoom: 1 }

  it('keeps zoom the reader added under the card, on top of undoing the lens step', () => {
    const framed = lensFraming(prev, w, h)
    // they pinch-zoomed in 25% while reading
    const moved: Camera = { ...framed, zoom: framed.zoom * 1.25 }
    expect(unlensFraming(prev, moved, w, h, true).zoom).toBeCloseTo(prev.zoom * 1.25, 6)
  })

  it('keeps the flow point the reader scrolled to, rather than snapping back to prev', () => {
    const framed = lensFraming(prev, w, h)
    // scrolled 500px of canvas down the map
    const moved: Camera = { ...framed, y: framed.y - 500 }
    const out = unlensFraming(prev, moved, w, h, true)

    expect(out.y).not.toBeCloseTo(prev.y, 1) // NOT a snapshot restore
    // the flow point under the canvas centre is the same before and after close
    const centreBefore = (h / 2 - moved.y) / moved.zoom
    const centreAfter = (h / 2 - out.y) / out.zoom
    near(centreAfter, centreBefore)
  })

  it('inverts the reader\'s horizontal offset in Pan & zoom, and ignores it in default mode', () => {
    const framed = lensFraming(prev, w, h)
    const moved: Camera = { ...framed, x: framed.x - 300 }

    // Pan & zoom: the offset is theirs to keep. Kept in WORLD units, not canvas
    // pixels — the whole point of closing is that the zoom changes, so the flow
    // point they had under the free area's centre is what must land under the
    // canvas centre. (Asserting "x moves by 300" would be wrong: at the lens'
    // 0.85 that pan is ~353 world units.)
    const panned = unlensFraming(prev, moved, w, h, true)
    near((w / 2 - panned.x) / panned.zoom, (freeCenterXFor(w) - moved.x) / moved.zoom)
    expect(panned.x).toBeLessThan(prev.x) // and in their direction, not mirrored

    // Default mode: onMove pins the spine to the centre line, so any other
    // landing x is yanked to w/2 a frame later — land there deliberately.
    expect(unlensFraming(prev, moved, w, h, false).x).toBe(w / 2)
    // …and the vertical half is unaffected by which mode it is.
    near(unlensFraming(prev, moved, w, h, false).y, panned.y)
  })
})

describe('freeCenterXFor', () => {
  it('centres in the strip the card leaves, right of the card, inside the canvas', () => {
    for (const [w] of SIZES) {
      const c = freeCenterXFor(w)
      expect(c).toBeGreaterThan(24 + Math.min(344, w - 48)) // clear of the card
      expect(c).toBeLessThan(w)
      expect(c).toBeGreaterThan(w / 2) // always right of centre — that IS the shift
    }
  })

  it('tracks canvas width, so full-screening re-frames instead of holding a stale centre', () => {
    // The ResizeObserver shifts x by the delta between these two; if they were
    // equal there would be nothing to shift and the lens would stay off-centre
    // for the new width, with the spine pin actively holding it there.
    expect(freeCenterXFor(2560)).toBeGreaterThan(freeCenterXFor(1600) + 400)
  })
})
