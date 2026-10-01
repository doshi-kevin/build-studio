// @vitest-environment node
//
// Phase 5b — XLSX native extraction: each worksheet → an exact HTML grid (shared
// strings resolved), and chart series DATA (c:ser numCache/strCache) → CSV, $0.
// Builds a minimal .xlsx in memory and runs the real extractXlsx (no Storage).
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'
import { zipSync } from 'fflate'
import { extractXlsx } from '@/lib/document-parser/xlsx'

const SHARED = `<?xml version="1.0"?>
<sst xmlns="s"><si><t>Year</t></si><si><t>Enrollment</t></si><si><t>2020</t></si></sst>`

// A1=Year B1=Enrollment (shared) / A2=2020 (shared) B2=1200 (numeric).
const SHEET = `<?xml version="1.0"?>
<worksheet xmlns="s"><sheetData>
 <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
 <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row>
</sheetData></worksheet>`

const CHART = `<?xml version="1.0"?>
<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart>
 <c:title><c:tx><c:rich><a:p><a:r><a:t>Enrollment by year</a:t></a:r></a:p></c:rich></c:tx></c:title>
 <c:plotArea><c:barChart><c:ser>
  <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Enrollment</c:v></c:pt></c:strCache></c:strRef></c:tx>
  <c:cat><c:strRef><c:strCache>
   <c:pt idx="0"><c:v>2020</c:v></c:pt><c:pt idx="1"><c:v>2021</c:v></c:pt>
  </c:strCache></c:strRef></c:cat>
  <c:val><c:numRef><c:numCache>
   <c:pt idx="0"><c:v>1200</c:v></c:pt><c:pt idx="1"><c:v>1450</c:v></c:pt>
  </c:numCache></c:numRef></c:val>
 </c:ser></c:barChart></c:plotArea>
</c:chart></c:chartSpace>`

function buildXlsx(parts: Record<string, string>): Buffer {
  const files: Record<string, Uint8Array> = {}
  for (const [k, v] of Object.entries(parts)) files[k] = Buffer.from(v, 'utf8')
  return Buffer.from(zipSync(files))
}

const opts = { sectionId: 's', moduleItemId: 'm' }

describe('extractXlsx — native sheets + chart data (Phase 5b)', () => {
  it('reads a worksheet as an exact HTML grid with shared strings resolved', async () => {
    const res = await extractXlsx(
      buildXlsx({ 'xl/sharedStrings.xml': SHARED, 'xl/worksheets/sheet1.xml': SHEET }),
      opts,
    )
    expect(res.status).toBe('completed')
    expect(res.tablesStatus).toBe('completed')
    expect(res.tables).toHaveLength(1)
    const t = res.tables![0]
    expect(t.source).toBe('native')
    expect(t.rows).toBe(2)
    expect(t.cols).toBe(2)
    expect(t.html).toContain('<td>Year</td>')
    expect(t.html).toContain('<td>Enrollment</td>')
    expect(t.html).toContain('<td>2020</td>')
    expect(t.html).toContain('<td>1200</td>')
  })

  it('numbers each sheet as its own page', async () => {
    const res = await extractXlsx(
      buildXlsx({
        'xl/sharedStrings.xml': SHARED,
        'xl/worksheets/sheet1.xml': SHEET,
        'xl/worksheets/sheet2.xml': SHEET,
      }),
      opts,
    )
    expect(res.metadata.pageCount).toBe(2)
    expect(res.tables!.map((t) => t.pageNumber)).toEqual([1, 2])
  })

  it('de-plots chart series into exact (label,value) CSV with a title', async () => {
    const res = await extractXlsx(
      buildXlsx({ 'xl/worksheets/sheet1.xml': SHEET, 'xl/charts/chart1.xml': CHART }),
      opts,
    )
    expect(res.charts).toHaveLength(1)
    const c = res.charts![0]
    expect(c.source).toBe('native')
    expect(c.title).toBe('Enrollment by year')
    expect(c.data).toBe('category,Enrollment\n2020,1200\n2021,1450')
  })

  it('returns undefined (not []) for charts when there are none', async () => {
    const res = await extractXlsx(buildXlsx({ 'xl/worksheets/sheet1.xml': SHEET }), opts)
    expect(res.charts).toBeUndefined()
  })

  it('fails gracefully when there are no worksheets', async () => {
    const res = await extractXlsx(buildXlsx({ 'xl/sharedStrings.xml': SHARED }), opts)
    expect(res.status).toBe('failed')
  })

  it('fails gracefully on a non-xlsx buffer', async () => {
    const res = await extractXlsx(Buffer.from('not a zip'), opts)
    expect(res.status).toBe('failed')
    expect(res.tablesStatus).toBe('failed')
  })
})

