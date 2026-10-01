/**
 * Keystone test for the notebook studio: the in-app model must round-trip a real .ipynb
 * losslessly (model-level / idempotent) and re-emit valid nbformat 4.
 */
import { describe, it, expect } from 'vitest'
import {
  parseNotebookModel,
  serializeNotebookModel,
  serializeNotebookJson,
  splitSource,
  joinSource,
} from '@/lib/assignments/studio/notebook-model'
import {
  insertRelative,
  deleteCell,
  duplicateCell,
  moveCell,
  splitCell,
  mergeCellBelow,
  toggleLocked,
  changeCellType,
  reorderCells,
  newCell,
  setCellAuthoring,
} from '@/lib/assignments/studio/cell-ops'
import { getAuthoring } from '@/lib/assignments/studio/authoring'
import { notebookToHtml } from '@/components/professor/assignments/studio/shared/export-html'

// A realistic nbformat-4.5 notebook: kernelspec, mixed source forms, code outputs
// (stream + execute_result + image + error), and metadata (tags, nbgrader).
const REAL_IPYNB = {
  cells: [
    {
      cell_type: 'markdown',
      id: 'intro',
      metadata: { tags: ['instruction'] },
      source: ['# Problem Set 3\n', '\n', 'Implement gradient descent.'],
    },
    {
      cell_type: 'code',
      id: 'imports',
      metadata: {},
      execution_count: 1,
      outputs: [],
      source: 'import numpy as np\nimport pandas as pd\n',
    },
    {
      cell_type: 'code',
      id: 'work',
      metadata: { nbgrader: { grade: false, locked: false, solution: true } },
      execution_count: 2,
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['loss: 0.12\n', 'loss: 0.03\n'] },
        {
          output_type: 'execute_result',
          execution_count: 2,
          data: { 'text/plain': ['0.0309'], 'image/png': 'iVBORw0KGgoAAAANS' },
          metadata: {},
        },
      ],
      source: ['def fit(X, y):\n', '    return X.T @ y\n'],
    },
    {
      cell_type: 'code',
      id: 'broken',
      metadata: {},
      execution_count: null,
      outputs: [
        {
          output_type: 'error',
          ename: 'ValueError',
          evalue: 'bad shape',
          traceback: ['[0;31mValueError[0m', 'bad shape'],
        },
      ],
      source: 'raise ValueError("bad shape")',
    },
    { cell_type: 'raw', id: 'rawcell', metadata: {}, source: 'raw passthrough' },
  ],
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
    language_info: { name: 'python', version: '3.11.0' },
  },
  nbformat: 4,
  nbformat_minor: 5,
}

describe('notebook-model — splitSource / joinSource are exact inverses', () => {
  for (const s of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', 'a\n\nb', '\n', 'line1\nline2\nline3']) {
    it(`join(split(${JSON.stringify(s)})) === original`, () => {
      expect(splitSource(s).join('')).toBe(s)
    })
  }
  it('joinSource handles array and string forms', () => {
    expect(joinSource(['a\n', 'b'])).toBe('a\nb')
    expect(joinSource('a\nb')).toBe('a\nb')
    expect(joinSource(undefined)).toBe('')
  })
})

describe('notebook-model — lossless round-trip on a real .ipynb', () => {
  it('parse(serialize(parse(x))) deep-equals parse(x) (idempotent)', () => {
    const once = parseNotebookModel(REAL_IPYNB)!
    const twice = parseNotebookModel(serializeNotebookModel(once))!
    expect(twice).toEqual(once)
  })

  it('serialize(parse(x)) is valid nbformat 4 with outputs preserved verbatim', () => {
    const model = parseNotebookModel(REAL_IPYNB)!
    const out = serializeNotebookModel(model)
    expect(out.nbformat).toBe(4)
    expect(Array.isArray(out.cells)).toBe(true)
    expect(out.cells).toHaveLength(5)
    // Code cells keep outputs + execution_count; markdown/raw must not.
    const work = out.cells.find((c) => c.id === 'work')!
    expect(work.cell_type).toBe('code')
    expect(work.outputs).toEqual(REAL_IPYNB.cells[2].outputs) // verbatim, never executed
    expect(work.execution_count).toBe(2)
    const intro = out.cells.find((c) => c.id === 'intro')!
    expect('outputs' in intro).toBe(false)
    expect('execution_count' in intro).toBe(false)
    // Source serialized back to Jupyter line-array form.
    expect(intro.source).toEqual(['# Problem Set 3\n', '\n', 'Implement gradient descent.'])
  })

  it('serializeNotebookJson emits parseable JSON with a trailing newline', () => {
    const model = parseNotebookModel(REAL_IPYNB)!
    const text = serializeNotebookJson(model)
    expect(text.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(text)).not.toThrow()
    expect(parseNotebookModel(text)).toEqual(model)
  })

  it('rejects non-notebook input', () => {
    expect(parseNotebookModel('not json')).toBeNull()
    expect(parseNotebookModel('{"foo":1}')).toBeNull()
    expect(parseNotebookModel({})).toBeNull()
  })
})

