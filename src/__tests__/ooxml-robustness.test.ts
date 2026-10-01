// @vitest-environment node
//
// Robustness of the shared OOXML walker (ooxml.ts) against real-world XML quirks
// that break naive parsers (sourced from ECMA-376 + python-docx/openpyxl docs):
// varying/absent namespace prefixes, entity escaping, self-closing tags, CDATA,
// and HTML-safe table rendering.
import { describe, it, expect } from 'vitest'
import {
  parseXml,
  findAll,
  findFirst,
  childrenNamed,
  textOf,
  escapeHtml,
  rowsToHtmlTable,
  decodeXmlEntities,
} from '@/lib/document-parser/ooxml'

describe('ooxml walker — namespace prefixes are not fixed', () => {
  it('matches the same local name whether prefixed (w:tbl) or default-namespaced (tbl)', () => {
    const prefixed = parseXml('<root xmlns:w="w"><w:tbl><w:tr/></w:tbl></root>')
    const defaulted = parseXml('<root xmlns="w"><tbl><tr/></tbl></root>')
    expect(findAll(prefixed, 'tbl')).toHaveLength(1)
    expect(findAll(defaulted, 'tbl')).toHaveLength(1)
  })

  it('finds an element under an unexpected prefix (x: instead of the usual)', () => {
    const root = parseXml('<x:worksheet xmlns:x="s"><x:sheetData><x:row r="1"/></x:sheetData></x:worksheet>')
    expect(findAll(root, 'row')).toHaveLength(1)
    expect(findFirst(root, 'sheetData')).toBeDefined()
  })
})

describe('ooxml walker — text & entities', () => {
  it('decodes XML entities in text content', () => {
    const root = parseXml('<a:t xmlns:a="a">Tom &amp; Jerry &lt;3 &gt; &quot;x&quot; &apos;y&apos;</a:t>')
    expect(textOf(root)).toBe(`Tom & Jerry <3 > "x" 'y'`)
  })

  it('decodeXmlEntities handles the five predefined entities', () => {
    expect(decodeXmlEntities('a &amp;&lt;&gt;&quot;&apos; b')).toBe(`a &<>"' b`)
  })

  it('reads text out of a CDATA section verbatim', () => {
    const root = parseXml('<a:t xmlns:a="a"><![CDATA[ raw <not a tag> & ok ]]></a:t>')
    expect(textOf(root)).toContain('raw <not a tag> & ok')
  })

  it('concatenates text across nested runs (a:p > a:r > a:t)', () => {
    const root = parseXml('<a:p xmlns:a="a"><a:r><a:t>Hello </a:t></a:r><a:r><a:t>World</a:t></a:r></a:p>')
    expect(textOf(root).replace(/\s+/g, ' ').trim()).toBe('Hello World')
  })
})

describe('ooxml walker — element shapes', () => {
  it('parses self-closing tags as childless nodes that still carry attributes', () => {
    // <w:vMerge/> (no val) is meaningful — a vertical-merge continuation cell.
    const root = parseXml('<w:tc xmlns:w="w"><w:tcPr><w:vMerge/></w:tcPr></w:tc>')
    const vMerge = findFirst(root, 'vMerge')
    expect(vMerge).toBeDefined()
    expect(vMerge!.children).toHaveLength(0)
    const gridSpan = parseXml('<w:tc xmlns:w="w"><w:gridSpan w:val="2"/></w:tc>')
    expect(findFirst(gridSpan, 'gridSpan')!.attrs['w:val']).toBe('2')
  })

  it('childrenNamed returns only DIRECT children (not nested-table rows)', () => {
    // a w:tbl whose first cell contains a NESTED w:tbl — outer row count must be 2.
    const xml = `<w:tbl xmlns:w="w">
      <w:tr><w:tc><w:tbl><w:tr/><w:tr/></w:tbl></w:tc></w:tr>
      <w:tr><w:tc/></w:tr>
    </w:tbl>`
    const outer = findFirst(parseXml(xml), 'tbl')!
    expect(childrenNamed(outer, 'tr')).toHaveLength(2) // direct rows only
    expect(findAll(outer, 'tr')).toHaveLength(4) // recursive sees nested too
  })

  it('tolerates XML declaration, comments, and processing instructions', () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><w:p xmlns:w="w"><w:t>ok</w:t></w:p>')
    expect(textOf(root)).toBe('ok')
  })
})

describe('ooxml walker — HTML-safe rendering', () => {
  it('escapeHtml neutralizes tag/amp characters from cell content', () => {
    expect(escapeHtml('<script>a & b')).toBe('&lt;script&gt;a &amp; b')
  })

  it('rowsToHtmlTable escapes cell text and honors colspan via cellSpec', () => {
    const xml = `<a:tbl xmlns:a="a">
      <a:tr><a:tc gridSpan="2"><a:t>&lt;b&gt;Head&lt;/b&gt;</a:t></a:tc></a:tr>
      <a:tr><a:tc><a:t>x</a:t></a:tc><a:tc><a:t>y</a:t></a:tc></a:tr>
    </a:tbl>`
    const tbl = findFirst(parseXml(xml), 'tbl')!
    const html = rowsToHtmlTable(childrenNamed(tbl, 'tr'), 'tc', (tc) => ({
      colSpan: Number(tc.attrs.gridSpan ?? '1'),
    }))
    expect(html).toContain('colspan="2"')
    expect(html).toContain('&lt;b&gt;Head&lt;/b&gt;') // escaped, no raw <b>
    expect(html).not.toContain('<b>Head</b>')
    expect(html).toContain('<td>x</td><td>y</td>')
  })
})
