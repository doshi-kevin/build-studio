// Unit tests for the project grading engine's pure core (lib/projects/grade.ts).
// Locks the weight math: contribution = (earned/possible) × weight, team items
// shared, individual items personal, ungraded items dropped from the denominator
// (never scored 0), levels scored by their points, contribution clamped to
// [0, weight]. Plus fetchAllPages' page-boundary loop (the guard against
// PostgREST's 1000-row cap silently truncating a roster). The Supabase-bound
// fetch helpers are exercised separately in QA.

import { describe, it, expect, vi } from 'vitest'
import {
  itemContribution,
  computeProjectGrades,
  gradePercent,
  itemDetail,
  fetchAllPages,
  partitionItemScores,
  type RubricItem,
  type GradeSources,
} from '@/lib/projects/grade'

function item(overrides: Partial<RubricItem> & Pick<RubricItem, 'id' | 'itemType' | 'weight'>): RubricItem {
  return {
    title: overrides.title ?? overrides.id,
    grain: 'individual',
    scoringMode: 'numeric',
    levels: [],
    assignmentId: null,
    quizId: null,
    manualMax: null,
    phaseId: null,
    phaseName: null,
    phaseStart: null,
    phaseEnd: null,
    ...overrides,
  }
}

function emptySources(): GradeSources {
  return {
    assignmentSubs: new Map(),
    assignmentPoints: new Map(),
    quizAttempts: new Map(),
    attendance: new Map(),
    itemScores: new Map(),
  }
}

describe('itemContribution', () => {
  it('numeric assignment: (earned/possible) × weight', () => {
    const it = item({ id: 'i1', itemType: 'assignment', assignmentId: 'a1', weight: 40 })
    const s = emptySources()
    s.assignmentSubs.set('a1:S1', { status: 'graded', score: 88 })
    s.assignmentPoints.set('a1', 100)
    expect(itemContribution(it, 'S1', 'T1', s)).toBeCloseTo(35.2, 5)
  })

  it('ungraded assignment (no submission or draft) → null, not 0', () => {
    const it = item({ id: 'i1', itemType: 'assignment', assignmentId: 'a1', weight: 40 })
    const s = emptySources()
    s.assignmentPoints.set('a1', 100)
    expect(itemContribution(it, 'S1', 'T1', s)).toBeNull()
    s.assignmentSubs.set('a1:S1', { status: 'draft', score: null })
    expect(itemContribution(it, 'S1', 'T1', s)).toBeNull()
  })

  it('possible = 0 → null (no divide-by-zero)', () => {
    const it = item({ id: 'i1', itemType: 'assignment', assignmentId: 'a1', weight: 40 })
    const s = emptySources()
    s.assignmentSubs.set('a1:S1', { status: 'graded', score: 5 })
    s.assignmentPoints.set('a1', 0)
    expect(itemContribution(it, 'S1', 'T1', s)).toBeNull()
  })

  it('contribution is clamped to [0, weight] (extra credit does not exceed weight)', () => {
    const it = item({ id: 'i1', itemType: 'assignment', assignmentId: 'a1', weight: 40 })
    const s = emptySources()
    s.assignmentSubs.set('a1:S1', { status: 'graded', score: 120 }) // 120/100 × 40 = 48
    s.assignmentPoints.set('a1', 100)
    expect(itemContribution(it, 'S1', 'T1', s)).toBe(40)
  })

  it('quiz score is a 0-100 percentage, not raw points', () => {
    // Regression: score is stored as a percentage (lib/quiz/scoring.ts), so the
    // contribution is score% of the weight — NOT score / total_points × weight,
    // which would let an 85% on a 20-point quiz clamp to full weight.
    const it = item({ id: 'i1', itemType: 'quiz', quizId: 'q1', weight: 10 })
    const s = emptySources()
    s.quizAttempts.set('q1:S1', { score: 80 })
    expect(itemContribution(it, 'S1', 'T1', s)).toBeCloseTo(8, 5) // 80% × 10
    s.quizAttempts.set('q1:S1', { score: 85 })
    expect(itemContribution(it, 'S1', 'T1', s)).toBeCloseTo(8.5, 5) // 85% × 10, no overshoot
  })

  it('attendance with no data → null (excluded), with data → rate × weight', () => {
    const it = item({ id: 'i1', itemType: 'attendance', weight: 10 })
    const s = emptySources()
    expect(itemContribution(it, 'S1', 'T1', s)).toBeNull()
    s.attendance.set('i1:S1', { present: 3, total: 4 })
    expect(itemContribution(it, 'S1', 'T1', s)).toBeCloseTo(7.5, 5) // 3/4 × 10
  })

  it('manual item reads the persisted score against manualMax', () => {
    const it = item({ id: 'i1', itemType: 'manual', weight: 10, manualMax: 10 })
    const s = emptySources()
    s.itemScores.set('i1:stu:S1', { earned: 9, levelId: null })
    expect(itemContribution(it, 'S1', 'T1', s)).toBe(9)
  })

  it('team-grained item resolves one shared score by teamId', () => {
    const it = item({ id: 'i1', itemType: 'manual', weight: 30, manualMax: 30, grain: 'team' })
    const s = emptySources()
    s.itemScores.set('i1:team:T1', { earned: 27, levelId: null })
    expect(itemContribution(it, 'S1', 'T1', s)).toBe(27) // 27/30 × 30
    expect(itemContribution(it, 'S2', 'T1', s)).toBe(27) // shared with the whole team
  })

  it('level-scored item: chosen level points (by id); no pick → null', () => {
    const it = item({
      id: 'i1',
      itemType: 'assignment',
      assignmentId: 'a1',
      weight: 20,
      scoringMode: 'levels',
      levels: [
        { id: 'ex', label: 'Excellent', points: 20 },
        { id: 'ok', label: 'Good', points: 12 },
      ],
    })
    const s = emptySources()
    expect(itemContribution(it, 'S1', 'T1', s)).toBeNull()
    s.itemScores.set('i1:stu:S1', { earned: null, levelId: 'ok' })
    expect(itemContribution(it, 'S1', 'T1', s)).toBe(12)
  })
})

