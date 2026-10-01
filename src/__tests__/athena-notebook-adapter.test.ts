import { describe, it, expect } from 'vitest'
import { applyNotebookOps, serializeNotebookForAthena } from '@/lib/assignments/studio/athena-notebook-adapter'
import { newCell } from '@/lib/assignments/studio/cell-ops'
import type { StudioNotebook } from '@/lib/assignments/studio/notebook-model'
import type { NotebookOp } from '@/lib/ai/assignment-assistant/templates/registry'

function nbOf(...cells: ReturnType<typeof newCell>[]): StudioNotebook {
  return { cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }
}

describe('applyNotebookOps', () => {
  it('inserts appended and after-id cells, preserving order and source', () => {
    const a = newCell('markdown', '# A')
    const nb = nbOf(a)
    const ops: NotebookOp[] = [
      { op: 'insert', cellType: 'code', source: 'x = 1' }, // append
      { op: 'insert', cellType: 'markdown', source: '## after A', afterId: a.id }, // between A and the appended code
    ]
    const { nb: next } = applyNotebookOps(nb, ops)
    expect(next.cells.map((c) => c.source)).toEqual(['# A', '## after A', 'x = 1'])
    expect(next.cells[2].cell_type).toBe('code')
    // pure: original untouched
    expect(nb.cells).toHaveLength(1)
  })

  it('updates a cell by id and removes another', () => {
    const a = newCell('markdown', '# A')
    const b = newCell('code', 'old')
    const { nb: next } = applyNotebookOps(nbOf(a, b), [
      { op: 'update', id: b.id, source: 'new' },
      { op: 'remove', id: a.id },
    ])
    expect(next.cells).toHaveLength(1)
    expect(next.cells[0].source).toBe('new')
  })

  it('reorders a cell to just after another (and to the top when afterId is omitted)', () => {
    const a = newCell('markdown', 'A')
    const b = newCell('markdown', 'B')
    const c = newCell('markdown', 'C')
    const afterB = applyNotebookOps(nbOf(a, b, c), [{ op: 'reorder', id: c.id, afterId: a.id }])
    expect(afterB.nb.cells.map((x) => x.source)).toEqual(['A', 'C', 'B'])
    const toTop = applyNotebookOps(nbOf(a, b, c), [{ op: 'reorder', id: c.id }])
    expect(toTop.nb.cells.map((x) => x.source)).toEqual(['C', 'A', 'B'])
  })

  it('returns a new title from setMeta and a human summary', () => {
    const { title, summary, changed } = applyNotebookOps(nbOf(newCell('markdown', 'A')), [
      { op: 'insert', cellType: 'code', source: 'y' },
      { op: 'setMeta', title: 'Lab 3' },
    ])
    expect(title).toBe('Lab 3')
    expect(changed).toBe(2)
    expect(summary).toContain('added 1 cell'.replace(/^./, (c) => c.toUpperCase()))
  })

  it('reports changed=0 (no false success) for ops that match nothing or lack required fields', () => {
    const a = newCell('markdown', 'A')
    // update a non-existent id, remove a non-existent id, insert missing cellType/source
    const { nb: next, changed } = applyNotebookOps(nbOf(a), [
      { op: 'update', id: 'nope', source: 'x' },
      { op: 'remove', id: 'gone' },
      { op: 'insert' }, // no cellType/source
    ])
    expect(changed).toBe(0)
    expect(next.cells).toHaveLength(1) // untouched
  })
})

describe('serializeNotebookForAthena', () => {
  it('maps cells to id/type/content and truncates long sources', () => {
    const long = 'x'.repeat(2000)
    const state = serializeNotebookForAthena(nbOf(newCell('markdown', '# Hi'), newCell('code', long)), 'My NB')
    expect(state.kind).toBe('notebook')
    expect(state.meta?.title).toBe('My NB')
    expect(state.components?.[0]).toMatchObject({ type: 'markdown', content: '# Hi' })
    expect(state.components?.[1].content.endsWith('…(truncated)')).toBe(true)
    expect(state.components?.[1].content.length).toBeLessThan(long.length)
  })
})
