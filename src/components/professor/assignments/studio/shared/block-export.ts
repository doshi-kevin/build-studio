/**
 * Static export renderers for the interactive blocks (chart / graph / Solver).
 *
 * The editor renders these via React NodeViews, which `generateHTML` (used by the PDF/HTML export)
 * can't run — it only calls each node's static `renderHTML`, leaving an empty `<div data-…>`
 * placeholder. `renderStaticBlocks` swaps those placeholders for standalone SVG/HTML built from the
 * node's stored data, so downloads actually contain the blocks.
 *
 * Deliberately minimal / axis-light to match the on-screen style: no gridlines, no numeric y-axis
 * ticks — just the shape, a title, and light x labels. Colours are concrete hex (this is a
 * self-contained print document, not a themed app surface). Map blocks are left as a caption for now.
 */
import { compile, type EvalFunction } from 'mathjs'
import katex from 'katex'
import type { ChartConfig } from '../ChartNode'
import type { GraphConfig } from '../GraphNode'
import type { MatchConfig } from '../MatchNode'
import type { SolverConfig } from '../SolverNode'

const MUTED = '#9aa0ac'
const SERIES = ['#4b56d2', '#0e9f6e', '#7a5cff', '#c08a2b', '#c0453b']
const W = 520
const H = 220
const PAD = { l: 10, r: 12, t: 10, b: 24 }
const IW = W - PAD.l - PAD.r
const IH = H - PAD.t - PAD.b

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
function figureStyle(width: number, align: string): string {
  const w = `width:${width}%;`
  const m =
    align === 'left' ? 'margin-right:auto;' :
    align === 'right' ? 'margin-left:auto;' :
    'margin-left:auto;margin-right:auto;'
  return `${w}${m}`
}

function figure(title: string, inner: string, width = 100, align = 'center'): string {
  const style = figureStyle(width, align)
  return `<figure class="block-export" style="${style}">${title ? `<figcaption>${esc(title)}</figcaption>` : ''}${inner}</figure>`
}
function xLabel(cx: number, text: string): string {
  return `<text x="${cx.toFixed(1)}" y="${(PAD.t + IH + 15).toFixed(1)}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(text)}</text>`
}

const svg = (body: string) => `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%">${body}</svg>`
const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const a = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

const FUNC_SAMPLES_EXPORT = 160

/** Sample a single expression across [lo, hi] for static export. Returns {x,y}[] with nulls removed. */
function sampleFnExport(expr: string, lo: number, hi: number): { x: number; y: number }[] {
  let c: EvalFunction | null = null
  try { c = compile(expr) as EvalFunction } catch { return [] }
  if (!c) return []
  const step = (hi - lo) / (FUNC_SAMPLES_EXPORT - 1)
  const rows: { x: number; y: number }[] = []
  for (let i = 0; i < FUNC_SAMPLES_EXPORT; i++) {
    const x = lo + i * step
    try {
      const y = (c as EvalFunction).evaluate({ x })
      if (typeof y === 'number' && Number.isFinite(y)) rows.push({ x, y })
    } catch { /* skip */ }
  }
  return rows
}

/** A chart from hand-entered points — line · bar · scatter · area · pie · radar, in Scholera colors.
 *  Also renders equation layers (functions[]) as SVG paths and appends a Solver image if present. */
