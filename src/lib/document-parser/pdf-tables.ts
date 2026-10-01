// Geometric PDF table detection (Phase 3) — pdfplumber-style lattice/stream,
// reimplemented in TS so it runs in the Node worker (pdfplumber is Python).
//
// Pure module: it takes the ruling-line paths + text boxes that pdf.ts already
// collects while walking the operator list, and returns detected tables plus a
// "flag this page to the VLM" decision. Design contract (docs/designs §4, §13.2):
//   • ruled grid, CLEAN  → emit as source:'geometric' ($0, trusted)
//   • ruled grid, low-confidence (merged/missing lines) → flag to VLM
//   • borderless (stream-only) → ALWAYS flag to VLM (alignment is unreliable)
// We only ever EMIT a table when we're confident; otherwise we defer to the VLM.
import type { ExtractedTableData } from '@/lib/validations/document-extraction'

/** A path from the content stream: flat [segType,x,y,...] coords + its CTM. */
export interface RawPath {
  coords: number[]
  ctm: number[]
}
/** A text run with its page-space box (PDF user space, y-up, bottom-left origin). */
export interface TextBox {
  str: string
  x: number
  y: number
  w: number
  h: number
}

interface HLine { y: number; x1: number; x2: number }
interface VLine { x: number; y1: number; y2: number }

const LINE_TOL = 3 // pt: a segment within this of axis-aligned is a ruling line; also the cluster radius
const MIN_LINE = 10 // pt: ignore segments shorter than this
const CLEAN_CONF = 0.9 // grid-crossing completeness needed to TRUST lattice (else flag to VLM)
const MAX_LINES = 4000 // DoS guard: a real ruled table is tens of lines; bail past this (CWE-400)

function tx(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]
}

/** Parse a constructPath coord stream into axis-aligned line segments (CTM applied). */
function pathToLines(path: RawPath, h: HLine[], v: VLine[]): void {
  const { coords, ctm } = path
  let i = 0
  let cur: [number, number] | null = null
  let start: [number, number] | null = null
  const emit = (a: [number, number], b: [number, number]) => {
    const dx = Math.abs(a[0] - b[0])
    const dy = Math.abs(a[1] - b[1])
    if (dy <= LINE_TOL && dx >= MIN_LINE) h.push({ y: (a[1] + b[1]) / 2, x1: Math.min(a[0], b[0]), x2: Math.max(a[0], b[0]) })
    else if (dx <= LINE_TOL && dy >= MIN_LINE) v.push({ x: (a[0] + b[0]) / 2, y1: Math.min(a[1], b[1]), y2: Math.max(a[1], b[1]) })
  }
  while (i < coords.length) {
    const t = coords[i]
    if (t === 0 || t === 1) {
      if (i + 2 >= coords.length) break // truncated/malformed coord stream
      const p = tx(ctm, coords[i + 1], coords[i + 2])
      if (t === 0) { cur = p; start = p } // moveTo
      else { if (cur) emit(cur, p); cur = p } // lineTo
      i += 3
    } else if (t === 4) {
      if (cur && start) emit(cur, start) // close
      i += 1
    } else {
      // curveTo / unknown — tables aren't drawn with curves; bail on this path
      return
    }
  }
}

/** Collapse near-equal coordinates into representative cluster centers (sorted asc). */
function cluster(values: number[], tol: number): number[] {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  let group = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - group[group.length - 1] <= tol) group.push(sorted[i])
    else { out.push(group.reduce((s, x) => s + x, 0) / group.length); group = [sorted[i]] }
  }
  out.push(group.reduce((s, x) => s + x, 0) / group.length)
  return out
}

