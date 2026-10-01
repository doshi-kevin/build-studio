// The journey node universe: `buildSectionJourneyRefs` + `checkedOffSetFrom`
// feed the professor's per-student node overlay (getStudentJourneys). The
// HEADLINE mastery figures no longer flow through here — both roles read the
// direct skill-score roll-up (buildStudentMastery, see
// roadmap-mastery-overall.test.ts) — but the node universe still decides every
// overlay colour and state count a professor sees, so it stays load-bearing.
//
// journey-state.test.ts already pins the engine (state thresholds, masteryPct
// averaging, check-off override). What was never covered anywhere is the node
// universe feeding it — so that is what this file asserts, plus the key-format
// contract that joins the two.

import { describe, it, expect } from 'vitest'
import { buildSectionJourneyRefs, checkedOffSetFrom } from '@/lib/skills/roadmap-mastery'
import { journeyFromTopicAccuracy } from '@/lib/roadmap/journey-state'
import { buildFullChain, createTableRouter } from './helpers/mock-supabase'

const SECTION = 'sec-1'

type ModuleRow = { id: string; title: string; week_number: number | null; position: number }
type ItemRow = { id: string; module_id: string; item_type: string; content: unknown }

/** An admin client serving `modules` and `module_items` in the given order. */
function adminWith(modules: ModuleRow[], items: ItemRow[]) {
  const moduleChain = buildFullChain({ data: modules, error: null })
  const itemChain = buildFullChain({ data: items, error: null })
  const router = createTableRouter({ modules: moduleChain, module_items: itemChain })
  return { router, moduleChain, itemChain }
}

