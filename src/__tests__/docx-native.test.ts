// @vitest-environment node
//
// Phase 5 — DOCX native extraction (text, headings, w:tbl tables, descr alt-text).
// Builds a minimal .docx in memory and runs the real extractDocx (no Storage).
import { describe, it, expect } from 'vitest'
import { zipSync } from 'fflate'
import { extractDocx } from '@/lib/document-parser/docx'

const DOC_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="w" xmlns:wp="wp" xmlns:a="a">
 <w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p>
  <w:p><w:r><w:t>Some body text here.</w:t></w:r></w:p>
  <w:tbl>
    <w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>
    <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Merged Head</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Pic 1" descr="a flow chart of the pipeline"/></wp:inline></w:drawing></w:r></w:p>
 </w:body>
</w:document>`

function buildDocx(): Buffer {
  return Buffer.from(zipSync({ 'word/document.xml': Buffer.from(DOC_XML, 'utf8') }))
}

const opts = { sectionId: 's', moduleItemId: 'm' }

describe('extractDocx — native text / headings / tables / alt-text (Phase 5)', () => {
  it('extracts body text and heading-styled paragraphs', async () => {
    const res = await extractDocx(buildDocx(), opts)
    expect(res.status).toBe('completed')
    expect(res.pages).toHaveLength(1)
    expect(res.pages[0].text).toContain('Some body text here.')
    expect(res.pages[0].headings).toContain('Overview')
  })

  it('extracts a native w:tbl as HTML with gridSpan→colspan', async () => {
    const res = await extractDocx(buildDocx(), opts)
    expect(res.tablesStatus).toBe('completed')
    expect(res.tables).toHaveLength(1)
    const t = res.tables![0]
    expect(t.source).toBe('native')
    expect(t.rows).toBe(2)
    expect(t.cols).toBe(2)
    expect(t.html).toContain('colspan="2"')
    expect(t.html).toContain('Merged Head')
    expect(t.html).toContain('<td>a</td>')
    expect(t.html).toContain('<td>b</td>')
  })

  it('turns drawing alt-text (descr) into a native figure description', async () => {
    const res = await extractDocx(buildDocx(), opts)
    expect(res.figures).toHaveLength(1)
    expect(res.figures![0]).toMatchObject({ pageNumber: 1, description: 'a flow chart of the pipeline', source: 'native' })
  })

  it('drops vMerge continuation cells (w:vMerge with no/!=restart val)', async () => {
    const VMERGE_XML = `<?xml version="1.0"?>
<w:document xmlns:w="w">
 <w:body>
  <w:tbl>
    <w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>
    <w:tr>
      <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Anchor</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t>CONTINUATION</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>y</w:t></w:r></w:p></w:tc>
    </w:tr>
  </w:tbl>
 </w:body>
</w:document>`
    const buf = Buffer.from(zipSync({ 'word/document.xml': Buffer.from(VMERGE_XML, 'utf8') }))
    const res = await extractDocx(buf, opts)
    const html = res.tables![0].html
    // Anchor row keeps both cells; continuation cell is dropped, sibling stays.
    expect(html).toContain('Anchor')
    expect(html).not.toContain('CONTINUATION')
    expect(html).toContain('<td>y</td>')
  })

  it('extracts native chart series data from word/charts (same parser as PPTX/XLSX)', async () => {
    const CHART = `<?xml version="1.0"?>
<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart>
 <c:title><c:tx><c:rich><a:p><a:r><a:t>Headcount</a:t></a:r></a:p></c:rich></c:tx></c:title>
 <c:plotArea><c:barChart><c:ser>
  <c:cat><c:strRef><c:strCache>
   <c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt>
  </c:strCache></c:strRef></c:cat>
  <c:val><c:numRef><c:numCache>
   <c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt>
  </c:numCache></c:numRef></c:val>
 </c:ser></c:barChart></c:plotArea>
</c:chart></c:chartSpace>`
    const PLAIN = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>See chart.</w:t></w:r></w:p></w:body></w:document>`
    const buf = Buffer.from(
      zipSync({
        'word/document.xml': Buffer.from(PLAIN, 'utf8'),
        'word/charts/chart1.xml': Buffer.from(CHART, 'utf8'),
      }),
    )
    const res = await extractDocx(buf, opts)
    expect(res.charts).toHaveLength(1)
    expect(res.charts![0]).toMatchObject({ pageNumber: 1, title: 'Headcount', source: 'native' })
    expect(res.charts![0].data).toBe('category,series1\nQ1,10\nQ2,20')
  })

  it('returns undefined (not []) for tables/figures/charts when the doc has none', async () => {
    const PLAIN = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Just prose.</w:t></w:r></w:p></w:body></w:document>`
    const buf = Buffer.from(zipSync({ 'word/document.xml': Buffer.from(PLAIN, 'utf8') }))
    const res = await extractDocx(buf, opts)
    expect(res.status).toBe('completed')
    expect(res.tables).toBeUndefined()
    expect(res.figures).toBeUndefined()
    expect(res.charts).toBeUndefined()
  })

  it('fails gracefully on a non-docx buffer', async () => {
    const res = await extractDocx(Buffer.from('not a zip'), opts)
    expect(res.status).toBe('failed')
    expect(res.tablesStatus).toBe('failed')
  })
})