function htmlEscape(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export interface PageTableResult {
  tables: ExtractedTableData[]
  /** true when a (borderless or low-confidence) table likely exists but we don't trust geometry — send the page to the VLM. */
  flagForVision: boolean
}

/**
 * Detect tables on one page. `paths` = ruling-line paths, `texts` = text boxes,
 * both in PDF user space. Returns trusted lattice tables + a VLM-flag for the rest.
 */
export function detectTablesForPage(paths: RawPath[], texts: TextBox[], pageNumber: number): PageTableResult {
  const h: HLine[] = []
  const v: VLine[] = []
  for (const p of paths) pathToLines(p, h, v)

  const lattice = detectLattice(h, v, texts, pageNumber)
  // Only a ≥2×2 grid is a plausible table (a bare page border is 1×1).
  const plausible = lattice !== null && lattice.table.rows >= 2 && lattice.table.cols >= 2
  if (plausible && lattice!.confidence >= CLEAN_CONF) {
    return { tables: [lattice!.table], flagForVision: false } // clean ruled grid → trust it, $0
  }
  if (plausible) {
    return { tables: [], flagForVision: true } // ruled but gappy (merged/missing lines) → VLM
  }
  // No ruled grid. Borderless table-shaped text region? → VLM (never trust stream
  // geometry). Otherwise (prose, a bare border, a lone figure) leave the page alone.
  return { tables: [], flagForVision: looksLikeBorderlessTable(texts) }
}

function detectLattice(
  h: HLine[],
  v: VLine[],
  texts: TextBox[],
  pageNumber: number,
): { table: ExtractedTableData; confidence: number } | null {
  if (h.length < 2 || v.length < 2) return null
  // DoS guard: a pathological PDF can draw thousands of lines, making the
  // crossing test O(xs·ys·(h+v)). A genuine ruled table is far smaller — bail.
  if (h.length > MAX_LINES || v.length > MAX_LINES) return null
  const ys = cluster(h.map((l) => l.y), LINE_TOL)
  const xs = cluster(v.map((l) => l.x), LINE_TOL)
  if (ys.length < 2 || xs.length < 2) return null

  const xMin = xs[0]
  const xMax = xs[xs.length - 1]
  const yMin = ys[0]
  const yMax = ys[ys.length - 1]
  const width = xMax - xMin
  const height = yMax - yMin
  if (width < MIN_LINE || height < MIN_LINE) return null

  // "Clean grid" test: count present line-crossings. A crossing (xi, yj) is
  // present if some h-line at yj spans across xi AND some v-line at xi spans yj.
  const hAt = (y: number) => h.filter((l) => Math.abs(l.y - y) <= LINE_TOL)
  const vAt = (x: number) => v.filter((l) => Math.abs(l.x - x) <= LINE_TOL)
  let present = 0
  let total = 0
  for (const x of xs) {
    for (const y of ys) {
      total++
      const hOk = hAt(y).some((l) => l.x1 - LINE_TOL <= x && x <= l.x2 + LINE_TOL)
      const vOk = vAt(x).some((l) => l.y1 - LINE_TOL <= y && y <= l.y2 + LINE_TOL)
      if (hOk && vOk) present++
    }
  }
  const confidence = total > 0 ? present / total : 0
  // We gate emission on `confidence` (grid-crossing completeness) + a ≥2×2 size
  // in detectTablesForPage. That cleanly separates a single clean table (≈0.9+)
  // from page borders (only 1×1, rejected) and from multi-region/background-line
  // pages where all lines cluster into one diluted grid (low confidence → flagged
  // to the VLM). Per-table region segmentation (so several ruled tables on one
  // page each extract deterministically) is a future improvement; today such
  // pages safely fall through to the VLM.

  // Build the grid. Rows top→bottom = descending y; cols left→right = ascending x.
  const rowEdges = [...ys].sort((a, b) => b - a) // high y first
  const colEdges = [...xs].sort((a, b) => a - b)
  const rows = rowEdges.length - 1
  const cols = colEdges.length - 1
  if (rows < 1 || cols < 1) return null

  const cellText = (yTop: number, yBot: number, xL: number, xR: number): string => {
    const inside = texts.filter((t) => {
      const cx = t.x + t.w / 2
      const cy = t.y + t.h / 2
      return cx >= xL - LINE_TOL && cx <= xR + LINE_TOL && cy >= yBot - LINE_TOL && cy <= yTop + LINE_TOL
    })
    // left-to-right within the cell
    inside.sort((a, b) => a.x - b.x)
    return htmlEscape(inside.map((t) => t.str).join(' ').replace(/\s+/g, ' ').trim())
  }

  const trs: string[] = []
  for (let r = 0; r < rows; r++) {
    const yTop = rowEdges[r]
    const yBot = rowEdges[r + 1]
    const tds: string[] = []
    for (let c = 0; c < cols; c++) {
      tds.push(`<td>${cellText(yTop, yBot, colEdges[c], colEdges[c + 1])}</td>`)
    }
    trs.push(`<tr>${tds.join('')}</tr>`)
  }

  return {
    confidence,
    table: {
      pageNumber,
      html: `<table>${trs.join('')}</table>`,
      rows,
      cols,
      source: 'geometric',
      bbox: { x: +xMin.toFixed(1), y: +yMin.toFixed(1), width: +width.toFixed(1), height: +height.toFixed(1) },
    },
  }
}

/**
 * Coarse borderless-table signal (stream): are there ≥3 text rows that each
 * split into the SAME ≥3 column bands? Used ONLY to flag the page to the VLM —
 * we never emit a stream table (alignment alone is unreliable, per §4).
 */
function looksLikeBorderlessTable(texts: TextBox[]): boolean {
  if (texts.length < 9) return false
  // group into rows by y (cluster centers)
  const rowYs = cluster(texts.map((t) => t.y), 4)
  if (rowYs.length < 3) return false
  const rows: TextBox[][] = rowYs.map(() => [])
  for (const t of texts) {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < rowYs.length; i++) {
      const d = Math.abs(t.y - rowYs[i])
      if (d < bestD) { bestD = d; best = i }
    }
    rows[best].push(t)
  }
  // count rows that have ≥3 column segments (gaps wider than a space)
  const multiColRows = rows.filter((r) => {
    if (r.length < 3) return false
    const xs = r.map((t) => t.x).sort((a, b) => a - b)
    let segments = 1
    for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 15) segments++
    return segments >= 3
  })
  return multiColRows.length >= 3
}
