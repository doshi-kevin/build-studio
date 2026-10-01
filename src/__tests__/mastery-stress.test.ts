// Topic Mastery — ground-truth stress harness.
//
// Every synthetic student carries a hidden `trueAbility` per skill. Activities
// sample from it with archetype-specific noise, the real engine folds the
// results, and each property below asks whether the engine recovered a number it
// was never told. Spec: goals/mastery-algorithm-audit/simulation.md.
// Pass conditions: goals/mastery-algorithm-audit/criteria.md (frozen).
//
// Pure and in-memory: no Supabase client, no network, no fixtures on disk.

import { describe, it, expect, afterAll } from 'vitest'
import {
  evidenceWeight,
  foldMasteryEvents,
  classNumber,
  medianScore,
  meanScore,
  type MasteryEvent,
} from '@/lib/skills/scoring'
import { rollUpScore, scoreLabel } from '@/lib/skills/mastery'
import { aggregateSectionMastery, aggregateStudentMastery, type MasteryDatum } from '@/lib/skills/aggregate'
import { DEFAULT_TOPIC_MASTERY_CONFIG as CFG } from '@/lib/skills/config'
import type { SkillRow, ActivityType } from '@/lib/validations/skill'

import {
  rngFor,
  normal,
  clamp,
  shuffled,
  abilityBand,
  observe,
  TERM,
  MIXED,
  type Archetype,
} from '@/__tests__/support/mastery-world'

// ── 3. Cohorts ──────────────────────────────────────────────────

const DAY = 86_400_000
const TERM_START = Date.parse('2026-01-12T09:00:00Z')