export function chartToSvg(cfg: ChartConfig, width = 100, align = 'center'): string {
  // Solver-plot type: just the fetched image.
  if (cfg.type === 'wolfram') {
    return cfg.wolframImageUrl
      ? figure(cfg.title ?? '', `<img src="${esc(cfg.wolframImageUrl)}" alt="Solver plot" style="max-width:100%" />`, width, align)
      : figure(cfg.title ?? '', '<p style="color:#9aa0ac;font-size:.8rem">Solver plot</p>', width, align)
  }
  const pts = cfg.points ?? []
  const fns = cfg.functions ?? []
  const hasData = pts.length > 0
  const hasFunctions = fns.length > 0 && ['line', 'area', 'scatter', 'bar'].includes(cfg.type)
  if (!hasData && !hasFunctions) return figure(cfg.title ?? '', '<p style="color:#9aa0ac;font-size:.8rem">No data</p>', width, align)
  const color = SERIES[0]

  // When axis labels are set, extend the SVG viewBox and render them as SVG text.
  const wrapWithAxisLabels = (inner: string): string => {
    if (!cfg.xLabel && !cfg.yLabel) return inner
    // Extend viewBox to fit labels
    const extraB = cfg.xLabel ? 18 : 0
    const extraL = cfg.yLabel ? 30 : 0
    const vbW = W + extraL; const vbH = H + extraB
    const body2 = `<g transform="translate(${extraL},0)">${inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g>${cfg.xLabel ? `<text x="${(extraL + W / 2).toFixed(1)}" y="${(H + 14).toFixed(1)}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(cfg.xLabel)}</text>` : ''}${cfg.yLabel ? `<text x="-${(H / 2).toFixed(1)}" y="10" text-anchor="middle" font-size="10" fill="${MUTED}" transform="rotate(-90)">${esc(cfg.yLabel)}</text>` : ''}`
    return `<svg viewBox="0 0 ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%">${body2}</svg>`
  }

  // --- Pie (donut) ---
  if (cfg.type === 'pie') {
    const cx = W / 2, cy = H / 2, r = 88, ri = 40
    const total = pts.reduce((s, p) => s + Math.max(0, Number(p.y) || 0), 0) || 1
    let acc = 0
    const body = pts.map((p, i) => {
      const frac = Math.max(0, Number(p.y) || 0) / total
      const a0 = acc * 360; acc += frac; const a1 = acc * 360
      const [x1, y1] = polar(cx, cy, r, a0), [x2, y2] = polar(cx, cy, r, a1)
      const [x3, y3] = polar(cx, cy, ri, a1), [x4, y4] = polar(cx, cy, ri, a0)
      const large = a1 - a0 > 180 ? 1 : 0
      return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L${x3.toFixed(1)} ${y3.toFixed(1)} A${ri} ${ri} 0 ${large} 0 ${x4.toFixed(1)} ${y4.toFixed(1)} Z" fill="${SERIES[i % SERIES.length]}"/>`
    }).join('')
    const legend = pts.map((p, i) =>
      `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#18181b;margin:0 6px"><span style="width:9px;height:9px;border-radius:2px;background:${SERIES[i % SERIES.length]};display:inline-block"></span>${esc(String(p.x))}</span>`,
    ).join('')
    return figure(cfg.title ?? '', `${svg(body)}<div style="margin-top:6px">${legend}</div>`, width, align)
  }

  // --- Radar ---
  if (cfg.type === 'radar') {
    const cx = W / 2, cy = H / 2, R = 82
    const max = Math.max(...pts.map((p) => Number(p.y) || 0), 1)
    const n = pts.length
    let grid = ''
    for (let g = 1; g <= 3; g++) {
      const rr = (R * g) / 3
      const ring = pts.map((_, i) => polar(cx, cy, rr, (i * 360) / n)).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
      grid += `<polygon points="${ring}" fill="none" stroke="#e6e8ef"/>`
    }
    const poly = pts.map((p, i) => polar(cx, cy, R * ((Number(p.y) || 0) / max), (i * 360) / n))
    const pts2 = poly.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
    const labels = pts.map((p, i) => { const [x, y] = polar(cx, cy, R + 12, (i * 360) / n); return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="9" fill="${MUTED}">${esc(String(p.x))}</text>` }).join('')
    return figure(cfg.title ?? '', svg(`${grid}<polygon points="${pts2}" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2"/>${labels}`), width, align)
  }

  // --- Cartesian (line / area / bar / scatter) ---
  const xLo = cfg.xMin ?? -6
  const xHi = cfg.xMax ?? 6

  // Sample function curves to determine their y-range contribution
  const sampledFns = hasFunctions
    ? fns.map((f) => sampleFnExport(f.expr, xLo, xHi))
    : []
  const fnYs = sampledFns.flatMap((rows) => rows.map((r) => r.y))

  const ys = pts.map((p) => Number(p.y) || 0)
  // Honor yMin/yMax from axis config, fall back to combined data + function range
  const allYs = [...ys, ...fnYs]
  const ymin = cfg.yMin !== undefined ? cfg.yMin : Math.min(...(allYs.length ? allYs : [0]), 0)
  let ymax = cfg.yMax !== undefined ? cfg.yMax : Math.max(...(allYs.length ? allYs : [0]), 0)
  if (ymax === ymin) ymax = ymin + 1
  const yToPx = (v: number) => PAD.t + IH * (1 - (v - ymin) / (ymax - ymin))
  let body = ''

  // Optional faint grid lines (when showGrid is on)
  if (cfg.showGrid) {
    const gridLines = 4
    for (let g = 1; g < gridLines; g++) {
      const gy = PAD.t + (IH * g) / gridLines
      body += `<line x1="${PAD.l}" y1="${gy.toFixed(1)}" x2="${(PAD.l + IW).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="#e6e8ef" stroke-width="1"/>`
    }
  }

  if (cfg.type === 'bar') {
    if (pts.length) {
      const bw = (IW / pts.length) * 0.6
      pts.forEach((p, i) => {
        const cx = PAD.l + IW * ((i + 0.5) / pts.length)
        const y = yToPx(Number(p.y) || 0)
        body += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, PAD.t + IH - y).toFixed(1)}" rx="4" fill="${color}" opacity="0.9"/>`
        body += xLabel(cx, String(p.x))
      })
    }
  } else if (cfg.type === 'scatter') {
    const xs = pts.map((p) => Number(p.x) || 0)
    // Honor xMin/xMax from axis config
    const xmin = cfg.xMin !== undefined ? cfg.xMin : (xs.length ? Math.min(...xs) : xLo)
    let xmax = cfg.xMax !== undefined ? cfg.xMax : (xs.length ? Math.max(...xs) : xHi)
    if (xmax === xmin) xmax = xmin + 1
    const xToPx = (v: number) => PAD.l + IW * ((v - xmin) / (xmax - xmin))
    pts.forEach((p) => { body += `<circle cx="${xToPx(Number(p.x) || 0).toFixed(1)}" cy="${yToPx(Number(p.y) || 0).toFixed(1)}" r="4" fill="${color}" opacity="0.9"/>` })
  } else {
    // line + area
    if (pts.length) {
      const xAt = (i: number) => PAD.l + (pts.length <= 1 ? IW / 2 : IW * (i / (pts.length - 1)))
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yToPx(Number(p.y) || 0).toFixed(1)}`).join(' ')
      if (cfg.type === 'area') {
        const base = PAD.t + IH
        body += `<path d="${d} L${xAt(pts.length - 1).toFixed(1)} ${base} L${xAt(0).toFixed(1)} ${base} Z" fill="${color}" fill-opacity="0.18"/>`
      }
      body += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
      pts.forEach((p, i) => { body += `<circle cx="${xAt(i).toFixed(1)}" cy="${yToPx(Number(p.y) || 0).toFixed(1)}" r="3" fill="${color}"/>` })
      pts.forEach((p, i) => { body += xLabel(xAt(i), String(p.x)) })
    }
  }

  // Render function curves as SVG paths (colors offset by 1 to avoid data-series collision)
  if (hasFunctions) {
    const xToPxFn = (x: number) => PAD.l + IW * ((x - xLo) / (xHi - xLo))
    sampledFns.forEach((rows, fi) => {
      if (!rows.length) return
      let d = ''; let pen = false
      rows.forEach((pt) => {
        const px = xToPxFn(pt.x)
        const py = yToPx(pt.y)
        if (py < PAD.t - 4 || py > PAD.t + IH + 4) { pen = false; return } // clip to viewport
        d += `${pen ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)} `
        pen = true
      })
      if (d) body += `<path d="${d.trim()}" fill="none" stroke="${SERIES[(fi + 1) % SERIES.length]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    })
  }

  // Build the main SVG content
  const svgContent = wrapWithAxisLabels(svg(body))

  // Append Solver image below SVG if present
  const solverHtml = cfg.wolframImageUrl
    ? `<div style="margin-top:8px"><img src="${esc(cfg.wolframImageUrl)}" alt="Solver plot" style="max-width:100%;border:1px solid #e6e8ef;border-radius:6px"><p style="text-align:center;font-size:10px;color:${MUTED};margin:4px 0 0">Solver</p></div>`
    : ''

  return figure(cfg.title ?? '', svgContent + solverHtml, width, align)
}

