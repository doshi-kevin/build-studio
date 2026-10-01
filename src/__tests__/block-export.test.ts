// @vitest-environment node
//
// Static export renderers for the interactive studio blocks (block-export.ts).
// These run on the PDF/HTML download path: generateHTML leaves empty `<div data-…>`
// placeholders for the React NodeViews, and renderStaticBlocks swaps them for
// standalone SVG/HTML built from the node's *stored, professor-authored* config.
//
// Why this is worth testing:
//  - It is an export path that turns untrusted stored config into an HTML file, so the
//    HTML-escaping (esc) is security-relevant — a regression here is stored XSS in a download.
//  - The placeholder-swap is regex-driven and silently degrades (an unmatched placeholder
//    ships as an empty div) if the data-* attribute contract drifts.
import { describe, it, expect } from 'vitest'
import {
  chartToSvg,
  graphToSvg,
  matchToHtml,
  solverToHtml,
  equationToHtml,
  renderStaticBlocks,
} from '@/components/professor/assignments/studio/shared/block-export'
import type { ChartConfig } from '@/components/professor/assignments/studio/ChartNode'

// Escape a JSON blob the way it lives inside a data-* attribute in the exported HTML
// (renderStaticBlocks reverses this via unescapeAttr before JSON.parse).
const attr = (obj: unknown) =>
  JSON.stringify(obj).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

describe('chartToSvg', () => {
  it('renders a line chart as an SVG figure with the escaped title', () => {
    const cfg: ChartConfig = { type: 'line', title: 'My Chart', points: [{ x: '1', y: 2 }, { x: '2', y: 4 }] }
    const html = chartToSvg(cfg)
    expect(html).toContain('<svg')
    expect(html).toContain('<figcaption>My Chart</figcaption>')
    expect(html).toContain('<path') // the line path
  })

  it('escapes an HTML-bearing title (XSS on the export path)', () => {
    const cfg: ChartConfig = { type: 'line', title: '<script>alert(1)</script>', points: [{ x: '1', y: 1 }] }
    const html = chartToSvg(cfg)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders a "No data" note when there are no points and no functions', () => {
    const cfg: ChartConfig = { type: 'bar', title: 'Empty', points: [] }
    expect(chartToSvg(cfg)).toContain('No data')
  })

  it('honors block width/align in the figure style', () => {
    const cfg: ChartConfig = { type: 'line', title: 'x', points: [{ x: '1', y: 1 }] }
    const html = chartToSvg(cfg, 60, 'left')
    expect(html).toContain('width:60%')
    expect(html).toContain('margin-right:auto') // left align pins to the left
  })

  it('a solver-type chart with no image shows a placeholder, not a broken <img>', () => {
    const cfg: ChartConfig = { type: 'wolfram', title: 'W', points: [] }
    const html = chartToSvg(cfg)
    expect(html).toContain('Solver plot')
    expect(html).not.toContain('<img')
  })
})

describe('graphToSvg', () => {
  it('renders each function as its own SVG path', () => {
    const html = graphToSvg({ title: 'g', xMin: -3, xMax: 3, functions: [{ expr: 'x^2', label: 'a' }, { expr: 'x', label: 'b' }] })
    expect(html).toContain('<svg')
    expect((html.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('does not crash on an unparseable expression (drops that series)', () => {
    // A bad expr compiles to null and is skipped, not thrown.
    expect(() => graphToSvg({ title: 'g', xMin: -1, xMax: 1, functions: [{ expr: ')(', label: 'x' }] })).not.toThrow()
  })
})

describe('matchToHtml', () => {
  it('numbers terms, labels options A/B/C, and never leaks the answer key', () => {
    const html = matchToHtml({
      prompt: 'Match capitals',
      points: 5,
      pairs: [{ id: '1', left: 'France', right: 'Paris' }, { id: '2', left: 'Japan', right: 'Tokyo' }],
      distractors: [{ id: '3', text: 'Berlin' }],
    })
    expect(html).toContain('Match capitals')
    expect(html).toContain('1.') // numbered term
    expect(html).toContain('2.')
    expect(html).toContain('A.') // lettered option bank
    // The left/right pairing (the answer key) must not appear as an explicit mapping.
    expect(html).not.toMatch(/France\s*[:=→-]\s*Paris/)
    // All three options (2 pairs + 1 distractor) are present in the shuffled bank.
    for (const opt of ['Paris', 'Tokyo', 'Berlin']) expect(html).toContain(opt)
  })

  it('escapes prompt and option text', () => {
    const html = matchToHtml({
      prompt: '<b>x</b>',
      points: 0,
      pairs: [{ id: '1', left: 'a', right: '<img src=x onerror=alert(1)>' }],
      distractors: [],
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })
})

describe('solverToHtml / equationToHtml', () => {
  it('solverToHtml escapes the query and text body', () => {
    const html = solverToHtml({ query: '<x>', tool: 'worked', text: '<y>' })
    expect(html).toContain('&lt;x&gt;')
    expect(html).toContain('&lt;y&gt;')
    expect(html).not.toContain('<x>')
  })

  it('equationToHtml falls back to escaped source when KaTeX cannot render', () => {
    // An empty/garbage latex still returns a figure, never throws (throwOnError:false).
    const html = equationToHtml('\\frac{')
    expect(html).toContain('block-export')
  })
})

describe('renderStaticBlocks', () => {
  it('replaces a chart placeholder with a real SVG figure', () => {
    const cfg = { type: 'bar', title: 'Sales', points: [{ x: 'A', y: 3 }] }
    const input = `<p>before</p><div data-chart="${attr(cfg)}"></div><p>after</p>`
    const out = renderStaticBlocks(input)
    expect(out).toContain('<p>before</p>')
    expect(out).toContain('<p>after</p>')
    expect(out).toContain('<svg')
    expect(out).toContain('Sales')
    expect(out).not.toContain('data-chart=') // placeholder consumed
  })

  it('carries data-width / data-align from the placeholder into the figure', () => {
    const cfg = { type: 'line', title: 't', points: [{ x: '1', y: 1 }] }
    const input = `<div data-chart="${attr(cfg)}" data-width="50" data-align="right"></div>`
    const out = renderStaticBlocks(input)
    expect(out).toContain('width:50%')
    expect(out).toContain('margin-left:auto') // right align
  })

  it('replaces an equation placeholder using its data-latex attribute', () => {
    const input = '<div data-equation="" data-latex="E = mc^2"></div>'
    const out = renderStaticBlocks(input)
    expect(out).toContain('block-export')
    expect(out).not.toContain('data-equation=')
  })

  it('turns a map placeholder into a caption note (maps are not statically rendered)', () => {
    const out = renderStaticBlocks('<div data-map="{}"></div>')
    expect(out).toContain('map-note')
    expect(out).not.toContain('data-map=')
  })

  it('falls back to defaults on malformed block JSON instead of throwing', () => {
    const input = '<div data-chart="not-json"></div>'
    expect(() => renderStaticBlocks(input)).not.toThrow()
    // Falls back to an empty line chart → "No data" figure.
    expect(renderStaticBlocks(input)).toContain('No data')
  })

  it('leaves ordinary HTML untouched', () => {
    const input = '<p>plain <strong>text</strong></p>'
    expect(renderStaticBlocks(input)).toBe(input)
  })
})