let skillSeq = 0
function mkSkill(name: string, parentId: string | null, position: number): SkillRow {
  skillSeq++
  return {
    id: `skill-${skillSeq}`,
    section_id: 'sec-1',
    institution_id: 'inst-1',
    parent_id: parentId,
    name,
    info: null,
    source: 'professor',
    placement_pinned: false,
    excluded: false,
    suppressed: false,
    library_skill_id: null,
    position,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

interface SimEvent extends MasteryEvent {
  /** Kept alongside so the oracle and the archetype filters can read them. */
  arch: Archetype
}

interface Cohort {
  id: string
  seed: number
  skills: SkillRow[]
  leafIds: string[]
  studentIds: string[]
  /** `${studentId}:${leafId}` -> hidden true ability. */
  truth: Map<string, number>
  events: SimEvent[]
}

interface CohortSpec {
  id: string
  students: number
  mains: number
  leavesPerMain: number
  /** Which archetypes each student attempts per leaf. */
  plan: Archetype[]
  /** All students share one ability, for the clone cohort. */
  fixedAbility?: number
  /** Only this many students get any evidence at all. */
  studentsWithEvidence?: number
  /** Only this many leaves per main are ever assessed. */
  leavesAssessed?: number
  /** C8: leaf 0 gets one exam, leaf 1 gets eight node checks. */
  lopsided?: boolean
}

function buildCohort(spec: CohortSpec, seed: number): Cohort {
  const rng = rngFor(spec.id, seed)
  skillSeq = 0

  const skills: SkillRow[] = []
  const leafIds: string[] = []
  for (let m = 0; m < spec.mains; m++) {
    const main = mkSkill(`Main ${m + 1}`, null, m)
    skills.push(main)
    for (let l = 0; l < spec.leavesPerMain; l++) {
      const leaf = mkSkill(`Main ${m + 1} / Leaf ${l + 1}`, main.id, l)
      skills.push(leaf)
      leafIds.push(leaf.id)
    }
  }

  const studentIds = Array.from({ length: spec.students }, (_, i) => `stu-${i + 1}`)
  const truth = new Map<string, number>()
  for (const sid of studentIds) {
    const band = spec.fixedAbility != null ? spec.fixedAbility : abilityBand(rng)
    // Correlation 0.6 across a student's skills: one shared draw plus a per-skill draw.
    const zStudent = normal(rng, 0, 1)
    for (const lid of leafIds) {
      if (spec.fixedAbility != null) {
        truth.set(`${sid}:${lid}`, spec.fixedAbility)
        continue
      }
      const zSkill = normal(rng, 0, 1)
      const a = band + 8 * (Math.sqrt(0.6) * zStudent + Math.sqrt(0.4) * zSkill)
      truth.set(`${sid}:${lid}`, clamp(a, 3, 99))
    }
  }

  const evidenceStudents = new Set(studentIds.slice(0, spec.studentsWithEvidence ?? spec.students))
  const assessedLeaves = new Set(
    spec.leavesAssessed == null
      ? leafIds
      : leafIds.filter((_, i) => i % spec.leavesPerMain < spec.leavesAssessed!),
  )

  const events: SimEvent[] = []
  for (const lid of leafIds) {
    if (!assessedLeaves.has(lid)) continue
    const plan: Archetype[] = spec.lopsided
      ? leafIds.indexOf(lid) % 2 === 0
        ? ['exam']
        : Array<Archetype>(8).fill('node-check')
      : spec.plan
    // One course calendar per leaf: everyone sits activity #k on the same day,
    // which is what produces the timestamp ties production sees.
    const planRng = rngFor(`plan:${spec.id}:${lid}`, seed)
    const ordered = spec.lopsided ? plan : shuffled(plan, planRng)
    ordered.forEach((arch, k) => {
      const at = TERM_START + (k + 1) * 7 * DAY
      for (const sid of studentIds) {
        if (!evidenceStudents.has(sid)) continue
        const ability = truth.get(`${sid}:${lid}`)!
        const o = observe(arch, ability, rng)
        if (o.pct == null) continue
        const weight = o.fixedWeight ?? evidenceWeight(CFG, o.type, o.points)
        events.push({ studentId: sid, skillId: lid, pct: o.pct, at, weight, arch })
      }
    })
  }

  return { id: spec.id, seed, skills, leafIds, studentIds, truth, events }
}

const SPECS: CohortSpec[] = [
  { id: 'C1-mixed', students: 30, mains: 3, leavesPerMain: 4, plan: MIXED },
  { id: 'C2-quiz', students: 30, mains: 1, leavesPerMain: 3, plan: Array<Archetype>(TERM['mcq-quiz']).fill('mcq-quiz') },
  { id: 'C3-stem', students: 30, mains: 1, leavesPerMain: 3, plan: Array<Archetype>(TERM['stem-problem-set']).fill('stem-problem-set') },
  { id: 'C4-code', students: 30, mains: 1, leavesPerMain: 3, plan: Array<Archetype>(TERM['coding-autograder']).fill('coding-autograder') },
  { id: 'C5-ml', students: 30, mains: 1, leavesPerMain: 3, plan: Array<Archetype>(TERM['ml-rubric']).fill('ml-rubric') },
  { id: 'C6-clone', students: 25, mains: 1, leavesPerMain: 1, plan: Array<Archetype>(TERM['coding-autograder']).fill('coding-autograder'), fixedAbility: 70 },
  { id: 'C7-sparse', students: 30, mains: 2, leavesPerMain: 5, plan: MIXED, studentsWithEvidence: 6, leavesAssessed: 2 },
  { id: 'C8-lopsided', students: 30, mains: 1, leavesPerMain: 2, plan: MIXED, lopsided: true },
  { id: 'C9-empty', students: 30, mains: 2, leavesPerMain: 4, plan: [] },
]

const SEEDS = [1, 2, 3, 4, 5]
const cohortCache = new Map<string, Cohort>()
function cohort(id: string, seed: number): Cohort {
  const key = `${id}:${seed}`
  let c = cohortCache.get(key)
  if (!c) {
    const spec = SPECS.find((s) => s.id === id)
    if (!spec) throw new Error(`unknown cohort ${id}`)
    cohortCache.set(key, (c = buildCohort(spec, seed)))
  }
  return c
}
const allSeeds = (id: string): Cohort[] => SEEDS.map((s) => cohort(id, s))

// ── 4. Driving the engine, and the oracle control ───────────────

type State = ReturnType<typeof foldMasteryEvents>

const engine = (c: Cohort, events: SimEvent[] = c.events): State => foldMasteryEvents(events, CFG, 50)

/** simulation.md §7 — plain unweighted mean of the observations. If this cannot
 *  clear the bar, the world is too noisy and the spec is at fault, not the engine. */
function oracle(events: SimEvent[]): Map<string, number> {
  const acc = new Map<string, { sum: number; n: number }>()
  for (const e of events) {
    const k = `${e.studentId}:${e.skillId}`
    const a = acc.get(k) ?? { sum: 0, n: 0 }
    acc.set(k, { sum: a.sum + e.pct, n: a.n + 1 })
  }
  return new Map([...acc].map(([k, v]) => [k, v.sum / v.n]))
}

const toData = (st: State): MasteryDatum[] =>
  [...st.entries()].map(([k, v]) => {
    const [student_id, skill_id] = k.split(':')
    return { student_id, skill_id, score: v.score, n: v.n, w: v.w }
  })

function maeAgainstTruth(measured: Map<string, number>, truth: Map<string, number>): number {
  let sum = 0
  let n = 0
  for (const [k, v] of measured) {
    const t = truth.get(k)
    if (t == null) continue
    sum += Math.abs(v - t)
    n++
  }
  return n ? sum / n : 0
}
const scoresOf = (st: State): Map<string, number> => new Map([...st].map(([k, v]) => [k, v.score]))

const sd = (xs: number[]): number => {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

// ── 5. Result table ─────────────────────────────────────────────

interface Row { id: string; pass: boolean; measured: string; threshold: string; ctx: string }
const RESULTS: Row[] = []

function record(id: string, pass: boolean, measured: string, threshold: string, ctx: string): boolean {
  RESULTS.push({ id, pass, measured, threshold, ctx })
  return pass
}

afterAll(() => {
  const byId = new Map<string, Row>()
  for (const r of RESULTS) {
    const prev = byId.get(r.id)
    // Report the worst outcome per property, never the kindest.
    if (!prev || (prev.pass && !r.pass)) byId.set(r.id, r)
  }
  const lines = [...byId.keys()].sort().map((id) => {
    const r = byId.get(id)!
    return `${id} ${r.pass ? 'PASS' : 'FAIL'}  measured=${r.measured}  threshold${r.threshold}  ${r.ctx}`
  })
  const failed = [...byId.values()].filter((r) => !r.pass).length
  // stderr, not console.log: vitest's default reporter hides stdout from files
  // that pass, and the whole point of this table is to be readable when green.
  process.stderr.write(
    ['', '════ TOPIC MASTERY PROPERTY TABLE ════', ...lines,
     `──── ${byId.size - failed}/${byId.size} in-harness properties PASS (P17 is verified by \`npm run test\`) ────`, ''].join('\n') + '\n',
  )
})

// ── 6. Properties ───────────────────────────────────────────────

/** criteria.md P0 as amended 2026-09-01: the accuracy cohorts only. C8-lopsided
 *  is excluded by construction — it exists to test roll-up weighting, and its
 *  node-check leaf carries no ability signal for any estimator to recover. */
const ACCURACY_COHORTS = ['C1-mixed', 'C2-quiz', 'C3-stem', 'C4-code', 'C5-ml']

describe('P0 — oracle control (is the world fair?)', () => {
  it('a plain mean recovers true ability within 9.0 on every cohort accuracy is asserted on', () => {
    let worst = 0
    let worstCtx = ''
    const per: string[] = []
    for (const id of ACCURACY_COHORTS) {
      let cohortWorst = 0
      for (const c of allSeeds(id)) cohortWorst = Math.max(cohortWorst, maeAgainstTruth(oracle(c.events), c.truth))
      per.push(`${id}=${cohortWorst.toFixed(2)}`)
      if (cohortWorst > worst) { worst = cohortWorst; worstCtx = `worst=${id}` }
    }
    const pass = record('P00', worst <= 9.0, worst.toFixed(2), '<=9.00', `${worstCtx} | ${per.join(' ')}`)
    expect(pass, `oracle MAE ${worst.toFixed(2)} > 9.0 at ${worstCtx}: the SPEC is too noisy, not the engine`).toBe(true)
  })
})

describe('P1 — cohort accuracy', () => {
  it('engine MAE against true ability is at most 10.0 on C1-mixed, worst seed', () => {
    let worst = 0
    let ctx = ''
    let oracleAt = 0
    for (const c of allSeeds('C1-mixed')) {
      const m = maeAgainstTruth(scoresOf(engine(c)), c.truth)
      if (m > worst) { worst = m; ctx = `cohort=${c.id} seed=${c.seed}`; oracleAt = maeAgainstTruth(oracle(c.events), c.truth) }
    }
    const pass = record('P01', worst <= 10.0, worst.toFixed(2), '<=10.00', `${ctx} oracleMAE=${oracleAt.toFixed(2)}`)
    expect(pass, `engine MAE ${worst.toFixed(2)} > 10.0 at ${ctx}`).toBe(true)
  })
})

describe('P2 — no individual is badly misread', () => {
  it('no (student, leaf) score is more than 25.0 points from that student true ability', () => {
    let worst = 0
    let ctx = ''
    for (const c of allSeeds('C1-mixed')) {
      for (const [k, v] of scoresOf(engine(c))) {
        const t = c.truth.get(k)
        if (t == null) continue
        const err = Math.abs(v - t)
        if (err > worst) { worst = err; ctx = `cohort=${c.id} seed=${c.seed} key=${k} true=${t.toFixed(1)} read=${v.toFixed(1)}` }
      }
    }
    const pass = record('P02', worst <= 25.0, worst.toFixed(2), '<=25.00', ctx)
    expect(pass, `worst individual error ${worst.toFixed(2)} > 25.0 at ${ctx}`).toBe(true)
  })
})

describe('P3 — extremes are earned', () => {
  it('95% of readings at or below 10 are truly weak, and at or above 90 are truly strong', () => {
    let lowTotal = 0, lowOk = 0, highTotal = 0, highOk = 0
    for (const spec of SPECS) {
      if (spec.id === 'C9-empty') continue
      for (const c of allSeeds(spec.id)) {
        for (const [k, v] of scoresOf(engine(c))) {
          const t = c.truth.get(k)
          if (t == null) continue
          if (v <= 10) { lowTotal++; if (t <= 35) lowOk++ }
          if (v >= 90) { highTotal++; if (t >= 70) highOk++ }
        }
      }
    }
    const lowPct = lowTotal ? (lowOk / lowTotal) * 100 : 100
    const highPct = highTotal ? (highOk / highTotal) * 100 : 100
    // criteria.md P3: a half with fewer than 20 extreme readings is reported as
    // not informative rather than judged on a handful of points.
    const lowOkay = lowTotal < 20 || lowPct >= 95
    const highOkay = highTotal < 20 || highPct >= 95
    const informative = lowTotal >= 20 || highTotal >= 20
    void informative
    const pass = record(
      'P03',
      lowOkay && highOkay,
      `low=${lowPct.toFixed(1)}% high=${highPct.toFixed(1)}%`,
      '>=95.0%',
      `n_low=${lowTotal} n_high=${highTotal}${informative ? '' : ' (n<20, not informative)'}`,
    )
    expect(pass, `extreme readings unearned: <=10 correct ${lowPct.toFixed(1)}% (n=${lowTotal}), >=90 correct ${highPct.toFixed(1)}% (n=${highTotal})`).toBe(true)
  })
})

describe('P4 — the professor median is honest', () => {
  it('class median is within 10.0 of the median true ability, per leaf and per main skill', () => {
    let worst = 0
    let ctx = ''
    for (const c of allSeeds('C1-mixed')) {
      const st = engine(c)
      const rows = toData(st)
      // Leaf skills.
      for (const lid of c.leafIds) {
        const assessed = c.studentIds.filter((s) => st.has(`${s}:${lid}`))
        if (assessed.length < 5) continue
        const got = classNumber(assessed.map((s) => st.get(`${s}:${lid}`)!.score), CFG)!
        const want = medianScore(assessed.map((s) => c.truth.get(`${s}:${lid}`)!))!
        const err = Math.abs(got - want)
        if (err > worst) { worst = err; ctx = `cohort=${c.id} seed=${c.seed} leaf=${lid} median_read=${got.toFixed(1)} median_true=${want.toFixed(1)}` }
      }
      // Main skills, through the real aggregate.
      const view = aggregateSectionMastery(c.skills, rows, CFG)
      for (const main of view.ordered) {
        const subs = c.skills.filter((s) => s.parent_id === main.skillId).map((s) => s.id)
        const assessed = c.studentIds.filter((s) => subs.some((l) => st.has(`${s}:${l}`)))
        if (assessed.length < 5 || main.classScore == null) continue
        const want = medianScore(assessed.map((s) => meanScore(subs.map((l) => c.truth.get(`${s}:${l}`) ?? null))))!
        const err = Math.abs(main.classScore - want)
        if (err > worst) { worst = err; ctx = `cohort=${c.id} seed=${c.seed} main=${main.name} median_read=${main.classScore.toFixed(1)} median_true=${want.toFixed(1)}` }
      }
    }
    const pass = record('P04', worst <= 10.0, worst.toFixed(2), '<=10.00', ctx)
    expect(pass, `class median off by ${worst.toFixed(2)} at ${ctx}`).toBe(true)
  })
})

describe('P5 — a thin skill is labelled, not hidden', () => {
  it('C7-sparse: a class number from few students carries coverage < 1', () => {
    let bad = ''
    for (const c of allSeeds('C7-sparse')) {
      const st = engine(c)
      const view = aggregateSectionMastery(c.skills, toData(st), CFG)
      for (const main of view.ordered) {
        if (main.classScore == null) continue
        const subs = c.skills.filter((s) => s.parent_id === main.skillId).map((s) => s.id)
        const assessed = c.studentIds.filter((s) => subs.some((l) => st.has(`${s}:${l}`))).length
        if (assessed < 5 && main.coverage >= 1) {
          bad = `cohort=${c.id} seed=${c.seed} main=${main.name} assessed=${assessed} coverage=${main.coverage}`
        }
      }
    }
    const pass = record('P05', bad === '', bad === '' ? 'coverage<1 everywhere' : bad, '=coverage<1', 'C7-sparse')
    expect(pass, `a 2-student class number is indistinguishable from a 30-student one: ${bad}`).toBe(true)
  })
})

describe('P6 — single-event cap', () => {
  it('with prior evidence, one event moves a score by at most 20.0 points', () => {
    const types: ActivityType[] = ['exam', 'assignment', 'quiz', 'challenge']
    const pointsGrid = [1, 2, 5, 20, 50, 100]
    let worst = 0
    let ctx = ''
    for (let prior = 0; prior <= 100; prior += 5) {
      for (let ev = 0; ev <= 100; ev += 5) {
        for (const type of types) {
          for (const points of pointsGrid) {
            const w = evidenceWeight(CFG, type, points)
            // Two prior events of the same shape, then the event under test.
            const warm = foldMasteryEvents(
              [
                { studentId: 's', skillId: 'k', pct: prior, at: 1, weight: w },
                { studentId: 's', skillId: 'k', pct: prior, at: 2, weight: w },
              ],
              CFG,
              prior,
            ).get('s:k')!
            const after = foldMasteryEvents(
              [
                { studentId: 's', skillId: 'k', pct: prior, at: 1, weight: w },
                { studentId: 's', skillId: 'k', pct: prior, at: 2, weight: w },
                { studentId: 's', skillId: 'k', pct: ev, at: 3, weight: w },
              ],
              CFG,
              prior,
            ).get('s:k')!
            const delta = Math.abs(after.score - warm.score)
            if (delta > worst) { worst = delta; ctx = `prior=${warm.score.toFixed(1)} evidence=${ev} type=${type} points=${points}` }
          }
        }
      }
    }
    const pass = record('P06', worst <= 20.0, worst.toFixed(2), '<=20.00', ctx)
    expect(pass, `one event moved the score ${worst.toFixed(2)} points at ${ctx}`).toBe(true)
  })
})

describe('P7 — cold start is not a verdict', () => {
  it('after exactly one event the score lies between the seed and the evidence, inside [10, 90]', () => {
    const types: ActivityType[] = ['exam', 'assignment', 'quiz', 'challenge']
    let bad = ''
    let extreme = 50
    for (let ev = 0; ev <= 100; ev += 5) {
      for (const type of types) {
        for (const points of [1, 2, 5, 20, 50, 100]) {
          const w = evidenceWeight(CFG, type, points)
          const s = foldMasteryEvents([{ studentId: 's', skillId: 'k', pct: ev, at: 1, weight: w }], CFG, 50).get('s:k')!.score
          if (Math.abs(s - 50) > Math.abs(extreme - 50)) extreme = s
          const between = ev === 50 ? s === 50 : (s > Math.min(50, ev) && s < Math.max(50, ev)) || s === ev
          if (s < 10 || s > 90 || !between) bad = `evidence=${ev} type=${type} points=${points} -> ${s.toFixed(1)}`
        }
      }
    }
    const pass = record('P07', bad === '', `mostExtreme=${extreme.toFixed(1)}`, '=inside[10,90]', bad || 'all one-event outcomes inside band')
    expect(pass, `one event produced a confident extreme: ${bad}`).toBe(true)
  })
})

describe('P8 — recoverability', () => {
  it('a strong student who scores one 0 returns to 80 within 4 events at their true ability', () => {
    const w = evidenceWeight(CFG, 'assignment', 50)
    let bad = ''
    let worstBack = 100
    for (const trueAbility of [85, 90, 95, 100]) {
      // Build a student sitting at >= 85 on honest evidence.
      const evs: MasteryEvent[] = []
      let t = 1
      for (let i = 0; i < 10; i++) evs.push({ studentId: 's', skillId: 'k', pct: trueAbility, at: t++, weight: w })
      const before = foldMasteryEvents(evs, CFG, 50).get('s:k')!.score
      if (before < 85) continue
      evs.push({ studentId: 's', skillId: 'k', pct: 0, at: t++, weight: w })
      let back = -1
      for (let k = 1; k <= 4; k++) {
        evs.push({ studentId: 's', skillId: 'k', pct: trueAbility, at: t++, weight: w })
        const s = foldMasteryEvents(evs, CFG, 50).get('s:k')!.score
        if (s >= 80 && back < 0) back = k
      }
      const finalScore = foldMasteryEvents(evs, CFG, 50).get('s:k')!.score
      if (finalScore < worstBack) worstBack = finalScore
      if (back < 0) bad = `trueAbility=${trueAbility} started=${before.toFixed(1)} after4=${finalScore.toFixed(1)}`
    }
    const pass = record('P08', bad === '', `after4events=${worstBack.toFixed(1)}`, '>=80 within 4', bad || 'recovered')
    expect(pass, `did not recover: ${bad}`).toBe(true)
  })
})

describe('P9 — replay determinism', () => {
  it('identical evidence yields bit-identical scores, including on tied and zero timestamps', () => {
    let bad = ''
    let worst = 0
    for (const c of allSeeds('C1-mixed')) {
      const rng = rngFor('p9', c.seed)
      // Production reality: bulk grading collapses timestamps, and a null date
      // reaches the fold as at = 0.
      const collapsed: SimEvent[] = c.events.map((e, i) => ({ ...e, at: i % 3 === 0 ? 0 : TERM_START }))
      const a = engine(c, collapsed)
      const b = engine(c, shuffled(collapsed, rng))
      for (const [k, v] of a) {
        const other = b.get(k)
        const d = other ? Math.abs(other.score - v.score) : Infinity
        if (d > worst) { worst = d; bad = `cohort=${c.id} seed=${c.seed} key=${k} runA=${v.score.toFixed(4)} runB=${other?.score.toFixed(4)}` }
      }
    }
    const pass = record('P09', worst === 0, worst.toFixed(4), '=0 (exact)', bad || 'identical across replays')
    expect(pass, `two recomputes of unchanged data disagreed by ${worst.toFixed(4)}: ${bad}`).toBe(true)
  })
})

describe('P10 — order robustness', () => {
  it('replaying the same evidence in a shuffled grading order moves any score at most 2.0', () => {
    let worst = 0
    let ctx = ''
    for (const c of allSeeds('C1-mixed')) {
      const base = engine(c)
      const byKey = new Map<string, SimEvent[]>()
      for (const e of c.events) {
        const k = `${e.studentId}:${e.skillId}`
        byKey.set(k, [...(byKey.get(k) ?? []), e])
      }
      for (let p = 0; p < 20; p++) {
        const rng = rngFor(`p10:${p}`, c.seed)
        // Same events, different grading order: permute the timestamps within
        // each (student, skill) so the chronology changes but the evidence does not.
        const permuted: SimEvent[] = []
        for (const evs of byKey.values()) {
          const times = shuffled(evs.map((e) => e.at), rng)
          evs.forEach((e, i) => permuted.push({ ...e, at: times[i] }))
        }
        const alt = engine(c, permuted)
        for (const [k, v] of base) {
          const d = Math.abs((alt.get(k)?.score ?? NaN) - v.score)
          if (d > worst) { worst = d; ctx = `cohort=${c.id} seed=${c.seed} perm=${p} key=${k}` }
        }
      }
    }
    const pass = record('P10', worst <= 2.0, worst.toFixed(2), '<=2.00', ctx)
    expect(pass, `grading order changed a score by ${worst.toFixed(2)} at ${ctx}`).toBe(true)
  })
})

describe('P11 — roll-up is not distorted by event count', () => {
  it('C8-lopsided: one exam vs eight node checks rolls up within 10.0 MAE of the truth', () => {
    let worst = 0
    let ctx = ''
    for (const c of allSeeds('C8-lopsided')) {
      const st = engine(c)
      let sum = 0
      let n = 0
      for (const sid of c.studentIds) {
        const rows = toData(st).filter((r) => r.student_id === sid)
        for (const main of aggregateStudentMastery(c.skills, rows)) {
          if (main.classScore == null) continue
          const want = meanScore(c.leafIds.map((l) => c.truth.get(`${sid}:${l}`) ?? null))!
          sum += Math.abs(main.classScore - want)
          n++
        }
      }
      const mae = n ? sum / n : 0
      if (mae > worst) { worst = mae; ctx = `cohort=${c.id} seed=${c.seed} n=${n}` }
    }
    // Diagnostic: the same roll-up fed by the oracle, to separate "the engine
    // weights badly" from "one exam does not carry 10-point accuracy".
    let oracleWorst = 0
    for (const c of allSeeds('C8-lopsided')) {
      const om = oracle(c.events)
      const st = engine(c)
      let sum = 0
      let n = 0
      for (const sid of c.studentIds) {
        const kids = c.leafIds
          .filter((l) => om.has(`${sid}:${l}`))
          .map((l) => ({ score: om.get(`${sid}:${l}`)!, n: st.get(`${sid}:${l}`)!.n, w: st.get(`${sid}:${l}`)!.w }))
        const got = rollUpScore(kids)
        if (got == null) continue
        sum += Math.abs(got - meanScore(c.leafIds.map((l) => c.truth.get(`${sid}:${l}`) ?? null))!)
        n++
      }
      oracleWorst = Math.max(oracleWorst, n ? sum / n : 0)
    }
    const pass = record('P11', worst <= 10.0, worst.toFixed(2), '<=10.00', `${ctx} oracleMAE=${oracleWorst.toFixed(2)}`)
    expect(pass, `roll-up MAE ${worst.toFixed(2)} at ${ctx} (oracle ${oracleWorst.toFixed(2)})`).toBe(true)
  })
})

describe('P12 — no evidence never reads as zero', () => {
  it('unassessed skills return null and render as an em dash, never 0% or NaN%', () => {
    const offenders: string[] = []
    const check = (label: string, score: number | null) => {
      if (score === null) {
        if (scoreLabel(score) !== '—') offenders.push(`${label}: label=${scoreLabel(score)}`)
        return
      }
      if (Number.isNaN(score) || !Number.isFinite(score) || Object.is(score, -0)) {
        offenders.push(`${label}: score=${score}`)
      } else {
        offenders.push(`${label}: expected null for unassessed, got ${score}`)
      }
    }
    for (const id of ['C9-empty', 'C7-sparse']) {
      for (const c of allSeeds(id)) {
        const st = engine(c)
        const rows = toData(st)
        const view = aggregateSectionMastery(c.skills, rows, CFG)
        for (const main of view.ordered) {
          const subs = c.skills.filter((s) => s.parent_id === main.skillId)
          for (const sub of subs) {
            const anyData = c.studentIds.some((s) => st.has(`${s}:${sub.id}`))
            const agg = main.subtopics.find((t) => t.skillId === sub.id)!
            if (!anyData) check(`${c.id}/${c.seed}/${sub.name}`, agg.classScore)
          }
          const mainHasData = c.skills.filter((s) => s.parent_id === main.skillId).some((s) => c.studentIds.some((x) => st.has(`${x}:${s.id}`)))
          if (!mainHasData) check(`${c.id}/${c.seed}/${main.name}`, main.classScore)
        }
        // The student-facing view too.
        for (const sid of c.studentIds) {
          const mine = aggregateStudentMastery(c.skills, rows.filter((r) => r.student_id === sid))
          for (const m of mine) {
            const subs = c.skills.filter((s) => s.parent_id === m.skillId)
            if (!subs.some((s) => st.has(`${sid}:${s.id}`))) check(`${c.id}/${c.seed}/${sid}/${m.name}`, m.classScore)
          }
        }
      }
    }
    const pass = record('P12', offenders.length === 0, `${offenders.length} offenders`, '=0', offenders.slice(0, 3).join(' | ') || 'all unassessed read —')
    expect(pass, `unassessed skills did not read as "—": ${offenders.slice(0, 5).join(' | ')}`).toBe(true)
  })
})

describe('P13 — the median is the median', () => {
  it('classNumber matches the true median/mean/proficiency of the non-null entries exactly', () => {
    const cases: Array<Array<number | null>> = [
      [10, 20, 30],
      [10, 20, 30, 40],
      [50, 50, 50, 50],
      [42],
      [null, 10, null, 30, null],
      [null, null],
      [0, 100],
      [70, 70, 71, 69],
      [null, 80, 80, null, 20],
      [3, 1, 2],
    ]
    const trueMedian = (v: number[]) => {
      const s = [...v].sort((a, b) => a - b)
      if (!s.length) return null
      const mid = Math.floor(s.length / 2)
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
    }
    const offenders: string[] = []
    for (const c of cases) {
      const vals = c.filter((x): x is number => x != null)
      const med = classNumber(c, { ...CFG, classMetric: 'median' })
      const mean = classNumber(c, { ...CFG, classMetric: 'mean' })
      const prof = classNumber(c, { ...CFG, classMetric: 'percent_proficient' })
      const wantMed = trueMedian(vals)
      const wantMean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
      const wantProf = vals.length ? (vals.filter((x) => x >= CFG.proficientThreshold).length / vals.length) * 100 : null
      if (med !== wantMed) offenders.push(`median[${c}] got ${med} want ${wantMed}`)
      if (mean !== wantMean) offenders.push(`mean[${c}] got ${mean} want ${wantMean}`)
      if (prof !== wantProf) offenders.push(`proficient[${c}] got ${prof} want ${wantProf}`)
      if (vals.length === 0 && med !== null) offenders.push(`all-null coerced to ${med}`)
    }
    const pass = record('P13', offenders.length === 0, `${offenders.length} mismatches`, '=0 (exact)', offenders.slice(0, 2).join(' | ') || '10 vectors exact')
    expect(pass, offenders.join(' | ')).toBe(true)
  })
})

describe('P14 — every archetype independently accurate', () => {
  it('MAE stays at or below 10.0 for quiz, stem, coding and rubric cohorts measured separately', () => {
    const table: string[] = []
    let worst = 0
    let ctx = ''
    for (const id of ['C2-quiz', 'C3-stem', 'C4-code', 'C5-ml']) {
      let cohortWorst = 0
      let oracleWorst = 0
      for (const c of allSeeds(id)) {
        const m = maeAgainstTruth(scoresOf(engine(c)), c.truth)
        const o = maeAgainstTruth(oracle(c.events), c.truth)
        if (m > cohortWorst) cohortWorst = m
        if (o > oracleWorst) oracleWorst = o
      }
      table.push(`${id}=${cohortWorst.toFixed(2)}(oracle ${oracleWorst.toFixed(2)})`)
      if (cohortWorst > worst) { worst = cohortWorst; ctx = `worst=${id}` }
    }
    process.stderr.write(`    per-archetype MAE: ${table.join('  ')}\n`)
    const pass = record('P14', worst <= 10.0, worst.toFixed(2), '<=10.00', `${ctx} | ${table.join(' ')}`)
    expect(pass, `per-archetype MAE ${worst.toFixed(2)} > 10.0 (${table.join(' ')})`).toBe(true)
  })
})

describe('P15 — identical students read alike', () => {
  it('C6-clone: the engine adds at most 1.0 sd of spread over a plain mean', () => {
    let worst = 0
    let ctx = ''
    for (const c of allSeeds('C6-clone')) {
      const s = sd([...scoresOf(engine(c)).values()])
      if (s > worst) { worst = s; ctx = `cohort=${c.id} seed=${c.seed}` }
    }
    // Compare seed by seed: the engine may not ADD spread beyond what the
    // evidence itself forces on any single cohort.
    let worstExcess = -Infinity
    let excessCtx = ''
    for (const c of allSeeds('C6-clone')) {
      const eng = sd([...scoresOf(engine(c)).values()])
      const orc = sd([...oracle(c.events).values()])
      if (eng - orc > worstExcess) { worstExcess = eng - orc; excessCtx = `cohort=${c.id} seed=${c.seed} engineSd=${eng.toFixed(2)} oracleSd=${orc.toFixed(2)}` }
    }
    const pass = record('P15', worstExcess <= 1.0, worstExcess.toFixed(2), '<=1.00 over oracle', `${excessCtx} | worstEngineSd=${worst.toFixed(2)}`)
    expect(pass, `engine added ${worstExcess.toFixed(2)} sd over the oracle at ${excessCtx}`).toBe(true)
    void ctx
  })
})

describe('P16 — positive-only evidence does not inflate', () => {
  it('dropping node checks and challenges shifts MAE at most 3.0 and the mean at most 5.0', () => {
    let worstMae = 0
    let worstMean = 0
    let ctx = ''
    for (const c of allSeeds('C1-mixed')) {
      const withAll = engine(c)
      const without = engine(c, c.events.filter((e) => e.arch !== 'node-check' && e.arch !== 'challenge'))
      const maeA = maeAgainstTruth(scoresOf(withAll), c.truth)
      const maeB = maeAgainstTruth(scoresOf(without), c.truth)
      const meanA = meanScore([...scoresOf(withAll).values()])!
      const meanB = meanScore([...scoresOf(without).values()])!
      const dMae = Math.abs(maeA - maeB)
      const dMean = meanA - meanB
      if (dMae > worstMae) worstMae = dMae
      if (dMean > worstMean) { worstMean = dMean; ctx = `cohort=${c.id} seed=${c.seed} mean_with=${meanA.toFixed(1)} mean_without=${meanB.toFixed(1)} mae_with=${maeA.toFixed(2)} mae_without=${maeB.toFixed(2)}` }
    }
    const pass = record('P16', worstMae <= 3.0 && worstMean <= 5.0, `dMAE=${worstMae.toFixed(2)} dMean=${worstMean.toFixed(2)}`, '<=3.00 / <=5.00', ctx)
    expect(pass, `positive-only evidence inflated: dMAE=${worstMae.toFixed(2)} dMean=${worstMean.toFixed(2)} at ${ctx}`).toBe(true)
  })
})

describe('P18 — this feature\'s tests were not removed or muted to get here', () => {
  it('counts real test declarations in the mastery/skill suites, and rejects skip/only', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    /* Scoped and precise, deliberately.
       The first version counted every line CONTAINING "it(" across all of
       src/__tests__, which also matched crit( emit( commit( .limit( and .split(
       — 127 false positives against a margin of 46. So it could pass while real
       tests were deleted, and fail because someone refactored a helper in an
       unrelated feature. Worse, it made a whole-repo assertion from inside a
       Topic Mastery test, so anyone else's branch that legitimately removes tests
       (or leaves one temporary focused-test marker anywhere) failed with a
       message about mastery scoring.
       Now: real declarations only, and only the suites that cover THIS work. */
    const DIR = 'src__tests__'.replace('__tests__', '/__tests__')
    const OWN = /^(skill-|mastery-|roadmap-mastery-).*\.test\.tsx?$/
    const BASELINE = 189
    let count = 0
    let muted = 0
    const files = readdirSync(DIR).filter((f) => OWN.test(f))
    for (const f of files) {
      const text = readFileSync(join(DIR, f), 'utf8')
      count += text.split('\n').filter((l) => /^\s*(it|test)\(/.test(l)).length
      muted += (text.match(/\b(it|test|describe)\.(skip|only)\b/g) ?? []).length
    }
    const pass = record('P18', count >= BASELINE && muted === 0 && files.length >= 12,
      `tests=${count} muted=${muted} files=${files.length}`,
      `>=${BASELINE} / muted=0 / >=12 files`, 'mastery + skill suites')
    expect(pass, `declarations=${count} (baseline ${BASELINE}), skip/only=${muted}, files=${files.length}`).toBe(true)
  })
})
