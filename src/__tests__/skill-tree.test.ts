// Tests for buildSkillTree — the pure flat-rows -> two-level-tree shaper.
// Covers ordering (position then name), main/subtopic grouping, and the
// defensive orphan-drop. No mocking: pure function.

import { describe, it, expect } from 'vitest'
import { buildSkillTree, selectLeafSkills } from '@/lib/skills/tree'
import type { SkillRow } from '@/lib/validations/skill'

let seq = 0
function row(overrides: Partial<SkillRow> = {}): SkillRow {
  seq += 1
  return {
    id: `id-${seq}`,
    section_id: 'sec-1',
    institution_id: 'inst-1',
    parent_id: null,
    name: `Skill ${seq}`,
    info: null,
    source: 'professor',
    placement_pinned: false,
    excluded: false,
    suppressed: false,
    library_skill_id: null,
    position: 0,
    created_at: '2026-06-24T00:00:00Z',
    updated_at: '2026-06-24T00:00:00Z',
    ...overrides,
  }
}

describe('buildSkillTree', () => {
  it('returns an empty array for no rows', () => {
    expect(buildSkillTree([])).toEqual([])
  })

  it('groups subtopics under their parent main skill', () => {
    const main = row({ id: 'm1', name: 'Algebra' })
    const sub1 = row({ id: 's1', parent_id: 'm1', name: 'Linear' })
    const sub2 = row({ id: 's2', parent_id: 'm1', name: 'Quadratic' })

    const tree = buildSkillTree([sub2, main, sub1])

    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('m1')
    expect(tree[0].subtopics.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('orders main skills by position, then name as tiebreaker', () => {
    const a = row({ id: 'a', name: 'Zebra', position: 0 })
    const b = row({ id: 'b', name: 'Apple', position: 0 })
    const c = row({ id: 'c', name: 'Mango', position: 2 })
    const d = row({ id: 'd', name: 'Mango', position: 1 })

    const tree = buildSkillTree([c, a, d, b])

    // position 0 (Apple, Zebra by name), then position 1, then position 2
    expect(tree.map((t) => t.id)).toEqual(['b', 'a', 'd', 'c'])
  })

  it('orders subtopics by position then name within a parent', () => {
    const main = row({ id: 'm1' })
    const s1 = row({ id: 's1', parent_id: 'm1', name: 'Beta', position: 0 })
    const s2 = row({ id: 's2', parent_id: 'm1', name: 'Alpha', position: 0 })
    const s3 = row({ id: 's3', parent_id: 'm1', name: 'Gamma', position: 1 })

    const tree = buildSkillTree([s3, s1, s2, main])

    expect(tree[0].subtopics.map((s) => s.id)).toEqual(['s2', 's1', 's3'])
  })

  it('drops subtopics whose parent is not present (orphans)', () => {
    const main = row({ id: 'm1' })
    const orphan = row({ id: 'orphan', parent_id: 'missing', name: 'Orphan' })

    const tree = buildSkillTree([main, orphan])

    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('m1')
    expect(tree[0].subtopics).toEqual([])
  })

  it('gives each main skill its own subtopics, not a shared list', () => {
    const m1 = row({ id: 'm1', position: 0 })
    const m2 = row({ id: 'm2', position: 1 })
    const s1 = row({ id: 's1', parent_id: 'm1' })
    const s2 = row({ id: 's2', parent_id: 'm2' })

    const tree = buildSkillTree([m1, m2, s1, s2])

    expect(tree[0].subtopics.map((s) => s.id)).toEqual(['s1'])
    expect(tree[1].subtopics.map((s) => s.id)).toEqual(['s2'])
  })
})

describe('selectLeafSkills', () => {
  it('treats a childless top-level skill as its own leaf, and a parent as non-leaf', () => {
    const parent = row({ id: 'p1' })
    const child = row({ id: 'c1', parent_id: 'p1' })
    const solo = row({ id: 's1' }) // top-level, no children → leaf
    const leaves = selectLeafSkills([parent, child, solo])
    expect(leaves.map((t) => t.id).sort()).toEqual(['c1', 's1']) // p1 excluded (has a child)
  })

  it('never returns an excluded skill, and promotes a parent back to a leaf when all its children are excluded', () => {
    const parent = row({ id: 'p1' })
    const excludedChild = row({ id: 'c1', parent_id: 'p1', excluded: true })
    const excludedSolo = row({ id: 's1', excluded: true })
    const leaves = selectLeafSkills([parent, excludedChild, excludedSolo])
    // c1/s1 excluded → dropped; p1 has no *non-excluded* child → it's now a leaf.
    expect(leaves.map((t) => t.id)).toEqual(['p1'])
  })

  it('never returns a suppressed skill, and does not let a suppressed child keep its parent off the leaf set', () => {
    const parent = row({ id: 'p1' })
    const suppressedChild = row({ id: 'c1', parent_id: 'p1', suppressed: true })
    const suppressedSolo = row({ id: 's1', suppressed: true })
    const leaves = selectLeafSkills([parent, suppressedChild, suppressedSolo])
    // Suppressed (AI-suggested, not yet corroborated) skills are untracked: c1/s1
    // drop out, and p1 has no *tracked* child → it becomes its own leaf.
    expect(leaves.map((t) => t.id)).toEqual(['p1'])
  })
})

// The shared attribution rule for unmapped evidence (node-check passes): the
// incremental hook AND the section recompute both resolve topics through this
// one function, so its behaviour is the "boost survives a rebuild" invariant.
