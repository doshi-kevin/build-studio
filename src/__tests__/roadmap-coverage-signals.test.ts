// Part II → Part I: turning derived coverage into annotation signals
// (Appendix B P18–P21 and S15–S18). Pure — coverage in, signal rows out.
//
// These are the signals the coverage lifecycle exists to feed, so the thing
// worth pinning is that each one fires on the state it describes and stays
// quiet on the states it doesn't.

import { describe, it, expect } from 'vitest'
import { professorCoverageSignals, studentCoverageSignals } from '@/lib/roadmap/roadmap-signals'
import type { CoverageResult, ModuleCoverage, NodeCoverage } from '@/lib/roadmap/coverage'
import type { AutoRoadmapData, RoadmapItemNode, RoadmapWeekNode } from '@/lib/validations/auto-roadmap'
import type { ModuleItemType } from '@/lib/validations/module'

function item(id: string, itemType: ModuleItemType, title = id): RoadmapItemNode {
  return { id, title, description: '', position: 0, status: 'not_started', itemType, href: null, file: null } as RoadmapItemNode
}
function week(id: string, title: string, items: RoadmapItemNode[] = []): RoadmapWeekNode {
  return { id, title, description: '', weekNumber: null, position: 0, status: 'not_started', items } as RoadmapWeekNode
}
function data(weeks: RoadmapWeekNode[], resources: AutoRoadmapData['resources'] = []): AutoRoadmapData {
  return { sectionId: 's', weeks, resources, edges: [] }
}
const mod = (o: Partial<ModuleCoverage> = {}): ModuleCoverage =>
  ({ status: 'complete', pct: 100, excluded: false, skipped: false, ...o })
function cov(o: Partial<CoverageResult> = {}): CoverageResult {
  return { items: new Map(), resources: new Map(), modules: new Map(), studentDone: new Set(), ...o }
}
const deck = (covered: number, total: number): NodeCoverage =>
  ({ status: 'in_progress', coverage: { covered, total } })

describe('professorCoverageSignals', () => {
  it('P18 — names the slide the class stopped at', () => {
    const d = data([week('m1', 'Week 1', [item('d', 'lecture', 'Attention')])])
    const out = professorCoverageSignals(d, cov({ items: new Map([['d', deck(18, 30)]]) }))
    expect(out.deckGap).toEqual([{ title: 'Attention', covered: 18, total: 30 }])
  })

  it('P18 — a finished or unstarted deck has no gap to report', () => {
    const d = data([week('m1', 'Week 1', [item('a', 'lecture'), item('b', 'lecture')])])
    const out = professorCoverageSignals(
      d,
      cov({
        items: new Map<string, NodeCoverage>([
          ['a', { status: 'complete', coverage: { covered: 30, total: 30 } }],
          ['b', { status: 'not_started', coverage: { covered: 0, total: 30 } }],
        ]),
      }),
    )
    expect(out.deckGap).toEqual([])
  })

  it('P19 — flags only the next un-taught week, not every week beyond the class', () => {
    // front matter · a delivered week · the class's position · two weeks ahead
    const d = data([
      week('m0', 'Course Information'),
      week('m1', 'Taught'),
      week('m2', 'Under way'),
      week('m3', 'Next'),
      week('m4', 'Later'),
    ])
    const out = professorCoverageSignals(
      d,
      cov({
        modules: new Map([
          ['m0', mod({ status: 'not_started', pct: 0 })],
          ['m1', mod({ status: 'complete' })],
          ['m2', mod({ status: 'in_progress', pct: 50 })],
          ['m3', mod({ status: 'not_started', pct: 0 })],
          ['m4', mod({ status: 'not_started', pct: 0 })],
        ]),
      }),
    )
    // not the front-matter band behind the class, and not 'Later' as well as 'Next'
    expect(out.neverDelivered).toEqual([{ title: 'Next' }])
  })

  it('P19 — a week with a class on the calendar is planned, so the warning moves on', () => {
    const d = data(
      [week('m1', 'Under way'), week('m2', 'Scheduled'), week('m3', 'Nothing booked')],
      [{ id: 'r1', kind: 'live_session', title: 'Class', status: 'not_started', stateLabel: 'Scheduled', href: '' }],
    )
    d.edges = [{ fromType: 'module', fromId: 'm2', toType: 'live_session', toId: 'r1', edgeType: 'prerequisite' }] as AutoRoadmapData['edges']
    const out = professorCoverageSignals(
      d,
      cov({
        modules: new Map([
          ['m1', mod({ status: 'in_progress', pct: 50 })],
          ['m2', mod({ status: 'not_started', pct: 0 })],
          ['m3', mod({ status: 'not_started', pct: 0 })],
        ]),
      }),
    )
    expect(out.neverDelivered).toEqual([{ title: 'Nothing booked' }])
  })

  /* A room only gets culled once it goes 'live' (`lc_auto_end_stale_rooms`), so a
     class that was booked and never held stays 'scheduled' for ever. Treating that
     as planned would silence the warning on exactly the week it exists for. */
  it('P19 — a class booked and never held does not count as planned', () => {
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const d = data(
      [week('m1', 'Under way'), week('m2', 'Booked, never held')],
      [{ id: 'r1', kind: 'live_session', title: 'Class', status: 'not_started', stateLabel: 'Scheduled', href: '', scheduledAt: past }],
    )
    d.edges = [{ fromType: 'module', fromId: 'm2', toType: 'live_session', toId: 'r1', edgeType: 'prerequisite' }] as AutoRoadmapData['edges']
    const out = professorCoverageSignals(
      d,
      cov({
        modules: new Map([
          ['m1', mod({ status: 'in_progress', pct: 50 })],
          ['m2', mod({ status: 'not_started', pct: 0 })],
        ]),
      }),
    )
    expect(out.neverDelivered).toEqual([{ title: 'Booked, never held' }])
  })

  it('P19 — stays quiet before the class has taught anything', () => {
    const d = data([week('m1', 'Week 1'), week('m2', 'Week 2')])
    const out = professorCoverageSignals(
      d,
      cov({
        modules: new Map([
          ['m1', mod({ status: 'not_started', pct: 0 })],
          ['m2', mod({ status: 'not_started', pct: 0 })],
        ]),
      }),
    )
    expect(out.neverDelivered).toEqual([])
  })

  it('P21 — surfaces the published-but-nobody-started state', () => {
    const d = data([], [{ id: 'q1', kind: 'quiz', title: 'Quiz 1', status: 'not_started', stateLabel: 'Published', href: '' }])
    const out = professorCoverageSignals(
      d,
      cov({ resources: new Map([['q1', { status: 'not_started', openUntouched: true }]]) }),
    )
    expect(out.openUntouched).toEqual([{ title: 'Quiz 1' }])
  })

  it('emits nothing at all without coverage', () => {
    const out = professorCoverageSignals(data([week('m1', 'Week 1')]), null)
    expect(out).toEqual({ deckGap: [], neverDelivered: [], openUntouched: [] })
  })
})