describe('computeProjectGrades', () => {
  const items: RubricItem[] = [
    item({ id: 'hw', itemType: 'assignment', assignmentId: 'a1', weight: 40, title: 'HW' }),
    item({ id: 'un', itemType: 'assignment', assignmentId: 'a2', weight: 20, title: 'Untitled' }),
    item({ id: 'final', itemType: 'manual', weight: 30, manualMax: 30, grain: 'team', title: 'Final deliverable' }),
    item({ id: 'part', itemType: 'manual', weight: 10, manualMax: 10, title: 'Participation' }),
    item({
      id: 'lvl',
      itemType: 'assignment',
      assignmentId: 'a3',
      weight: 20,
      scoringMode: 'levels',
      title: 'Design review',
      levels: [{ id: 'ex', label: 'Excellent', points: 20 }],
    }),
  ]
  const roster = [
    { studentId: 'S1', teamId: 'T1' },
    { studentId: 'S2', teamId: 'T1' },
  ]

  function sources(): GradeSources {
    const s = emptySources()
    s.assignmentPoints.set('a1', 100)
    s.assignmentPoints.set('a2', 100)
    s.assignmentSubs.set('a1:S1', { status: 'graded', score: 88 })
    s.assignmentSubs.set('a1:S2', { status: 'graded', score: 64 })
    s.assignmentSubs.set('a2:S1', { status: 'graded', score: 95 })
    s.assignmentSubs.set('a2:S2', { status: 'graded', score: 72 })
    s.itemScores.set('final:team:T1', { earned: 26, levelId: null })
    s.itemScores.set('part:stu:S1', { earned: 9, levelId: null })
    s.itemScores.set('part:stu:S2', { earned: 7, levelId: null })
    s.itemScores.set('lvl:stu:S1', { earned: null, levelId: 'ex' }) // S1 only
    return s
  }

  it('sums weighted contributions; team item shared across the team', () => {
    const g = computeProjectGrades(items, roster, sources())
    const s1 = g.get('S1')!
    // 35.2 + 19 + 26 + 9 + 20 = 109.2 out of 120 (all 5 graded)
    expect(s1.earned).toBeCloseTo(109.2, 3)
    expect(s1.total).toBe(120)
    expect(s1.gradedCount).toBe(5)
    expect(s1.itemCount).toBe(5)
    expect(gradePercent(s1)).toBeCloseTo(91, 0)
  })

  it('drops ungraded items from the denominator (never a silent zero)', () => {
    const g = computeProjectGrades(items, roster, sources())
    const s2 = g.get('S2')!
    // 25.6 + 14.4 + 26 + 7 = 73; levels item has no pick for S2 → dropped, so total 100 not 120
    expect(s2.earned).toBeCloseTo(73, 3)
    expect(s2.total).toBe(100)
    expect(s2.gradedCount).toBe(4)
    expect(s2.itemCount).toBe(5)
  })

  it('gradePercent is null when nothing is graded', () => {
    const g = computeProjectGrades(items, [{ studentId: 'S9', teamId: 'T9' }], emptySources())
    expect(gradePercent(g.get('S9')!)).toBeNull()
  })
})

