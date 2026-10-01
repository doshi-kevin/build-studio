// @vitest-environment node
//
// chart-data de-plotting edge cases for the shared cached-value parser
// (chartDataFromPart in ooxml.ts). Cases drawn from real OOXML chart quirks:
// multiple series, gapped/out-of-order <c:pt idx>, missing title, scatter charts
// (xVal/yVal), default-namespace (no c: prefix), and the DoS clamp on idx.
import { describe, it, expect } from 'vitest'
import { parseXml, chartDataFromPart } from '@/lib/document-parser/ooxml'

const chart = (inner: string, ns = 'xmlns:c="c" xmlns:a="a"') =>
  parseXml(`<c:chartSpace ${ns}><c:chart><c:plotArea>${inner}</c:plotArea></c:chart></c:chartSpace>`)

// a barChart series with cached category + value points
const ser = (cats: string, vals: string, tx?: string) =>
  `<c:ser>${tx ? `<c:tx><c:strRef><c:strCache>${tx}</c:strCache></c:strRef></c:tx>` : ''}` +
  `<c:cat><c:strRef><c:strCache>${cats}</c:strCache></c:strRef></c:cat>` +
  `<c:val><c:numRef><c:numCache>${vals}</c:numCache></c:numRef></c:val></c:ser>`
const pts = (...vs: Array<[number, string]>) => vs.map(([i, v]) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')

describe('chartDataFromPart — cached series → CSV', () => {
  it('emits a category column plus one column per series (multi-series)', () => {
    const s1 = ser(pts([0, 'Q1'], [1, 'Q2']), pts([0, '10'], [1, '20']), pts([0, 'Sales']))
    const s2 = ser(pts([0, 'Q1'], [1, 'Q2']), pts([0, '3'], [1, '4']), pts([0, 'Returns']))
    const cd = chartDataFromPart(chart(`<c:barChart>${s1}${s2}</c:barChart>`))
    expect(cd).not.toBeNull()
    expect(cd!.data).toBe('category,Sales,Returns\nQ1,10,3\nQ2,20,4')
  })

  it('honors gaps in c:pt idx (a missing idx is a blank cell, not a shift)', () => {
    // values at idx 0 and 2 — idx 1 is absent → must stay blank, not collapse
    const root = chart(`<c:barChart>${ser(pts([0, 'A'], [1, 'B'], [2, 'C']), pts([0, '1'], [2, '3']), pts([0, 'S']))}</c:barChart>`)
    const cd = chartDataFromPart(root)
    expect(cd!.data).toBe('category,S\nA,1\nB,\nC,3')
  })

  it('orders points by idx even when listed out of order', () => {
    const root = chart(`<c:barChart>${ser(pts([1, 'B'], [0, 'A']), pts([1, '20'], [0, '10']), pts([0, 'S']))}</c:barChart>`)
    const cd = chartDataFromPart(root)
    expect(cd!.data).toBe('category,S\nA,10\nB,20')
  })

  it('falls back to the series name when the chart has no <c:title>', () => {
    const root = chart(`<c:barChart>${ser(pts([0, '2020']), pts([0, '99']), pts([0, 'Headcount']))}</c:barChart>`)
    const cd = chartDataFromPart(root)
    expect(cd!.title).toBe('Headcount')
  })

  it('uses the explicit chart title when present', () => {
    const root = parseXml(
      `<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>My Title</a:t></a:r></a:p></c:rich></c:tx></c:title>` +
        `<c:plotArea><c:barChart>${ser(pts([0, '2020']), pts([0, '99']), pts([0, 'S']))}</c:barChart></c:plotArea></c:chart></c:chartSpace>`,
    )
    expect(chartDataFromPart(root)!.title).toBe('My Title')
  })

  it('parses a default-namespace chart (no c: prefix, as openpyxl/Excel write it)', () => {
    const root = parseXml(
      `<chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="a"><chart><plotArea><barChart>` +
        `<ser><tx><strRef><strCache><pt idx="0"><v>S</v></pt></strCache></strRef></tx>` +
        `<cat><strRef><strCache><pt idx="0"><v>2020</v></pt><pt idx="1"><v>2021</v></pt></strCache></strRef></cat>` +
        `<val><numRef><numCache><pt idx="0"><v>5</v></pt><pt idx="1"><v>6</v></pt></numCache></numRef></val></ser>` +
        `</barChart></plotArea></chart></chartSpace>`,
    )
    expect(chartDataFromPart(root)!.data).toBe('category,S\n2020,5\n2021,6')
  })

  it('returns null for a scatter chart (xVal/yVal, no cat/val) — documented limitation', () => {
    const root = chart(
      `<c:scatterChart><c:ser><c:xVal><c:numRef><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:xVal>` +
        `<c:yVal><c:numRef><c:numCache><c:pt idx="0"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:yVal></c:ser></c:scatterChart>`,
    )
    expect(chartDataFromPart(root)).toBeNull()
  })

  it('returns null when a chart part has no series at all', () => {
    expect(chartDataFromPart(chart('<c:barChart></c:barChart>'))).toBeNull()
  })

  it('clamps a malicious huge c:pt idx so it cannot blow up the CSV builder (CWE-400)', () => {
    // Without the cap, idx=999_999_999 would make ~1e9 rows. The clamp drops any
    // idx >= MAX_CHART_POINTS, so this stays a 2-row chart and returns instantly.
    const root = chart(
      `<c:barChart>${ser(pts([0, 'A'], [1, 'B']), pts([0, '1'], [1, '2'], [999999999, 'BOOM']), pts([0, 'S']))}</c:barChart>`,
    )
    const cd = chartDataFromPart(root)
    expect(cd!.data.split('\n')).toHaveLength(3) // header + 2 rows, not a billion
    expect(cd!.data).not.toContain('BOOM')
  })
})
