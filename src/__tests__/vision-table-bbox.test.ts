// VLM table bbox conversion: model-supplied normalized boxes (top-left
// fractions of the page image) → stored PDF points (bottom-left origin).
// The model's geometry is untrusted — implausible boxes must come back
// undefined so the crop falls back to the full page, never a wrong slice.

import { describe, it, expect } from 'vitest'
import { normalizedBboxToPoints } from '@/lib/document-parser/vision'

// US Letter in points.
const W = 612
const H = 792

describe('normalizedBboxToPoints', () => {
  it('converts a mid-page box and flips the y-axis to bottom-left origin', () => {
    // Table occupying x:10–90%, y:20–50% from the top.
    const out = normalizedBboxToPoints({ x: 0.1, y: 0.2, width: 0.8, height: 0.3 }, W, H)
    expect(out).toBeDefined()
    expect(out!.x).toBeCloseTo(0.1 * W)
    expect(out!.width).toBeCloseTo(0.8 * W)
    expect(out!.height).toBeCloseTo(0.3 * H)
    // bottom edge: 1 - (0.2 + 0.3) = 0.5 of the height from the bottom.
    expect(out!.y).toBeCloseTo(0.5 * H)
  })

  it('clamps small overshoots into the page instead of rejecting them', () => {
    const out = normalizedBboxToPoints({ x: -0.02, y: 0.9, width: 1.06, height: 0.12 }, W, H)
    expect(out).toBeDefined()
    expect(out!.x).toBe(0)
    expect(out!.width).toBeCloseTo(W)
    // y0 clamped to 0.9, y1 clamped to 1 → height = 0.1 of page, sits at the bottom.
    expect(out!.y).toBeCloseTo(0)
    expect(out!.height).toBeCloseTo(0.1 * H)
  })

  it.each([
    ['null box', null],
    ['missing field', { x: 0.1, y: 0.1, width: 0.5 } as never],
    ['NaN', { x: NaN, y: 0.1, width: 0.5, height: 0.3 }],
    ['degenerate width', { x: 0.4, y: 0.2, width: 0.01, height: 0.3 }],
    ['degenerate height', { x: 0.1, y: 0.2, width: 0.5, height: 0.001 }],
    ['inverted (negative size after clamp)', { x: 0.9, y: 0.9, width: -0.5, height: -0.5 }],
    ['whole-page box (no better than fallback)', { x: 0, y: 0, width: 1, height: 1 }],
  ])('rejects %s as undefined', (_label, box) => {
    expect(normalizedBboxToPoints(box, W, H)).toBeUndefined()
  })

  it('rejects when page dimensions are unknown (standalone images)', () => {
    const box = { x: 0.1, y: 0.2, width: 0.5, height: 0.3 }
    expect(normalizedBboxToPoints(box, 0, H)).toBeUndefined()
    expect(normalizedBboxToPoints(box, W, 0)).toBeUndefined()
  })
})
