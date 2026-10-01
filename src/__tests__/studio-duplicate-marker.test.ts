/**
 * After Duplicate, the outline showed two byte-identical rows, so deleting "the new one" by
 * outline position was a coin flip — a live repro destroyed the ORIGINAL and left the copy.
 *
 * The marker is DERIVED from content rather than written into the cell's source, because the
 * outline label IS the cell's content: a real "(copy)" suffix would edit the professor's
 * code. The trade-off worth pinning is that it self-clears on the first edit — that is the
 * intended behaviour, not a gap, since editing is what makes the two tellable apart.
 */

import { describe, it, expect } from 'vitest'
import { isCopyOfPrevious } from '@/components/professor/assignments/studio/NotebookInspector'
import type { StudioCell } from '@/lib/assignments/studio/notebook-model'

const cell = (id: string, source: string, cell_type: StudioCell['cell_type'] = 'code'): StudioCell => ({
  id, cell_type, source, outputs: [], metadata: {}, execution_count: null,
})

describe('isCopyOfPrevious', () => {
  it('flags a fresh duplicate — identical source and type, directly below the original', () => {
    const cells = [cell('a', 'import numpy as np'), cell('b', 'import numpy as np')]
    expect(isCopyOfPrevious(cells, 1)).toBe(true)
  })

  it('never flags the first block, which has nothing above it', () => {
    expect(isCopyOfPrevious([cell('a', 'x')], 0)).toBe(false)
  })

  it('clears as soon as either copy is edited — the point at which they are distinguishable', () => {
    const cells = [cell('a', 'import numpy as np'), cell('b', 'import numpy as np # tweak')]
    expect(isCopyOfPrevious(cells, 1)).toBe(false)
  })

  it('does not flag identical-but-empty blocks, or two fresh empty cells would both read as copies', () => {
    expect(isCopyOfPrevious([cell('a', ''), cell('b', '')], 1)).toBe(false)
    expect(isCopyOfPrevious([cell('a', '   '), cell('b', '   ')], 1)).toBe(false)
  })

  it('does not flag same text in a different block type', () => {
    const cells = [cell('a', 'Setup', 'markdown'), cell('b', 'Setup', 'code')]
    expect(isCopyOfPrevious(cells, 1)).toBe(false)
  })

  it('only compares against the IMMEDIATE predecessor, not anywhere earlier', () => {
    // a duplicate that has since been moved away from its original is no longer ambiguous
    const cells = [cell('a', 'same'), cell('b', 'different'), cell('c', 'same')]
    expect(isCopyOfPrevious(cells, 2)).toBe(false)
  })
})
