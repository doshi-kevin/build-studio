// buildConceptRefs — the node modal's "Taught in …" / "Assessed by …" rows.
//
// Worth pinning down because the failure is silent and looks like data: a
// dropped source, or a name that fails to join, renders as "this skill is
// taught nowhere" rather than as an error. The join is on the NORMALISED name,
// which is the whole reason a curated chip finds a node that stored the label
// with different casing or padding.
//
// It also replaced a per-page copy of the "taught in" loop in two clients; a
// regression here breaks both roadmaps at once.

import { describe, it, expect } from 'vitest'
import { buildConceptRefs, taughtInByName } from '@/lib/roadmap/concept-refs'
import type { AutoRoadmapData } from '@/lib/validations/auto-roadmap'

const data = (over: Partial<AutoRoadmapData> = {}): AutoRoadmapData => ({
  weeks: [],
  resources: [],
  edges: [],
  ...over,
} as AutoRoadmapData)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const week = (items: { title: string; topics?: string[] }[]): any => ({
  id: 'M1', title: 'W1', position: 0, status: 'not_started',
  items: items.map((it, i) => ({ id: `I${i}`, itemType: 'lecture', status: 'not_started', ...it })),
})

describe('taughtInByName', () => {
  it('collects every node that lists the skill', () => {
    const out = taughtInByName(data({
      weeks: [week([{ title: 'Lecture 1', topics: ['Attention'] }, { title: 'Lecture 2', topics: ['Attention', 'RNNs'] }])],
    }))
    expect(out['attention']).toEqual(['Lecture 1', 'Lecture 2'])
    expect(out['rnns']).toEqual(['Lecture 2'])
  })

  it('joins on the normalised name, so casing and padding still match', () => {
    const out = taughtInByName(data({ weeks: [week([{ title: 'Lecture 1', topics: ['  Word Vectors '] }])] }))
    expect(out['word vectors']).toEqual(['Lecture 1'])
  })

  it('ignores items with no topics rather than inventing an empty bucket', () => {
    const out = taughtInByName(data({ weeks: [week([{ title: 'Syllabus' }])] }))
    expect(out).toEqual({})
  })
})

describe('buildConceptRefs', () => {
  it('merges both directions, and keeps a skill that only one side knows about', () => {
    const refs = buildConceptRefs(
      data({ weeks: [week([{ title: 'Lecture 1', topics: ['Attention'] }])] }),
      { attention: ['Quiz 3'], 'never taught': ['Midterm'] },
    )
    expect(refs['attention']).toEqual({ taughtIn: ['Lecture 1'], assessedBy: ['Quiz 3'] })
    // A skill assessed but never taught is a real (and interesting) state — the
    // modal should still say what assesses it.
    expect(refs['never taught']).toEqual({ taughtIn: [], assessedBy: ['Midterm'] })
  })

  it('gives a taught-but-never-assessed skill an empty list, not a missing entry', () => {
    const refs = buildConceptRefs(data({ weeks: [week([{ title: 'Lecture 1', topics: ['Attention'] }])] }), {})
    expect(refs['attention']).toEqual({ taughtIn: ['Lecture 1'], assessedBy: [] })
  })

  it('is empty when the course has no topics anywhere', () => {
    expect(buildConceptRefs(data(), {})).toEqual({})
  })
})
