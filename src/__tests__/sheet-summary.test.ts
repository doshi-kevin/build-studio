// @vitest-environment node
//
// What a spreadsheet contributes to the index. The whole decision is "which
// cells", and it has to be right for a reason that is easy to miss: the vector
// built from this text is what a student's question gets matched against, and
// any answer is grounded on it. Sample too little and the sheet is invisible;
// sample the whole thing and you have embedded a dataset, which matches
// everything weakly and nothing well.
import { describe, it, expect } from 'vitest'
import { summarizeSheet, SHEET_SAMPLE_ROWS, SHEET_MAX_COLS } from '@/lib/pinecone/sheet-summary'

/** Build the HTML shape the xlsx extractor stores: one <tr> per row. */
function sheet(rows: string[][], heading?: string) {
  const html = rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')
  return { pageNumber: 1, html, heading }
}

const HEADER = ['student_id', 'quiz', 'score', 'submitted_at']
const row = (i: number) => [`s${i}`, 'Quiz 2', String(60 + i), '2026-03-0' + (i % 9)]

describe('summarizeSheet', () => {
  it('keeps the header and the first N rows, and nothing after', () => {
    const text = summarizeSheet(sheet([HEADER, ...Array.from({ length: 40 }, (_, i) => row(i))]))

    expect(text).toContain('student_id | quiz | score | submitted_at')
    expect(text).toContain('s0 | Quiz 2')
    expect(text).toContain(`s${SHEET_SAMPLE_ROWS - 1} | Quiz 2`)
    // The row after the sample must not be in the vector.
    expect(text).not.toContain(`s${SHEET_SAMPLE_ROWS} | Quiz 2`)
  })

  it('says how many rows it left out', () => {
    // Without this the text reads like a five-row sheet, and "how many students
    // are in the results file" gets answered confidently and wrongly.
    const text = summarizeSheet(sheet([HEADER, ...Array.from({ length: 40 }, (_, i) => row(i))]))
    expect(text).toContain(`${40 - SHEET_SAMPLE_ROWS} more rows not shown`)
  })

  it('does not claim rows were hidden when the sheet is short', () => {
    const text = summarizeSheet(sheet([HEADER, row(1), row(2)]))
    expect(text).not.toMatch(/more rows/)
  })

  it('names the sheet, because a workbook is several of them', () => {
    expect(summarizeSheet(sheet([HEADER, row(1)], 'Results'))).toContain('Sheet: Results')
  })

  it('bounds a very wide sheet', () => {
    const wide = Array.from({ length: 200 }, (_, i) => `col_${i}`)
    const text = summarizeSheet(sheet([wide, wide.map(() => '1')]))
    expect(text).toContain('col_0')
    expect(text).not.toContain(`col_${SHEET_MAX_COLS}`)
  })

  it('strips the extractor\'s HTML rather than embedding markup', () => {
    const text = summarizeSheet(sheet([['<b>name</b>', 'score &amp; rank'], ['Ada', '1']]))
    expect(text).toContain('name')
    expect(text).toContain('score & rank')
    expect(text).not.toContain('<b>')
  })

  it('returns nothing for an empty sheet, so no vector is written', () => {
    expect(summarizeSheet(sheet([]))).toBe('')
    expect(summarizeSheet(sheet([['', ''], ['', '']]))).toBe('')
  })

  it('truncates one enormous cell instead of letting it dominate', () => {
    const text = summarizeSheet(sheet([['notes'], ['x'.repeat(5000)]]))
    expect(text.length).toBeLessThan(600)
  })
})