/** One or more functions y = f(x), sampled across the range. */
export function graphToSvg(cfg: GraphConfig, width = 100, align = 'center'): string {
  const lo = Number.isFinite(cfg.xMin) ? cfg.xMin : -6
  const hi = Number.isFinite(cfg.xMax) && cfg.xMax > lo ? cfg.xMax : lo + 12
  const N = 200
  const compiled = (cfg.functions ?? []).map((f) => { try { return compile(f.expr) } catch { return null } })
  const series: (number | null)[][] = compiled.map(() => [])
  const xs: number[] = []
  let ymin = Infinity; let ymax = -Infinity
  for (let i = 0; i < N; i++) {
    const x = lo + (hi - lo) * (i / (N - 1))
    xs.push(x)
    compiled.forEach((c, s) => {
      let y: number | null = null
      if (c) { try { const v = c.evaluate({ x }); if (typeof v === 'number' && Number.isFinite(v)) { y = v; if (v < ymin) ymin = v; if (v > ymax) ymax = v } } catch { /* skip */ } }
      series[s].push(y)
    })
  }
  if (!Number.isFinite(ymin) || !Number.isFinite(ymax) || ymin === ymax) { ymin = -1; ymax = 1 }
  const xToPx = (x: number) => PAD.l + IW * ((x - lo) / (hi - lo))
  const yToPx = (y: number) => PAD.t + IH * (1 - (y - ymin) / (ymax - ymin))

  let body = ''
  // Faint baseline at y = 0 when it's in range — the one bit of reference we keep.
  if (ymin < 0 && ymax > 0) {
    const y0 = yToPx(0)
    body += `<line x1="${PAD.l}" y1="${y0.toFixed(1)}" x2="${(W - PAD.r).toFixed(1)}" y2="${y0.toFixed(1)}" stroke="#e6e8ef" stroke-width="1"/>`
  }
  series.forEach((ys, s) => {
    let d = ''; let pen = false
    ys.forEach((y, i) => {
      if (y === null) { pen = false; return }
      d += `${pen ? 'L' : 'M'}${xToPx(xs[i]).toFixed(1)} ${yToPx(y).toFixed(1)} `
      pen = true
    })
    if (d) body += `<path d="${d.trim()}" fill="none" stroke="${SERIES[s % SERIES.length]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
  })
  body += xLabel(xToPx(lo), String(Math.round(lo)))
  body += xLabel(xToPx(hi), String(Math.round(hi)))

  return figure(cfg.title ?? '', `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%">${body}</svg>`, width, align)
}

/** The cached Solver result (image, or text/markdown as preformatted text). */
export function solverToHtml(cfg: SolverConfig, width = 100, align = 'center'): string {
  const head = `Solver${cfg.query ? ` · ${esc(cfg.query)}` : ''}`
  const inner = cfg.imageUrl
    ? `<img src="${esc(cfg.imageUrl)}" alt="Solver result" style="max-width:100%">`
    // A div (not <pre>) so the KaTeX auto-render in the export scaffold renders the `$…$` math.
    : `<div class="solver-body">${esc(cfg.markdown || cfg.text || 'No result')}</div>`
  const style = figureStyle(width, align)
  return `<div class="solver-export" style="${style}"><p class="solver-h">${head}</p>${inner}</div>`
}

/** A KaTeX equation block, rendered to static HTML (katex.min.css in the export scaffold styles it). */
export function equationToHtml(latex: string, width = 100, align = 'center'): string {
  let html = ''
  try { html = katex.renderToString(latex, { displayMode: true, throwOnError: false, output: 'html' }) } catch { html = '' }
  const style = figureStyle(width, align)
  return `<figure class="block-export" style="${style}">${html || `<span style="color:#9aa0ac">${esc(latex)}</span>`}</figure>`
}

/**
 * A static worksheet render of a Match block for PDF/HTML export.
 * Numbered terms on the left, shuffled options bank on the right — no answer key exposed.
 */
export function matchToHtml(cfg: MatchConfig): string {
  const pairs = cfg.pairs ?? []
  const distractors = cfg.distractors ?? []

  // Shuffle right-side options (pairs + distractors) for the options bank via Fisher-Yates so the
  // bank order doesn't track the term order (the previous char-code sort left it near-identity).
  const rightOptions = [
    ...pairs.map((p) => p.right),
    ...distractors.map((d) => d.text),
  ]
  for (let i = rightOptions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rightOptions[i], rightOptions[j]] = [rightOptions[j], rightOptions[i]]
  }

  const labels = rightOptions.map((_, i) => String.fromCharCode(65 + i))

  const promptHtml = cfg.prompt
    ? `<p style="font-weight:600;font-size:.875rem;margin:0 0 10px">${esc(cfg.prompt)}</p>`
    : ''

  const termsHtml = pairs.map((pair, i) =>
    `<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px;font-size:.875rem">
      <span style="font-weight:600;min-width:1.25rem">${i + 1}.</span>
      <span style="flex:1">${esc(pair.left || `Term ${i + 1}`)}</span>
      <span style="color:#9aa0ac">______</span>
    </div>`,
  ).join('')

  const optionsHtml = rightOptions.map((text, i) =>
    `<span style="display:inline-flex;align-items:center;gap:4px;border:1px solid #e6e8ef;border-radius:10px;padding:4px 10px;font-size:.8rem;margin:3px">
      <strong>${labels[i]}.</strong> ${esc(text || '—')}
    </span>`,
  ).join('')

  return `<div class="match-export" style="border:1px solid #e6e8ef;border-radius:12px;padding:16px;margin:12px 0">
    <p style="font-size:.6rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9aa0ac;margin:0 0 8px">Match the following${cfg.points ? ` · ${cfg.points} pts` : ''}</p>
    ${promptHtml}
    ${termsHtml}
    <div style="border-top:1px solid #e6e8ef;margin-top:10px;padding-top:8px">
      <p style="font-size:.6rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9aa0ac;margin:0 0 6px">Options</p>
      <div>${optionsHtml}</div>
    </div>
  </div>`
}

function parse<T>(escaped: string, fallback: T): T {
  try { return JSON.parse(unescapeAttr(escaped)) as T } catch { return fallback }
}

function parseBlockDims(attrs: string): { width: number; align: string } {
  const wm = /data-width="([^"]*)"/.exec(attrs)
  const am = /data-align="([^"]*)"/.exec(attrs)
  return {
    width: wm ? Number(wm[1]) || 100 : 100,
    align: am ? am[1] : 'center',
  }
}

