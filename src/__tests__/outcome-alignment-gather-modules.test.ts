/**
 * gatherEvidence must read a module's own title and description (#631).
 *
 * The bug: editing a module's Description did not invalidate the outcome-alignment cache, so
 * a re-run early-aborted with "No changes since the last analysis." The early-abort is the
 * determinism feature working exactly as designed, which is what made the failure quiet and
 * convincing — a professor editing descriptions to improve mapping was told there was
 * nothing new to analyse.
 *
 * The cause was not a hash that forgot a field. This function selected `modules.id` alone,
 * purely to reach the module's items, so a module's title and description were never map
 * inputs at all and nothing about them COULD move the hash.
 *
 * This file tests the GATHER step specifically. The sibling hash cases in
 * outcome-alignment-determinism.test.ts prove that a module candidate's description moves
 * the run hash — but they pass whether or not gather ever emits one, which was verified by
 * deleting the gather change and watching them all stay green. The oracle here is that the
 * candidate exists at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let gatherEvidence: any

const SECTION = 'ff7c3f25-9223-412a-a850-ea919e4a5f84'

/**
 * Fake PostgREST client. `plan` maps a table to the rows it returns; every builder method
 * is self-chaining and the chain resolves to those rows however it is awaited.
 */
function fakeDb(plan: Record<string, unknown>) {
  return {
    from: (table: string) => {
      const rows = plan[table] ?? []
      const settle = () => Promise.resolve({ data: rows, error: null })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') return (f: (v: unknown) => unknown) => settle().then(f)
            if (prop === 'maybeSingle' || prop === 'single') {
              return () =>
                Promise.resolve({ data: Array.isArray(rows) ? (rows[0] ?? null) : rows, error: null })
            }
            return () => chain
          },
        },
      )
      return chain
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(async () => {
  vi.resetModules()
  const mod = await import('@/lib/jobs/pipelines/outcome-alignment/gather')
  gatherEvidence = mod.gatherEvidence
})

describe('gatherEvidence — modules as evidence (#631)', () => {
  it('emits a module candidate carrying its description', async () => {
    const db = fakeDb({
      course_sections: [{ settings: {} }],
      modules: [{ id: 'mod-1', title: 'Week 3', description: 'Dijkstra, BFS and DFS on weighted graphs' }],
      module_items: [],
      assignments: [],
      quizzes: [],
    })

    const { candidates } = await gatherEvidence(db, SECTION)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modules = candidates.filter((c: any) => c.sourceType === 'module')
    expect(modules).toHaveLength(1)
    expect(modules[0].sourceId).toBe('mod-1')
    /* The description has to be IN the signal — that string is what gets hashed and what the
       mapper reads. A candidate that carried only the title would move the hash on a rename
       and still ignore the edit this issue is about. */
    expect(modules[0].signal).toContain('Dijkstra, BFS and DFS on weighted graphs')
    expect(modules[0].signal).toContain('Week 3')
  })

  it('skips a module with neither title nor description', async () => {
    const db = fakeDb({
      course_sections: [{ settings: {} }],
      modules: [{ id: 'mod-1', title: '', description: null }],
      module_items: [],
      assignments: [],
      quizzes: [],
    })

    const { candidates } = await gatherEvidence(db, SECTION)

    /* Pure structure carries no signal to map, and an empty candidate would spend an LLM
       call to conclude nothing. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(candidates.filter((c: any) => c.sourceType === 'module')).toHaveLength(0)
  })

  it('keeps the module distinct from the items inside it', async () => {
    const db = fakeDb({
      course_sections: [{ settings: {} }],
      modules: [{ id: 'mod-1', title: 'Week 3', description: 'Graph algorithms' }],
      module_items: [
        { id: 'item-1', title: 'Lecture 1', content: { summary: 'BFS walkthrough' } },
      ],
      assignments: [],
      quizzes: [],
    })

    const { candidates } = await gatherEvidence(db, SECTION)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kinds = candidates.map((c: any) => c.sourceType)
    /* Both, not one replacing the other: a module description and a lecture summary are
       different evidence and map independently. */
    expect(kinds).toContain('module')
    expect(kinds).toContain('module_item')
  })
})
