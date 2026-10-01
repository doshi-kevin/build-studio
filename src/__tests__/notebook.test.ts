import { describe, it, expect } from 'vitest'
import { parseNotebook, NOTEBOOK_LIMITS } from '@/lib/assignments/notebook'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nb(cells: any[], metadata: Record<string, unknown> = {}): string {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata, cells })
}

describe('parseNotebook — malformed input', () => {
  it('returns null for non-JSON', () => {
    expect(parseNotebook('not a notebook')).toBeNull()
  })
  it('returns null for JSON that is not a notebook (no cells array)', () => {
    expect(parseNotebook('{"foo":1}')).toBeNull()
  })
})

describe('parseNotebook — metadata', () => {
  it('reads language and kernel', () => {
    const parsed = parseNotebook(
      nb([], { language_info: { name: 'python' }, kernelspec: { display_name: 'Python 3' } }),
    )
    expect(parsed?.meta).toEqual({ language: 'python', kernel: 'Python 3' })
  })
})

describe('parseNotebook — cell classification', () => {
  it('classifies by nbgrader metadata, markers, and heuristics', () => {
    const parsed = parseNotebook(
      nb([
        { cell_type: 'markdown', source: '## Question 1' },
        { cell_type: 'code', source: '### BEGIN SOLUTION\nx=1\n### END SOLUTION', metadata: {} },
        { cell_type: 'code', source: 'assert x == 1', metadata: {} },
        { cell_type: 'code', source: 'raise NotImplementedError()', metadata: {} },
        {
          cell_type: 'code',
          source: 'pass',
          metadata: { nbgrader: { solution: true, grade_id: 'q1', schema_version: 3 } },
        },
      ]),
    )
    expect(parsed?.cells.map((c) => c.role)).toEqual([
      'instruction', // markdown
      'solution', // BEGIN SOLUTION marker
      'test', // assert
      'starter', // raise NotImplementedError
      'solution', // nbgrader.solution wins
    ])
  })
})

describe('parseNotebook — outputs', () => {
  it('extracts stream text and truncates long output', () => {
    const long = 'x'.repeat(NOTEBOOK_LIMITS.maxTextChars + 100)
    const parsed = parseNotebook(
      nb([{ cell_type: 'code', source: 'print(1)', outputs: [{ output_type: 'stream', name: 'stdout', text: [long] }] }]),
    )
    const out = parsed?.cells[0].outputs[0]
    expect(out?.type).toBe('text')
    if (out?.type === 'text') {
      expect(out.subtype).toBe('stream_stdout')
      expect(out.truncated).toBe(true)
      expect(out.content.endsWith('… [truncated]')).toBe(true)
    }
  })

  it('strips ANSI escape codes from error tracebacks', () => {
    const parsed = parseNotebook(
      nb([
        {
          cell_type: 'code',
          source: 'boom()',
          outputs: [
            {
              output_type: 'error',
              ename: 'ValueError',
              evalue: 'bad',
              traceback: ['[0;31mValueError[0m: bad'],
            },
          ],
        },
      ]),
    )
    const out = parsed?.cells[0].outputs[0]
    expect(out?.type).toBe('error')
    if (out?.type === 'error') {
      expect(out.errorType).toBe('ValueError')
      expect(out.traceback).toBe('ValueError: bad') // ANSI removed
    }
  })

  it('prefers text/plain over html/latex and emits one text output', () => {
    const parsed = parseNotebook(
      nb([
        {
          cell_type: 'code',
          source: 'df',
          outputs: [
            { output_type: 'execute_result', data: { 'text/html': '<table></table>', 'text/plain': 'a  b' } },
          ],
        },
      ]),
    )
    const outs = parsed?.cells[0].outputs ?? []
    expect(outs).toHaveLength(1)
    expect(outs[0]).toMatchObject({ type: 'text', subtype: 'plain', content: 'a  b' })
  })

  it('surfaces an html-only output as text (never as rendered markup)', () => {
    const parsed = parseNotebook(
      nb([
        {
          cell_type: 'code',
          source: 'render()',
          outputs: [{ output_type: 'execute_result', data: { 'text/html': '<script>alert(1)</script>' } }],
        },
      ]),
    )
    const out = parsed?.cells[0].outputs[0]
    expect(out?.type).toBe('text') // not an image/markup — rendered as escaped text downstream
    if (out?.type === 'text') expect(out.subtype).toBe('html')
  })

  it('keeps small images but omits oversized ones', () => {
    const small = 'aaaa'
    const huge = 'a'.repeat(NOTEBOOK_LIMITS.maxImageBase64Chars + 1)
    const parsed = parseNotebook(
      nb([
        { cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': small } }] },
        { cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': huge } }] },
      ]),
    )
    const first = parsed?.cells[0].outputs[0]
    expect(first?.type).toBe('image')
    if (first?.type === 'image') expect(first.dataBase64).toBe(small)

    const second = parsed?.cells[1].outputs[0]
    expect(second?.type).toBe('text') // oversized → omitted note, not an image
  })
})

describe('parseNotebook — caps + nbgrader', () => {
  it('caps the number of cells and flags truncation', () => {
    const many = Array.from({ length: NOTEBOOK_LIMITS.maxCells + 5 }, () => ({
      cell_type: 'markdown',
      source: 'x',
    }))
    const parsed = parseNotebook(nb(many))
    expect(parsed?.cells.length).toBe(NOTEBOOK_LIMITS.maxCells)
    expect(parsed?.truncated).toBe(true)
  })

  it('extracts nbgrader points and joins array source', () => {
    const parsed = parseNotebook(
      nb([
        {
          cell_type: 'code',
          source: ['def f():\n', '    return 1'],
          metadata: { nbgrader: { grade: true, points: 10, grade_id: 'q1_test', schema_version: 3 } },
        },
      ]),
    )
    expect(parsed?.cells[0].source).toBe('def f():\n    return 1')
    expect(parsed?.cells[0].nbgrader?.points).toBe(10)
    expect(parsed?.cells[0].role).toBe('test')
  })
})