describe('itemDetail', () => {
  it('labels the raw source state for the chip', () => {
    const s = emptySources()
    s.assignmentPoints.set('a1', 100)
    const assn = item({ id: 'i1', itemType: 'assignment', assignmentId: 'a1', weight: 40 })
    expect(itemDetail(assn, 'S1', 'T1', s)).toBe('Not submitted')
    s.assignmentSubs.set('a1:S1', { status: 'submitted', score: null })
    expect(itemDetail(assn, 'S1', 'T1', s)).toBe('Submitted')
    s.assignmentSubs.set('a1:S1', { status: 'graded', score: 63 })
    expect(itemDetail(assn, 'S1', 'T1', s)).toBe('Graded 63/100')
  })
})

describe('partitionItemScores', () => {
  // The grade-page query returns every team's rows for the project; the prefill
  // must not let one team's team-grained score bleed into another's input.
  const rows = [
    { phase_item_id: 'team-item', team_id: 'TEAM_A', student_id: null, earned: 80, level_id: null },
    { phase_item_id: 'team-item', team_id: 'TEAM_B', student_id: null, earned: 10, level_id: null },
    { phase_item_id: 'indiv-item', team_id: null, student_id: 'S1', earned: 92, level_id: null },
  ]

  it('prefills only THIS team\'s team-grained score, never another team\'s', () => {
    const { teamScores } = partitionItemScores(rows, 'TEAM_A')
    expect(teamScores['team-item']).toEqual({ earned: 80, levelId: null })
    // The bug this guards: TEAM_B's 10 must never appear on TEAM_A's page.
    const b = partitionItemScores(rows, 'TEAM_B')
    expect(b.teamScores['team-item']).toEqual({ earned: 10, levelId: null })
  })

  it('keys individual scores by item:student and coerces numeric earned', () => {
    const { studentScores } = partitionItemScores(rows, 'TEAM_A')
    expect(studentScores['indiv-item:S1']).toEqual({ earned: 92, levelId: null })
  })

  it('treats a null earned (un-graded) as null, not 0', () => {
    const { teamScores } = partitionItemScores(
      [{ phase_item_id: 'x', team_id: 'TEAM_A', student_id: null, earned: null, level_id: null }],
      'TEAM_A',
    )
    expect(teamScores['x']).toEqual({ earned: null, levelId: null })
  })
})

describe('fetchAllPages', () => {
  // Fake builder whose .range(from, to) slices a fixed dataset, exactly as
  // PostgREST honors the Range header. No Supabase mock needed.
  const pager = (total: number) => {
    const all = Array.from({ length: total }, (_, i) => ({ id: i }))
    return () => ({ range: async (from: number, to: number) => ({ data: all.slice(from, to + 1) }) })
  }

  it('returns a single short page as-is', async () => {
    expect(await fetchAllPages(pager(500))).toHaveLength(500)
  })

  it('exactly 1000 rows: probes a second page rather than assuming done', async () => {
    // The boundary case the cap hides: a full first page MUST NOT be read as
    // "that was everything" — rows 1000+ would silently vanish.
    const spy = vi.fn(pager(1000))
    expect(await fetchAllPages(spy)).toHaveLength(1000)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('1001 rows: returns all rows across pages, in order', async () => {
    const out = await fetchAllPages(pager(1001))
    expect(out).toHaveLength(1001)
    expect(out[1000]).toEqual({ id: 1000 })
  })

  it('empty result stops immediately', async () => {
    expect(await fetchAllPages(pager(0))).toHaveLength(0)
  })
})