describe('buildSectionJourneyRefs — the node universe both roles score', () => {
  it('groups items under their module and keys nodes `module_item:<id>`', async () => {
    const { router } = adminWith(
      [
        { id: 'm1', title: 'Tokenization', week_number: 1, position: 0 },
        { id: 'm2', title: 'Attention', week_number: 2, position: 1 },
      ],
      [
        { id: 'i1', module_id: 'm1', item_type: 'file', content: { topics: ['BPE'] } },
        { id: 'i2', module_id: 'm2', item_type: 'link', content: { topics: ['Self-Attention'] } },
        { id: 'i3', module_id: 'm1', item_type: 'file', content: { topics: [] } },
      ],
      )

    const { weeks, nodeRefs } = await buildSectionJourneyRefs(router, SECTION)

    // Node keys carry the `module_item:` prefix the canvas and the engine expect.
    expect(nodeRefs.map((n) => n.key)).toEqual([
      'module_item:i1', 'module_item:i3', 'module_item:i2',
    ])
    // Every node points back at its owning module group.
    expect(nodeRefs.find((n) => n.key === 'module_item:i1')?.groupKey).toBe('module:m1')
    expect(nodeRefs.find((n) => n.key === 'module_item:i2')?.groupKey).toBe('module:m2')

    expect(weeks).toEqual([
      { key: 'module:m1', label: 'Week 1', title: 'Tokenization', nodeKeys: ['module_item:i1', 'module_item:i3'] },
      { key: 'module:m2', label: 'Week 2', title: 'Attention', nodeKeys: ['module_item:i2'] },
    ])
  })

  it('labels a module with no week number "Module" rather than "Week null"', async () => {
    const { router } = adminWith(
      [{ id: 'm1', title: 'Unscheduled', week_number: null, position: 0 }],
      [{ id: 'i1', module_id: 'm1', item_type: 'file', content: {} }],
    )
    const { weeks } = await buildSectionJourneyRefs(router, SECTION)
    expect(weeks[0].label).toBe('Module')
  })

  // A divider is a layout heading, not coursework. If it entered the universe it
  // would score as a permanent `not_started` node — inflating the professor's
  // state counts and the week-struggle denominators with a row nobody can learn.
  it('excludes section_divider items from the scored universe', async () => {
    const { router } = adminWith(
      [{ id: 'm1', title: 'Week One', week_number: 1, position: 0 }],
      [
        { id: 'd1', module_id: 'm1', item_type: 'section_divider', content: { topics: ['Ignored'] } },
        { id: 'i1', module_id: 'm1', item_type: 'file', content: { topics: ['BPE'] } },
      ],
    )

    const { weeks, nodeRefs } = await buildSectionJourneyRefs(router, SECTION)

    expect(nodeRefs.map((n) => n.key)).toEqual(['module_item:i1'])
    expect(weeks[0].nodeKeys).toEqual(['module_item:i1'])

    // And it never reaches the engine's state counts.
    const { summary } = journeyFromTopicAccuracy(nodeRefs, new Map([['bpe', 90]]))
    expect(summary.counts.not_started).toBe(0)
    expect(summary.counts.mastered).toBe(1)
  })

  it('keeps only non-blank string topic labels from free-form JSONB content', async () => {
    const { router } = adminWith(
      [{ id: 'm1', title: 'W', week_number: 1, position: 0 }],
      [
        { id: 'i1', module_id: 'm1', item_type: 'file', content: { topics: ['BPE', '   ', 42, null, { x: 1 }, 'Attention'] } },
        { id: 'i2', module_id: 'm1', item_type: 'file', content: { topics: 'not-an-array' } },
        { id: 'i3', module_id: 'm1', item_type: 'file', content: null },
      ],
    )

    const { nodeRefs } = await buildSectionJourneyRefs(router, SECTION)

    expect(nodeRefs[0].topics).toEqual(['BPE', 'Attention'])
    // A non-array or absent `topics` yields no signal rather than throwing.
    expect(nodeRefs[1].topics).toEqual([])
    expect(nodeRefs[2].topics).toEqual([])
  })

  it('skips the module_items query entirely for a section with no modules', async () => {
    const { router, itemChain } = adminWith([], [])
    const { weeks, nodeRefs } = await buildSectionJourneyRefs(router, SECTION)

    expect(weeks).toEqual([])
    expect(nodeRefs).toEqual([])
    // An unconstrained `.in('module_id', [])` read is both pointless and a
    // whole-table scan risk on the admin (RLS-bypassing) client.
    expect(router.from).not.toHaveBeenCalledWith('module_items')
    expect(itemChain.select).not.toHaveBeenCalled()
  })

  it('scopes the module read to the requested section', async () => {
    const { router, moduleChain } = adminWith(
      [{ id: 'm1', title: 'W', week_number: 1, position: 0 }],
      [],
    )
    await buildSectionJourneyRefs(router, SECTION)
    // Admin client bypasses RLS, so this predicate is the only tenant boundary.
    expect(moduleChain.eq).toHaveBeenCalledWith('section_id', SECTION)
  })
})

describe('checkedOffSetFrom — roadmap_progress JSONB parsing', () => {
  it('collects only the nodes explicitly checked off', () => {
    const set = checkedOffSetFrom({
      nodeProgress: {
        a: { checkedOff: true },
        b: { checkedOff: false },
        c: {},
        d: { checkedOff: true },
      },
    })
    expect([...set].sort()).toEqual(['a', 'd'])
  })

  // The student path reads its OWN row with .maybeSingle(), which returns null
  // when they have never checked anything off — an input the professor's
  // row-iterating loop never produced before the extraction.
  it('returns an empty set for a missing progress row', () => {
    expect(checkedOffSetFrom(undefined).size).toBe(0)
    expect(checkedOffSetFrom(null).size).toBe(0)
  })

  it('returns an empty set for malformed progress rather than throwing', () => {
    expect(checkedOffSetFrom({}).size).toBe(0)
    expect(checkedOffSetFrom({ nodeProgress: null }).size).toBe(0)
    expect(checkedOffSetFrom({ nodeProgress: { a: null } }).size).toBe(0)
    expect(checkedOffSetFrom('garbage').size).toBe(0)
  })
})

