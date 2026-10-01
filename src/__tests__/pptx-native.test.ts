// @vitest-environment node
//
// Phase 1 of hybrid extraction (docs/designs/quizzes/hybrid-extraction-and-citation.md §13.4):
// PPTX native tables (a:tbl → HTML), monospace → code, and image alt-text (descr).
// Builds a minimal .pptx in memory and runs the real extractPptx with a stubbed
// Supabase admin client (no network), asserting the structured outputs.
import { describe, it, expect } from 'vitest'
import { zipSync } from 'fflate'
import type { SupabaseClient } from '@supabase/supabase-js'
import { extractPptx } from '@/lib/document-parser/pptx'

// Runs in the `node` environment (docblock above): fflate's Uint8Array
// instanceof check fails under jsdom's swapped global, mangling zip entries.

const SLIDE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="a" xmlns:r="r" xmlns:p="p" xmlns:m="m">
 <p:cSld><p:spTree>
  <p:sp><p:txBody><a:p><a:r><a:t>Intro text on the slide</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:txBody>
    <a:p><a:r><a:rPr><a:latin typeface="Consolas"/></a:rPr><a:t>def f(x):</a:t></a:r></a:p>
    <a:p><a:r><a:rPr><a:latin typeface="Consolas"/></a:rPr><a:t>    return x + 1</a:t></a:r></a:p>
  </p:txBody></p:sp>
  <p:graphicFrame><a:graphic><a:graphicData>
   <a:tbl>
    <a:tblGrid><a:gridCol w="100"/><a:gridCol w="100"/></a:tblGrid>
    <a:tr h="30">
     <a:tc><a:txBody><a:p><a:r><a:t>Year</a:t></a:r></a:p></a:txBody></a:tc>
     <a:tc><a:txBody><a:p><a:r><a:t>Count</a:t></a:r></a:p></a:txBody></a:tc>
    </a:tr>
    <a:tr h="30">
     <a:tc><a:txBody><a:p><a:r><a:t>2020</a:t></a:r></a:p></a:txBody></a:tc>
     <a:tc><a:txBody><a:p><a:r><a:t>1200</a:t></a:r></a:p></a:txBody></a:tc>
    </a:tr>
   </a:tbl>
  </a:graphicData></a:graphic></p:graphicFrame>
  <p:pic>
   <p:nvPicPr><p:cNvPr id="5" name="Picture 1" descr="A bar chart of revenue"/></p:nvPicPr>
   <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
  </p:pic>
 </p:spTree></p:cSld>
</p:sld>`

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="rel">
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`

// Build a one-slide .pptx from arbitrary slide XML (+ optional rels). An image
// is uploaded only if the rels reference it, so an empty rels → no images[].
function pptxOf(slideXml: string, relsXml: string = RELS_XML): Buffer {
  return Buffer.from(
    zipSync({
      'ppt/slides/slide1.xml': Buffer.from(slideXml, 'utf8'),
      'ppt/slides/_rels/slide1.xml.rels': Buffer.from(relsXml, 'utf8'),
      'ppt/media/image1.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
    }),
  )
}

function buildPptx(): Buffer {
  return pptxOf(SLIDE_XML)
}

// A chart part (c:chartSpace) + a minimal slide that draws it — shared by the
// chart-anchoring tests. The slide references the chart via its rels, not inline.
const CHART_XML = `<?xml version="1.0"?>
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
const CHART_SLIDE_PROSE = `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:graphicFrame/></p:spTree></p:cSld></p:sld>`

// Minimal Supabase admin stub — extractPptx only touches storage.from().upload()/getPublicUrl().
const adminStub = {
  storage: {
    from: () => ({
      upload: async () => ({ error: null }),
      getPublicUrl: () => ({ data: { publicUrl: 'https://example.test/media/image1.png' } }),
    }),
  },
} as unknown as SupabaseClient

const opts = { sectionId: 's', moduleItemId: 'm', adminClient: adminStub }

describe('extractPptx — native tables / code / alt-text (Phase 1)', () => {
  it('extracts a native table as HTML with correct dims and source', async () => {
    const res = await extractPptx(buildPptx(), {
      sectionId: 'sec1',
      moduleItemId: 'mi1',
      adminClient: adminStub,
    })

    expect(res.status).toBe('completed')
    expect(res.tablesStatus).toBe('completed')
    expect(res.tables).toHaveLength(1)
    const t = res.tables![0]
    expect(t.source).toBe('native')
    expect(t.rows).toBe(2)
    expect(t.cols).toBe(2)
    expect(t.pageNumber).toBe(1)
    expect(t.html.startsWith('<table>')).toBe(true)
    expect(t.html).toContain('<td>Year</td>')
    expect(t.html).toContain('<td>1200</td>')
  })

  it('detects a monospace text box as a code unit', async () => {
    const res = await extractPptx(buildPptx(), { sectionId: 's', moduleItemId: 'm', adminClient: adminStub })
    expect(res.code).toHaveLength(1)
    const c = res.code![0]
    expect(c.source).toBe('native')
    expect(c.code).toContain('def f(x):')
    expect(c.code).toContain('return x + 1')
    expect(c.code).toContain('\n') // paragraph breaks preserved
  })

  it('detects a non-monospace (proportional-font) code box via the content heuristic, with a language guess', async () => {
    // Same code as the monospace test but set in Arial — no font signal, so it
    // must be caught by looksLikeCode() and tagged with a guessed language.
    const CODE_ARIAL = `<?xml version="1.0"?>