describe('studentCoverageSignals', () => {
  const wk = () =>
    week('m1', 'Week 1', [
      item('lec', 'lecture'),
      item('v', 'video', 'Backprop video'),
      item('r', 'reference', 'word2vec paper'),
    ])

  it('S17 — tells the student which part of the deck was never taught', () => {
    const out = studentCoverageSignals(
      data([week('m1', 'Week 1', [item('d', 'lecture', 'Attention')])]),
      cov({ items: new Map([['d', deck(18, 30)]]) }),
    )
    expect(out.selfStudyRemainder).toEqual([{ title: 'Attention', covered: 18, total: 30 }])
  })

  it('S16 — nudges the first extra they haven’t done', () => {
    const out = studentCoverageSignals(data([wk()]), cov({ studentDone: new Set(['v']) }))
    expect(out.checkAvailable).toEqual({ title: 'word2vec paper' })
  })

  it('S16 — goes quiet once everything is done', () => {
    const out = studentCoverageSignals(data([wk()]), cov({ studentDone: new Set(['v', 'r']) }))
    expect(out.checkAvailable).toBeUndefined()
  })

  it('skips a module the professor is not covering', () => {
    const out = studentCoverageSignals(
      data([wk()]),
      cov({ modules: new Map([['m1', mod({ skipped: true, excluded: true })]]) }),
    )
    expect(out.checkAvailable).toBeUndefined()
  })

  it('S18 — measures the student against what has been TAUGHT, not the whole course', () => {
    // Week 1 fully delivered and fully done; week 2 fully delivered, half done.
    // Against delivery (200) the student has 150 → 75%.
    const out = studentCoverageSignals(
      data([week('m1', 'Week 1'), week('m2', 'Week 2')]),
      cov({
        modules: new Map([
          ['m1', mod({ pct: 100, studentPct: 100 })],
          ['m2', mod({ pct: 100, studentPct: 50 })],
        ]),
      }),
    )
    expect(out.coverageVsDelivery).toEqual({ title: 'Week 2', pct: 75 })
  })

  it('S18 — an undelivered week cannot drag the student down', () => {
    // Nothing taught yet, so there is no "through what's been taught" to state.
    const out = studentCoverageSignals(
      data([week('m1', 'Week 1')]),
      cov({ modules: new Map([['m1', mod({ status: 'not_started', pct: 0, studentPct: 0 })]]) }),
    )
    expect(out.coverageVsDelivery).toBeUndefined()
  })
})
