// Visual assets (quiz visual questions + tutor inline images): addressing
// must be stable and every model-emitted reference must re-resolve against
// the stored extraction — a hallucinated ref resolves to nothing.

import { describe, it, expect } from 'vitest'
import {
  listAssetUnits,
  findAssetUnit,
  buildUnitsForLLM,
  formatAssetRef,
  parseAssetRef,
} from '@/lib/extraction/assets'
import { getExtractionContextForLLM } from '@/lib/document-parser'

const extraction = {
  tables: [
    { pageNumber: 2, html: '<table><tr><td>A</td></tr></table>' },
    { pageNumber: 2, html: '<table><tr><td>B</td></tr></table>', bbox: { x: 10, y: 20, width: 100, height: 50 } },
  ],
  charts: [{ pageNumber: 5, title: 'Enrollment', data: '2020,1200\n2021,1450' }],
  figures: [{ pageNumber: 5, description: 'a bar chart of revenue by year' }],
}

describe('listAssetUnits / findAssetUnit', () => {
  it('indexes units per (kind, page) in array order', () => {
    const units = listAssetUnits(extraction)
    expect(units).toHaveLength(4)
    // two tables on page 2 → idx 0 and 1
    expect(units.filter((u) => u.kind === 'table').map((u) => u.idx)).toEqual([0, 1])
    // chart and figure both on page 5 but separate kinds → each idx 0
    expect(findAssetUnit(extraction, 'chart', 5, 0)?.text).toContain('2021,1450')
    expect(findAssetUnit(extraction, 'figure', 5, 0)?.text).toContain('bar chart')
  })

  it('second table resolves with its bbox', () => {
    expect(findAssetUnit(extraction, 'table', 2, 1)?.bbox).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })

  it('hallucinated addresses resolve to nothing', () => {
    expect(findAssetUnit(extraction, 'table', 2, 2)).toBeNull() // idx out of range
    expect(findAssetUnit(extraction, 'chart', 4, 0)).toBeNull() // wrong page
    expect(findAssetUnit({}, 'figure', 1, 0)).toBeNull() // no units at all
  })
})

describe('asset refs (tutor)', () => {
  const itemId = '123e4567-e89b-42d3-a456-426614174000'

  it('round-trips format → parse', () => {
    const ref = formatAssetRef(itemId, { kind: 'figure', page: 5, idx: 0 })
    expect(parseAssetRef(ref)).toEqual({ itemId, kind: 'figure', page: 5, idx: 0 })
  })

  it('rejects malformed/forged refs', () => {
    expect(parseAssetRef('not-a-ref')).toBeNull()
    expect(parseAssetRef(`${itemId}:formula:1:0`)).toBeNull() // ineligible kind
    expect(parseAssetRef(`${itemId}:table:1:0:extra`)).toBeNull()
    expect(parseAssetRef('../../etc:table:1:0')).toBeNull() // non-uuid item
  })
})

describe('buildUnitsForLLM + [ASSET] tagging', () => {
  it('tags eligible units with the assigned id in the LLM context', () => {
    const ids: string[] = []
    const units = buildUnitsForLLM(extraction, (u) => {
      const id = `a${ids.length + 1}`
      ids.push(`${u.kind}:${u.page}:${u.idx}`)
      return id
    })
    const text = getExtractionContextForLLM('Deck', [{ pageNumber: 2, text: 'intro', headings: [] }], undefined, units)

    expect(ids).toEqual(['table:2:0', 'table:2:1', 'chart:5:0', 'figure:5:0'])
    expect(text).toContain('Table [ASSET a1]:')
    expect(text).toContain('Chart [ASSET a3] (Enrollment):')
    expect(text).toContain('Figure [ASSET a4] (AI-described):')
  })

  it('leaves blocks untagged when no id assigner is given', () => {
    const units = buildUnitsForLLM(extraction)
    const text = getExtractionContextForLLM('Deck', [], undefined, units)
    expect(text).not.toContain('[ASSET')
    expect(text).toContain('Table:')
  })
})