<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody>
 <a:p><a:r><a:rPr><a:latin typeface="Arial"/></a:rPr><a:t>def binary_search(arr, target):</a:t></a:r></a:p>
 <a:p><a:r><a:rPr><a:latin typeface="Arial"/></a:rPr><a:t>    lo, hi = 0, len(arr) - 1</a:t></a:r></a:p>
 <a:p><a:r><a:rPr><a:latin typeface="Arial"/></a:rPr><a:t>    while lo &lt;= hi:</a:t></a:r></a:p>
 <a:p><a:r><a:rPr><a:latin typeface="Arial"/></a:rPr><a:t>        if arr[mid] == target: return mid</a:t></a:r></a:p>
</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    const EMPTY_RELS = `<?xml version="1.0"?><Relationships xmlns="rel"></Relationships>`
    const res = await extractPptx(pptxOf(CODE_ARIAL, EMPTY_RELS), opts)
    expect(res.code).toHaveLength(1)
    expect(res.code![0].source).toBe('native')
    expect(res.code![0].language).toBe('python')
    expect(res.code![0].code).toContain('def binary_search')
  })

  it('attaches author descr alt-text to the right image', async () => {
    const res = await extractPptx(buildPptx(), { sectionId: 's', moduleItemId: 'm', adminClient: adminStub })
    expect(res.images).toHaveLength(1)
    expect(res.images![0].altText).toBe('A bar chart of revenue')
  })

  it('also emits the author descr as a native figure unit anchored to its slide', async () => {
    // The asset registry reads figures[], not images[].altText, so a described
    // PPTX image must surface as a figure unit (mirrors docx.ts) or it is
    // invisible to visual questions / the tutor.
    const res = await extractPptx(buildPptx(), { sectionId: 's', moduleItemId: 'm', adminClient: adminStub })
    expect(res.figures).toHaveLength(1)
    const f = res.figures![0]
    expect(f.source).toBe('native')
    expect(f.description).toBe('A bar chart of revenue')
    expect(f.pageNumber).toBe(1)
  })

  it('anchors a figure to the specific slide that carries the descr (multi-slide)', async () => {
    // Only slide 2 holds the described picture — proves pageNumber tracks the
    // real slide rather than a hardcoded 1.
    const PIC_SLIDE = `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:r="r" xmlns:p="p"><p:cSld><p:spTree>
 <p:pic><p:nvPicPr><p:cNvPr id="9" name="Picture 2" descr="A revenue line chart"/></p:nvPicPr>
  <p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
</p:spTree></p:cSld></p:sld>`
    const PLAIN_SLIDE = `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Intro slide, no picture.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    const EMPTY = `<?xml version="1.0"?><Relationships xmlns="rel"></Relationships>`
    const buf = Buffer.from(
      zipSync({
        'ppt/slides/slide1.xml': Buffer.from(PLAIN_SLIDE, 'utf8'),
        'ppt/slides/_rels/slide1.xml.rels': Buffer.from(EMPTY, 'utf8'),
        'ppt/slides/slide2.xml': Buffer.from(PIC_SLIDE, 'utf8'),
        'ppt/slides/_rels/slide2.xml.rels': Buffer.from(RELS_XML, 'utf8'),
        'ppt/media/image1.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
      }),
    )
    const res = await extractPptx(buf, opts)
    expect(res.figures).toHaveLength(1)
    expect(res.figures![0].pageNumber).toBe(2)
    expect(res.figures![0].description).toBe('A revenue line chart')
  })

  it('does not treat prose text boxes as code', async () => {
    const res = await extractPptx(buildPptx(), { sectionId: 's', moduleItemId: 'm', adminClient: adminStub })
    // only the monospace box, not the "Intro text" box
    expect(res.code).toHaveLength(1)
  })

  it('preserves merged cells (colspan/rowspan) and drops continuation cells', async () => {
    const MERGED = `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData><a:tbl>
<a:tblGrid><a:gridCol/><a:gridCol/><a:gridCol/></a:tblGrid>
<a:tr><a:tc gridSpan="2"><a:txBody><a:p><a:r><a:t>Merged Header</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:p><a:r><a:t>HMERGECONT</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Solo</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
<a:tr><a:tc rowSpan="2"><a:txBody><a:p><a:r><a:t>Tall</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>b</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>c</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
<a:tr><a:tc vMerge="1"><a:txBody><a:p><a:r><a:t>VMERGECONT</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>e</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>f</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`
    const res = await extractPptx(pptxOf(MERGED), opts)
    const t = res.tables![0]
    expect(t.rows).toBe(3)
    expect(t.cols).toBe(3)
    expect(t.html).toContain('colspan="2"')
    expect(t.html).toContain('rowspan="2"')
    expect(t.html).toContain('Merged Header')
    // hMerge/vMerge continuation cells are covered by the anchor — not emitted
    expect(t.html).not.toContain('HMERGECONT')
    expect(t.html).not.toContain('VMERGECONT')
  })

  it('escapes HTML-significant characters in cell text', async () => {
    // The a:t content below decodes to:  <script>x</script> & y
    const ESC = `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol/></a:tblGrid><a:tr><a:tc><a:txBody><a:p><a:r><a:t>&lt;script&gt;x&lt;/script&gt; &amp; y</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`
    const res = await extractPptx(pptxOf(ESC), opts)
    const html = res.tables![0].html
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt; &amp; y')
    expect(html).not.toContain('<script>') // never emit a raw tag from cell text
  })

  it('extracts native chart series data (c:ser numCache) anchored to its slide', async () => {
    const RELS = `<?xml version="1.0"?><Relationships xmlns="rel"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`
    const buf = Buffer.from(
      zipSync({
        'ppt/slides/slide1.xml': Buffer.from(CHART_SLIDE_PROSE, 'utf8'),
        'ppt/slides/_rels/slide1.xml.rels': Buffer.from(RELS, 'utf8'),
        'ppt/charts/chart1.xml': Buffer.from(CHART_XML, 'utf8'),
      }),
    )
    const res = await extractPptx(buf, opts)
    expect(res.charts).toHaveLength(1)
    const c = res.charts![0]
    expect(c.pageNumber).toBe(1)
    expect(c.source).toBe('native')
    expect(c.title).toBe('Enrollment by year')
    expect(c.data).toBe('category,Enrollment\n2020,1200\n2021,1450')
  })

  it('anchors a chart to the specific slide that references it (multi-slide)', async () => {
    // Only slide 2 references the chart — proves slideChartMap resolves the real
    // slide number rather than hardcoding 1 (which the single-slide case can't catch).
    const EMPTY_RELS = `<?xml version="1.0"?><Relationships xmlns="rel"></Relationships>`
    const RELS2 = `<?xml version="1.0"?><Relationships xmlns="rel"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`
    const buf = Buffer.from(
      zipSync({
        'ppt/slides/slide1.xml': Buffer.from(CHART_SLIDE_PROSE, 'utf8'),
        'ppt/slides/_rels/slide1.xml.rels': Buffer.from(EMPTY_RELS, 'utf8'),
        'ppt/slides/slide2.xml': Buffer.from(CHART_SLIDE_PROSE, 'utf8'),
        'ppt/slides/_rels/slide2.xml.rels': Buffer.from(RELS2, 'utf8'),
        'ppt/charts/chart1.xml': Buffer.from(CHART_XML, 'utf8'),
      }),
    )
    const res = await extractPptx(buf, opts)
    expect(res.charts).toHaveLength(1)
    expect(res.charts![0].pageNumber).toBe(2)
  })

  it('returns undefined (not []) for tables/code/images when a slide has none', async () => {
    const PROSE = `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Just some prose, no tables or code here.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    const EMPTY_RELS = `<?xml version="1.0"?><Relationships xmlns="rel"></Relationships>`
    const res = await extractPptx(pptxOf(PROSE, EMPTY_RELS), opts)
    expect(res.status).toBe('completed')
    expect(res.tablesStatus).toBe('completed')
    expect(res.tables).toBeUndefined()
    expect(res.code).toBeUndefined()
    expect(res.images).toBeUndefined()
    expect(res.charts).toBeUndefined()
    expect(res.figures).toBeUndefined() // no descr → no figure unit (not [])
    expect(res.pages[0].text).toContain('prose')
  })
})
