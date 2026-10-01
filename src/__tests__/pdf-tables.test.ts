// Phase 3 — geometric PDF table detection (src/lib/document-parser/pdf-tables.ts).
// Pure unit tests on synthetic ruling-line paths (no PDF files, CI-safe). The
// detector's real-world behaviour is separately validated against the camelot
// suite in tmp/extraction-experiment/phase3-validate.ts (foo → 7×7, etc.).
import { describe, it, expect } from 'vitest'
import { detectTablesForPage, type RawPath, type TextBox } from '@/lib/document-parser/pdf-tables'

const ID = [1, 0, 0, 1, 0, 0]
const hline = (y: number, x0: number, x1: number, ctm: number[] = ID): RawPath => ({ coords: [0, x0, y, 1, x1, y], ctm })
const vline = (x: number, y0: number, y1: number, ctm: number[] = ID): RawPath => ({ coords: [0, x, y0, 1, x, y1], ctm })
const text = (str: string, x: number, y: number): TextBox => ({ str, x, y, w: 8, h: 4 }) // center = (x+4, y+2)

// the clean 3-row × 2-col ruling-line set used by several tests, optionally under a CTM
const grid3x2 = (ctm: number[] = ID): RawPath[] => [
  hline(0, 0, 100, ctm), hline(10, 0, 100, ctm), hline(20, 0, 100, ctm), hline(30, 0, 100, ctm),
  vline(0, 0, 30, ctm), vline(50, 0, 30, ctm), vline(100, 0, 30, ctm),
]

describe('detectTablesForPage — lattice', () => {
  it('emits a clean ruled grid as a geometric table (3×2)', () => {
    // h-lines at y=0,10,20,30 (3 row-bands), v-lines at x=0,50,100 (2 col-bands)
    const paths = [
      hline(0, 0, 100), hline(10, 0, 100), hline(20, 0, 100), hline(30, 0, 100),
      vline(0, 0, 30), vline(50, 0, 30), vline(100, 0, 30),
    ]
    const texts = [
      text('A1', 20, 23), text('B1', 70, 23), // top row (y 20–30)
      text('A2', 20, 13), text('B2', 70, 13), // mid row (y 10–20)
      text('A3', 20, 3), text('B3', 70, 3), // bottom row (y 0–10)
    ]
    const res = detectTablesForPage(paths, texts, 5)
    expect(res.flagForVision).toBe(false)
    expect(res.tables).toHaveLength(1)
    const t = res.tables[0]
    expect(t.source).toBe('geometric')
    expect(t.rows).toBe(3)
    expect(t.cols).toBe(2)
    expect(t.pageNumber).toBe(5)
    // rows are top→bottom; first cell is the top-left
    expect(t.html.startsWith('<table><tr><td>A1</td>')).toBe(true)
    expect(t.html).toContain('<td>B3</td>')
  })

  it('applies the CTM to path coords (scale + translate)', () => {
    // CTM [2,0,0,2,100,50]: point (x,y) → (2x+100, 2y+50). Grid extent 100×30 → 200×60.
    const M = [2, 0, 0, 2, 100, 50]
    // text boxes live in transformed page space; centers land in the right cells
    const texts = [text('A1', 146, 98), text('B3', 294, 52)] // → centers (150,100) top-left, (298,54) bottom-right
    const res = detectTablesForPage(grid3x2(M), texts, 1)
    expect(res.flagForVision).toBe(false)
    expect(res.tables[0].rows).toBe(3)
    expect(res.tables[0].cols).toBe(2)
    expect(res.tables[0].bbox).toMatchObject({ x: 100, width: 200, height: 60 })
    expect(res.tables[0].html).toContain('<td>A1</td>')
    expect(res.tables[0].html).toContain('<td>B3</td>')
  })

  it('HTML-escapes cell text', () => {
    const res = detectTablesForPage(grid3x2(), [text('x</td>&<b>', 20, 23)], 1)
    expect(res.tables[0].html).toContain('x&lt;/td&gt;&amp;&lt;b&gt;')
  })

  it('does not treat a bare page border (1×1) as a table', () => {
    const border = [hline(0, 0, 200), hline(300, 0, 200), vline(0, 0, 300), vline(200, 0, 300)]
    const res = detectTablesForPage(border, [text('body', 100, 150)], 1)
    expect(res.tables).toHaveLength(0)
    expect(res.flagForVision).toBe(false) // border + prose isn't a table
  })

  it('flags a low-confidence (gappy) grid to the VLM instead of trusting it', () => {
    // 3×3 line clusters → 2×2 grid, but the middle v-line is a stub (y 0–10),
    // so its crossings at y=50 and y=100 are missing → confidence < 0.9.
    const paths = [
      hline(0, 0, 100), hline(50, 0, 100), hline(100, 0, 100),
      vline(0, 0, 100), vline(100, 0, 100), vline(50, 0, 10),
    ]
    const res = detectTablesForPage(paths, [], 2)
    expect(res.tables).toHaveLength(0)
    expect(res.flagForVision).toBe(true)
  })
})

describe('detectTablesForPage — borderless (stream signal)', () => {
  it('flags a borderless multi-column text region to the VLM (emits nothing)', () => {
    // 3 rows × 3 well-separated columns, no ruling lines
    const texts: TextBox[] = []
    for (let r = 0; r < 3; r++) {
      texts.push(text(`r${r}c0`, 0, 100 - r * 10))
      texts.push(text(`r${r}c1`, 80, 100 - r * 10))
      texts.push(text(`r${r}c2`, 160, 100 - r * 10))
    }
    const res = detectTablesForPage([], texts, 3)
    expect(res.tables).toHaveLength(0) // never trust stream geometry
    expect(res.flagForVision).toBe(true)
  })

  it('does not flag ordinary prose', () => {
    const prose = [text('The quick brown fox', 0, 100), text('jumps over the lazy dog', 0, 90)]
    const res = detectTablesForPage([], prose, 4)
    expect(res.tables).toHaveLength(0)
    expect(res.flagForVision).toBe(false)
  })
})