// ── Real-world cell-value quirks (ECMA-376 §18.3.1.4 cell types) ──────────────
describe('extractXlsx — cell-value types & sparse/quirky cells', () => {
  const SS = `<?xml version="1.0"?><sst xmlns="s"><si><t>Shared</t></si></sst>`

  it('resolves every cell type: shared, inline, number, boolean, formula-string', async () => {
    // A1 shared(idx0), B1 inline, C1 number(no t), D1 boolean, E1 formula→str
    const sheet = `<?xml version="1.0"?><worksheet xmlns="s"><sheetData><row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="inlineStr"><is><t>Inline</t></is></c>
      <c r="C1"><v>42.5</v></c>
      <c r="D1" t="b"><v>1</v></c>
      <c r="E1" t="str"><f>CONCAT("a","b")</f><v>ab</v></c>
    </row></sheetData></worksheet>`
    const res = await extractXlsx(buildXlsx({ 'xl/sharedStrings.xml': SS, 'xl/worksheets/sheet1.xml': sheet }), opts)
    const html = res.tables![0].html
    expect(html).toContain('<td>Shared</td>')
    expect(html).toContain('<td>Inline</td>')
    expect(html).toContain('<td>42.5</td>')
    expect(html).toContain('<td>TRUE</td>') // t="b" 1 → TRUE, not "1"
    expect(html).toContain('<td>ab</td>') // formula cached string result
    expect(res.tables![0].cols).toBe(5)
  })

  it('keeps sparse cells aligned by their r= ref (A1 then D1, B/C blank)', async () => {
    // A naive positional parser would put D1 in column B. We read the r attribute.
    const sheet = `<?xml version="1.0"?><worksheet xmlns="s"><sheetData>
      <row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row>
    </sheetData></worksheet>`
    const res = await extractXlsx(buildXlsx({ 'xl/worksheets/sheet1.xml': sheet }), opts)
    const t = res.tables![0]
    expect(t.cols).toBe(4) // A..D
    expect(t.html).toBe('<table><tr><td>1</td><td></td><td></td><td>4</td></tr></table>')
  })

  it('parses multi-letter column refs (bijective base-26: AA = column 27)', async () => {
    const sheet = `<?xml version="1.0"?><worksheet xmlns="s"><sheetData>
      <row r="1"><c r="A1"><v>first</v></c><c r="AA1"><v>last</v></c></row>
    </sheetData></worksheet>`
    const res = await extractXlsx(buildXlsx({ 'xl/worksheets/sheet1.xml': sheet }), opts)
    expect(res.tables![0].cols).toBe(27) // A(1)…AA(27)
    expect(res.tables![0].html).toContain('<td>first</td><td></td>')
    expect(res.tables![0].html).toContain('<td>last</td></tr>')
  })

  it('concatenates rich-text shared-string runs into one cell value', async () => {
    const ss = `<?xml version="1.0"?><sst xmlns="s"><si><r><t>Hello </t></r><r><t>World</t></r></si></sst>`
    const sheet = `<?xml version="1.0"?><worksheet xmlns="s"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`
    const res = await extractXlsx(buildXlsx({ 'xl/sharedStrings.xml': ss, 'xl/worksheets/sheet1.xml': sheet }), opts)
    expect(res.tables![0].html).toContain('<td>Hello World</td>')
  })
})

// ── Chart formula-ref resolution (no numCache — openpyxl & friends) ───────────
describe('extractXlsx — chart data from formula refs (no cache)', () => {
  it('resolves cat/val/series-name refs against the named sheet', async () => {
    // The chart caches nothing — only <c:f> refs into a sheet named "Data".
    const wb = `<?xml version="1.0"?><workbook xmlns="s" xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`
    const wbRels = `<?xml version="1.0"?><Relationships xmlns="rel"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>`
    const sheet = `<?xml version="1.0"?><worksheet xmlns="s"><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Year</t></is></c><c r="B1" t="inlineStr"><is><t>Sales</t></is></c></row>
      <row r="2"><c r="A2"><v>2020</v></c><c r="B2"><v>500</v></c></row>
      <row r="3"><c r="A3"><v>2021</v></c><c r="B3"><v>650</v></c></row>
    </sheetData></worksheet>`
    const chart = `<?xml version="1.0"?><c:chartSpace xmlns:c="c"><c:chart><c:plotArea><c:barChart><c:ser>
      <c:tx><c:strRef><c:f>Data!$B$1</c:f></c:strRef></c:tx>
      <c:cat><c:numRef><c:f>Data!$A$2:$A$3</c:f></c:numRef></c:cat>
      <c:val><c:numRef><c:f>Data!$B$2:$B$3</c:f></c:numRef></c:val>
    </c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`
    const res = await extractXlsx(
      buildXlsx({
        'xl/workbook.xml': wb,
        'xl/_rels/workbook.xml.rels': wbRels,
        'xl/worksheets/sheet1.xml': sheet,
        'xl/charts/chart1.xml': chart,
      }),
      opts,
    )
    expect(res.charts).toHaveLength(1)
    expect(res.charts![0].title).toBe('Sales') // resolved from B1
    expect(res.charts![0].data).toBe('category,Sales\n2020,500\n2021,650')
  })
})

// ── Real Excel binary (openpyxl-generated, fixtures/office/gen_chart.xlsx) ─────
describe('extractXlsx — real .xlsx fixture (openpyxl, formula-ref chart)', () => {
  const FIXTURE = path.resolve(process.cwd(), 'src/__tests__/fixtures/office/gen_chart.xlsx')
  it('reads the sheet grid and de-plots a two-series chart from formula refs', async () => {
    if (!existsSync(FIXTURE)) return
    const res = await extractXlsx(readFileSync(FIXTURE), opts)
    expect(res.status).toBe('completed')
    expect(res.tables?.[0]?.rows).toBeGreaterThanOrEqual(5)
    // openpyxl writes <c:f> refs with no cache → exercises the ref-resolution path
    expect(res.charts).toHaveLength(1)
    const c = res.charts![0]
    expect(c.title).toBe('Enrollment vs Graduates by Year')
    expect(c.data).toBe('category,Enrollment,Graduates\n2020,1200,240\n2021,1450,310\n2022,1700,360\n2023,2050,420\n2024,2400,510')
  })
})