/**
 * Replace the static `<div data-…>` placeholders that generateHTML leaves for the interactive
 * blocks with real static content. Runs on the exported body HTML.
 */
export function renderStaticBlocks(html: string): string {
  return html
    .replace(/<div\b([^>]*\bdata-chart="([^"]*)"[^>]*)><\/div>/g, (_m, attrs, j) => {
      const { width, align } = parseBlockDims(attrs)
      return chartToSvg(parse<ChartConfig>(j, { type: 'line', title: '', points: [] }), width, align)
    })
    .replace(/<div\b([^>]*\bdata-graph="([^"]*)"[^>]*)><\/div>/g, (_m, attrs, j) => {
      const { width, align } = parseBlockDims(attrs)
      return graphToSvg(parse<GraphConfig>(j, { title: '', xMin: -6, xMax: 6, functions: [] }), width, align)
    })
    .replace(/<div\b([^>]*\bdata-wolfram="([^"]*)"[^>]*)><\/div>/g, (_m, attrs, j) => {
      const { width, align } = parseBlockDims(attrs)
      return solverToHtml(parse<SolverConfig>(j, { query: '', tool: 'worked' }), width, align)
    })
    .replace(/<div\b([^>]*\bdata-equation=[^>]*)><\/div>/g, (_m, attrs) => {
      const mm = /data-latex="([^"]*)"/.exec(attrs)
      const { width, align } = parseBlockDims(attrs)
      return equationToHtml(mm ? unescapeAttr(mm[1]) : '', width, align)
    })
    .replace(/<div\b[^>]*\bdata-map="([^"]*)"[^>]*><\/div>/g, () => '<p class="map-note">🗺️ Map — open the assignment online to view.</p>')
    .replace(/<div\b[^>]*\bdata-match="([^"]*)"[^>]*><\/div>/g, (_m, j) =>
      matchToHtml(parse<MatchConfig>(j, { prompt: '', points: 0, pairs: [], distractors: [] }))
    )
}