// The two helpers only line up because of an unwritten key contract: the builder
// emits `module_item:<uuid>`, setMyNodeCheckedOff stores the BARE uuid as the
// JSONB key, and the engine slices at the first ':' to match them. Change the
// prefix format on either side and check-offs stop applying — silently, since
// an un-matched check-off just leaves the node on its quiz-derived state.
describe('builder keys ↔ check-off ids ↔ engine (the joining contract)', () => {
  const ITEM = '11111111-1111-4111-8111-111111111111'

  it('applies a bare-uuid check-off to the prefixed node key', async () => {
    const { router } = adminWith(
      [{ id: 'm1', title: 'W', week_number: 1, position: 0 }],
      [{ id: ITEM, module_id: 'm1', item_type: 'file', content: { topics: ['BPE'] } }],
    )
    const { nodeRefs } = await buildSectionJourneyRefs(router, SECTION)
    expect(nodeRefs[0].key).toBe(`module_item:${ITEM}`)

    const checkedOff = checkedOffSetFrom({ nodeProgress: { [ITEM]: { checkedOff: true } } })
    // Score of 10 would read `review_next`; the check-off must win.
    const { nodes } = journeyFromTopicAccuracy(nodeRefs, new Map([['bpe', 10]]), checkedOff)
    expect(nodes[`module_item:${ITEM}`].state).toBe('mastered')
  })

  it('padded and mixed-case node labels still join to normalised topic scores', async () => {
    // The builder deliberately does NOT trim labels — normalizeTopicKey does.
    const { router } = adminWith(
      [{ id: 'm1', title: 'W', week_number: 1, position: 0 }],
      [{ id: 'i1', module_id: 'm1', item_type: 'file', content: { topics: ['  Self-Attention  '] } }],
    )
    const { nodeRefs } = await buildSectionJourneyRefs(router, SECTION)
    expect(nodeRefs[0].topics).toEqual(['  Self-Attention  '])

    const { summary } = journeyFromTopicAccuracy(nodeRefs, new Map([['self-attention', 90]]))
    expect(summary.masteryPct).toBe(90)
  })

  // The ENGINE's determinism over the shared universe: same builder + same
  // scores → same summary, whoever calls it. (The headline figures both roles
  // RENDER now come from buildStudentMastery instead — this pins the engine
  // path that still drives the professor's node overlay.)
  it('yields one masteryPct for a student regardless of which role asks', async () => {
    const modules = [{ id: 'm1', title: 'W', week_number: 1, position: 0 }]
    const items: ItemRow[] = [
      { id: 'i1', module_id: 'm1', item_type: 'file', content: { topics: ['BPE'] } },
      { id: 'i2', module_id: 'm1', item_type: 'file', content: { topics: ['Attention'] } },
      // No curated topic match → unmeasured, must NOT drag the average to 0.
      { id: 'i3', module_id: 'm1', item_type: 'file', content: { topics: ['Uncovered'] } },
      { id: 'd1', module_id: 'm1', item_type: 'section_divider', content: {} },
    ]
    const scores = new Map([['bpe', 90], ['attention', 40]])
    const progress = { nodeProgress: { i9: { checkedOff: true } } }

    // Professor path: all rows for the section, this student's set picked out.
    const profRefs = (await buildSectionJourneyRefs(adminWith(modules, items).router, SECTION)).nodeRefs
    const profSummary = journeyFromTopicAccuracy(profRefs, scores, checkedOffSetFrom(progress)).summary

    // Student path: own row only.
    const stuRefs = (await buildSectionJourneyRefs(adminWith(modules, items).router, SECTION)).nodeRefs
    const stuSummary = journeyFromTopicAccuracy(stuRefs, scores, checkedOffSetFrom(progress)).summary

    expect(stuSummary.masteryPct).toBe(profSummary.masteryPct)
    expect(stuSummary.masteryPct).toBe(65) // (90 + 40) / 2 — unmeasured nodes excluded
    expect(stuSummary.overall).toBe(profSummary.overall)
  })
})