describe('notebook-model — legacy notebook without cell ids', () => {
  const legacy = {
    cells: [
      { cell_type: 'markdown', source: '# Title' },
      { cell_type: 'code', source: 'print(1)', outputs: [], execution_count: null },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 2,
  }

  it('generates stable ids, bumps minor to 5, and still round-trips', () => {
    const once = parseNotebookModel(legacy)!
    expect(once.nbformat_minor).toBe(5)
    expect(once.cells.every((c) => c.id.length > 0)).toBe(true)
    const twice = parseNotebookModel(serializeNotebookModel(once))!
    expect(twice).toEqual(once)
  })
})

describe('cell-ops — pure, immutable, lock-aware', () => {
  const base = parseNotebookModel(REAL_IPYNB)!

  it('insert / delete / duplicate / move change length and order predictably', () => {
    const ins = insertRelative(base, 'imports', 'below', 'markdown')
    expect(ins.nb.cells).toHaveLength(6)
    expect(ins.nb.cells[2].id).toBe(ins.id)
    expect(ins.nb.cells[2].cell_type).toBe('markdown')

    const del = deleteCell(base, 'broken')
    expect(del.cells.find((c) => c.id === 'broken')).toBeUndefined()

    const dup = duplicateCell(base, 'imports')
    expect(dup.nb.cells).toHaveLength(6)
    expect(dup.nb.cells[2].source).toBe(base.cells[1].source)
    expect(dup.nb.cells[2].id).not.toBe('imports')

    const moved = moveCell(base, 'imports', 'up')
    expect(moved.cells[0].id).toBe('imports')
    expect(base.cells[0].id).toBe('intro') // original untouched (immutability)
  })

  it('split then merge restores the original source', () => {
    const src = base.cells.find((c) => c.id === 'work')!.source
    const offset = 10
    const split = splitCell(base, 'work', offset)
    const idx = split.nb.cells.findIndex((c) => c.id === 'work')
    expect(split.nb.cells[idx].source).toBe(src.slice(0, offset))
    expect(split.nb.cells[idx + 1].source).toBe(src.slice(offset))
  })

  it('mergeCellBelow joins source with the cell below and drops one cell', () => {
    const merged = mergeCellBelow(base, 'work')
    expect(merged.cells).toHaveLength(base.cells.length - 1)
    expect(merged.cells.find((c) => c.id === 'broken')).toBeUndefined()
    const work = merged.cells.find((c) => c.id === 'work')!
    expect(work.source).toContain('def fit')
    expect(work.source).toContain('raise ValueError')
  })

  it('locked cells reject edit and delete', () => {
    const locked = toggleLocked(base, 'imports')
    const cell = locked.cells.find((c) => c.id === 'imports')!
    expect(cell.metadata.editable).toBe(false)
    expect(deleteCell(locked, 'imports').cells.find((c) => c.id === 'imports')).toBeDefined()
  })

  it('changeCellType to markdown drops code-only fields', () => {
    const changed = changeCellType(base, 'work', 'markdown')
    const cell = changed.cells.find((c) => c.id === 'work')!
    expect(cell.cell_type).toBe('markdown')
    expect(cell.outputs).toEqual([])
    expect(cell.execution_count).toBeNull()
  })

  it('reorderCells moves a cell to another slot', () => {
    const r = reorderCells(base, 'broken', 'intro')
    expect(r.cells[0].id).toBe('broken')
  })

  it('newCell produces a unique id each call', () => {
    expect(newCell('code').id).not.toBe(newCell('code').id)
  })
})

describe('shared authoring meta — round-trips losslessly inside .ipynb metadata', () => {
  const base = parseNotebookModel(REAL_IPYNB)!

  it('points / explanation / hints / concept tags survive serialize → parse', () => {
    const withMeta = setCellAuthoring(base, 'imports', {
      points: 5,
      explanation: 'use np.polyfit',
      hints: ['import numpy', 'degree 1'],
      conceptTags: ['linear-algebra'],
    })
    const round = parseNotebookModel(serializeNotebookModel(withMeta))!
    const cell = round.cells.find((c) => c.id === 'imports')!
    const a = getAuthoring(cell.metadata)
    expect(a.points).toBe(5)
    expect(a.explanation).toBe('use np.polyfit')
    expect(a.hints).toEqual(['import numpy', 'degree 1'])
    expect(a.conceptTags).toEqual(['linear-algebra'])
  })

  it('clearing authoring removes the metadata key entirely', () => {
    const set = setCellAuthoring(base, 'imports', { points: 3 })
    const cleared = setCellAuthoring(set, 'imports', {})
    const cell = cleared.cells.find((c) => c.id === 'imports')!
    expect('studio' in cell.metadata).toBe(false)
  })
})

describe('shared HTML export — produces a real standalone document', () => {
  it('renders markdown, code, and the title into self-contained HTML', () => {
    const nb = parseNotebookModel(REAL_IPYNB)!
    const html = notebookToHtml(nb, 'My Lab')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('My Lab')
    expect(html).toContain('Problem Set 3') // rendered markdown heading
    expect(html).toContain('raise ValueError') // code cell content (escaped into <pre>)
  })

  it('escapes an attacker-controlled title and language_info.name (no tag or attribute breakout)', () => {
    const nb = parseNotebookModel(REAL_IPYNB)!
    // language_info.name is unvalidated content from an uploaded .ipynb; it is interpolated into
    // a double-quoted data-lang attribute, so a stray quote must not break out of it.
    nb.metadata.language_info = { name: '"><script>alert(1)</script>' }
    const html = notebookToHtml(nb, '"><script>alert(2)</script>')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<script>alert(2)</script>')
    expect(html).not.toContain('"><script') // no attribute breakout survived
    expect(html).toContain('&lt;script&gt;') // present only in escaped form
  })

  it('falls back to data-lang="python" when language_info.name is not a string', () => {
    const nb = parseNotebookModel(REAL_IPYNB)!
    nb.metadata.language_info = { name: 42 }
    const html = notebookToHtml(nb, 'Lab')
    expect(html).toContain('data-lang="python"')
  })
})
