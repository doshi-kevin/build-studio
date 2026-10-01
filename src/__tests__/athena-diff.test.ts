import { describe, it, expect } from 'vitest'
import { diffAuthoring, snapshotOf, type StateSnapshot } from '@/lib/ai/assignment-assistant/diff'

const snap = (components: { id: string; type: string; content: string }[], meta = {}): StateSnapshot => ({
  meta,
  components,
})

describe('diffAuthoring', () => {
  it('returns [] when there is no baseline yet (first turn — never claims a change)', () => {
    expect(diffAuthoring(null, snap([{ id: 'a', type: 'markdown', content: 'x' }]))).toEqual([])
  })

  it('returns [] when nothing changed', () => {
    const s = snap([{ id: 'a', type: 'markdown', content: 'x' }], { title: 'T' })
    expect(diffAuthoring(s, snap([{ id: 'a', type: 'markdown', content: 'x' }], { title: 'T' }))).toEqual([])
  })

  it('flags a full clear specially (the Undo / manual-delete-all case)', () => {
    const before = snap([
      { id: 'a', type: 'markdown', content: 'x' },
      { id: 'b', type: 'code', content: 'y' },
    ])
    const changes = diffAuthoring(before, snap([]))
    expect(changes.join(' ')).toMatch(/cleared the canvas/i)
  })

  it('detects added, removed, and edited components', () => {
    const before = snap([
      { id: 'a', type: 'markdown', content: 'x' },
      { id: 'b', type: 'code', content: 'y' },
    ])
    const after = snap([
      { id: 'a', type: 'markdown', content: 'x EDITED' }, // edited
      { id: 'c', type: 'code', content: 'z' }, // added; b removed
    ])
    const changes = diffAuthoring(before, after).join(' | ')
    expect(changes).toMatch(/added 1 component/)
    expect(changes).toMatch(/removed 1 component/)
    expect(changes).toMatch(/edited component.*a/)
  })

  it('detects a pure reorder (same ids, different order)', () => {
    const before = snap([
      { id: 'a', type: 'markdown', content: 'x' },
      { id: 'b', type: 'markdown', content: 'y' },
    ])
    const after = snap([
      { id: 'b', type: 'markdown', content: 'y' },
      { id: 'a', type: 'markdown', content: 'x' },
    ])
    expect(diffAuthoring(before, after)).toContain('reordered components')
  })

  it('detects a meta change (e.g. topic/title)', () => {
    const before = snap([], { topic: 'Trees' })
    const after = snap([], { topic: 'Graphs' })
    expect(diffAuthoring(before, after)).toContain('changed topic')
  })

  it('snapshotOf tolerates an undefined/empty authoring state', () => {
    expect(snapshotOf(undefined)).toEqual({ meta: {}, components: [] })
  })
})
