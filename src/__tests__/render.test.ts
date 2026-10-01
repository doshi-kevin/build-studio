import { describe, it, expect } from 'vitest'
import { computeSlideRect, drawStrokes } from '@/lib/live-classroom/drawings/render'
import type { Stroke } from '@/lib/live-classroom/drawings/types'

// These two pure functions are the SHARED renderer behind three consumers — the
// live/post-class on-screen overlay, the annotated-slides PDF export, and the
// recording-playback player. A regression here silently misplaces every stroke
// over every slide in all three, so the branches are pinned explicitly.

describe('computeSlideRect', () => {
  it('letterboxes a slide wider than the canvas (full width, centered vertically)', () => {
    // 16:9-ish (aspect 2) slide inside a square canvas → letterbox top/bottom.
    expect(computeSlideRect(100, 100, 2)).toEqual({ x: 0, y: 25, width: 100, height: 50 })
  })

  it('pillarboxes a slide taller than the canvas (full height, centered horizontally)', () => {
    expect(computeSlideRect(100, 100, 0.5)).toEqual({ x: 25, y: 0, width: 50, height: 100 })
  })

  it('fills exactly when slide and canvas aspect match', () => {
    expect(computeSlideRect(200, 100, 2)).toEqual({ x: 0, y: 0, width: 200, height: 100 })
  })

  it('returns the raw canvas rect for degenerate inputs (no divide-by-zero)', () => {
    expect(computeSlideRect(0, 100, 1.5)).toEqual({ x: 0, y: 0, width: 0, height: 100 })
    expect(computeSlideRect(100, 100, 0)).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })
})

// Minimal stub that records path calls + composite-op history, so we assert the
// real coordinate math and eraser behavior without a DOM canvas.
function makeCtx() {
  const calls: Array<[string, ...number[]]> = []
  const gco: string[] = []
  const ctx = {
    beginPath: () => calls.push(['beginPath']),
    moveTo: (x: number, y: number) => calls.push(['moveTo', x, y]),
    lineTo: (x: number, y: number) => calls.push(['lineTo', x, y]),
    stroke: () => calls.push(['stroke']),
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    set globalCompositeOperation(v: string) {
      gco.push(v)
    },
    get globalCompositeOperation() {
      return gco[gco.length - 1] ?? 'source-over'
    },
  }
  return { ctx, calls, gco }
}

function stroke(points: Array<{ x: number; y: number }>, color: string, width: number): Stroke {
  return {
    id: 'test',
    slideIndex: 0,
    points: points.map((p) => ({ ...p, t: 0 })),
    color,
    width,
    authorId: 'author',
  }
}

const RECT = { x: 0, y: 0, width: 1000, height: 500 }

describe('drawStrokes', () => {
  it('maps normalized points into the slide rectangle', () => {
    const { ctx, calls } = makeCtx()
    drawStrokes(ctx as unknown as CanvasRenderingContext2D, [stroke([{ x: 0.5, y: 0.5 }, { x: 1, y: 1 }], '#ef4444', 10)], RECT)
    expect(calls).toContainEqual(['moveTo', 500, 250])
    expect(calls).toContainEqual(['lineTo', 1000, 500])
  })

  it('scales stroke width to the slide width and clamps to a 1px minimum', () => {
    // width 20 on a 500px-wide slide → 20 * 500/1000 = 10.
    const c1 = makeCtx()
    drawStrokes(c1.ctx as unknown as CanvasRenderingContext2D, [stroke([{ x: 0, y: 0 }, { x: 1, y: 1 }], '#000', 20)], { x: 0, y: 0, width: 500, height: 250 })
    expect(c1.ctx.lineWidth).toBe(10)
    // a hairline on a small slide would round below 1px → clamped to 1.
    const c2 = makeCtx()
    drawStrokes(c2.ctx as unknown as CanvasRenderingContext2D, [stroke([{ x: 0, y: 0 }, { x: 1, y: 1 }], '#000', 1)], { x: 0, y: 0, width: 500, height: 250 })
    expect(c2.ctx.lineWidth).toBe(1)
  })

  it('uses destination-out for eraser strokes, then resets to source-over', () => {
    const { ctx, gco } = makeCtx()
    drawStrokes(ctx as unknown as CanvasRenderingContext2D, [stroke([{ x: 0, y: 0 }, { x: 1, y: 1 }], '__eraser__', 8)], RECT)
    expect(gco).toContain('destination-out') // the eraser subtracted, didn't paint
    expect(ctx.globalCompositeOperation).toBe('source-over') // reset for the next cycle
  })

  it('skips strokes with no points', () => {
    const { ctx, calls } = makeCtx()
    drawStrokes(ctx as unknown as CanvasRenderingContext2D, [stroke([], '#000', 4)], RECT)
    expect(calls.some((c) => c[0] === 'beginPath')).toBe(false)
  })
})
