/**
 * Suite statistics, nondeterminism measures and baseline comparison for
 * studio-generation-quality-v1. Results are built through the real evaluation with
 * injected steps, so the rows are exactly what the framework writes.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bootstrapMeanDifference,
  canonicalResults,
  caseVariance,
  compareSuites,
  generationsOf,
  jaccard,
  meanPairwiseJaccard,
  outcomeOf,
  sd,
  stats,
  summarize,
  tierSummary,
  wilson,
} from '../../eval/studio-quality/aggregate'
import { evaluateArtifact, type Artifact, type EvaluateDeps } from '../../eval/studio-quality/evaluate'
import { createScriptedJudge } from '../../eval/studio-quality/judge'
import type { Level } from '../../eval/studio-quality/rubric'
import { qualityResultSchema, type QualityResult } from '../../eval/studio-quality/schema'
import { NORMAL_SHOTS, PROFESSOR_SRC, STUDENT_SRC, extraction, scores } from './helpers/quality-fixtures'

const INVARIANTS = { terminal: true, onlyTwoFiles: true, catalogCapabilitiesOnly: true, noUnapprovedCapability: true, noUnapprovedMemory: true }
const STAGE2 = ['runtime.boot', 'runtime.isolation'].map((checkId) => ({ checkId, status: 'passed', views: { student: 'passed', professor: 'passed' }, findings: [] }))

interface Spec {
  caseId?: string
  set?: 'dev' | 'holdout'
  category?: string
  generation?: number
  group?: string
  level?: Level
  judgeLevels?: Level[]
  failInvariant?: boolean
  codeOnly?: boolean
  cost?: number
  actions?: string[]
  access?: string[]
  scriptedJudge?: boolean
  capped?: boolean
  tier?: 'core' | 'deep' | null
  /** How the build ended; preview_ready unless given. */
  status?: string
  isolationFails?: boolean
  bootFails?: boolean
  draftFails?: boolean
}

async function result(spec: Spec): Promise<QualityResult> {
  const levels = spec.judgeLevels ?? [spec.level ?? 'acceptable']
  let pass = 0
  const judge = createScriptedJudge(
    (req) => {
      if (req.stage === 'extract') {
        const base = extraction(!spec.codeOnly)
        if (spec.actions) base.items.push(...spec.actions.map((text, i) => ({ id: `e${10 + i}`, role: 'professor', kind: 'action', text, sources: ['views/professor.tsx:1'] })))
        return base
      }
      const level = levels[Math.min(pass++, levels.length - 1)]
      return scores(Object.fromEntries(['problem_understanding', 'workflow_completeness', 'professor_experience', 'student_experience', 'interaction_design', 'visual_quality', 'information_design', 'edge_states', 'responsiveness_accessibility'].map((k) => [k, level])), !spec.codeOnly)
    },
    { kind: spec.scriptedJudge ? 'scripted' : 'live', provider: 'test', model: 'test-judge' },
  )
  const a: Artifact = {
    provenance: 'live-build',
    case: { id: spec.caseId ?? 'Q01-attendance', prompt: 'p', category: spec.category ?? 'Staff tracking', tier: spec.tier === undefined ? 'core' : spec.tier, set: spec.set ?? 'dev', variance: true, inPattern: true },
    judgeContext: { professorGoal: null, studentGoal: null, hints: [] },
    rerun: { groupId: spec.group ?? 'g', generation: spec.generation ?? 1 },
    dir: mkdtempSync(join(tmpdir(), 'sgq-agg-')),
    expectedArtifactSha256: null,
    manifest: { bridgeVersion: 'v2', views: { student: { capabilities: [] }, professor: { capabilities: ['course.roster'] } }, collections: Object.fromEntries((spec.access ?? ['staffPerStudent']).map((m, i) => [`c${i}`, { access: m }])) },
    files: { student: STUDENT_SRC, professor: PROFESSOR_SRC },
    sample: null,
    git: { commit: 'abc', dirty: false },
    builder: { model: 'm', thinkingLevel: 'low', maxOutputTokens: 1, instructionsVersion: 'v', instructionsSha256: 's', reviewVersion: 'r', reviewSha256: 's', rendererMode: 'local' },
    build: {
      statuses: [spec.status ?? 'preview_ready'],
      errorCode: null,
      cappedByEval: spec.capped ?? false,
      snapshotHash: null,
      invariants: spec.failInvariant ? { ...INVARIANTS, onlyTwoFiles: false } : INVARIANTS,
      costUsd: spec.cost ?? 0.2,
      tokens: null,
      modelTurns: 6,
      toolCalls: 10,
      repairRounds: 0,
      checkRuns: 1,
      durationMs: null,
      questionsAsked: 0,
      approvalsGiven: 0,
      builderReview: null,
    },
  }
  const deps: EvaluateDeps = {
    draftGate: async () => ({ passed: !spec.draftFails, failing: spec.draftFails ? ['student.compile'] : [], bundles: { student: 's', professor: 'p' }, compiler: 'c' }),
    stage2: async () => ({
      checks: STAGE2.map((c) =>
        (c.checkId === 'runtime.isolation' && spec.isolationFails) || (c.checkId === 'runtime.boot' && spec.bootFails) ? { ...c, status: 'failed', views: { student: 'failed', professor: 'passed' } } : c,
      ),
      runner: { name: 'r', version: '1' },
      bound: true,
    }),
    capture: async () => (spec.codeOnly ? { shots: [], failures: [], missing: ['professor-desktop-normal'], bound: true } : { shots: NORMAL_SHOTS, failures: [], missing: [], bound: true }),
    readImage: () => new Uint8Array([1]),
    judge,
    platformCard: 'card',
    judgePasses: levels.length,
    ledger: null,
    allowCodeOnly: true,
    now: () => new Date('2026-10-07T00:00:00Z'),
  }
  return evaluateArtifact(a, deps)
}

describe('statistics', () => {
  it('basic statistics, and the Wilson interval', () => {
    expect(stats([1, 2, 3, 4])).toEqual({ n: 4, mean: 2.5, median: 2.5, sd: Math.sqrt(5 / 3), min: 1, max: 4 })
    expect(stats([])).toEqual({ n: 0, mean: null, median: null, sd: null, min: null, max: null })
    expect(sd([5])).toBeNull()
    const w = wilson(4, 5)
    expect(w.rate).toBe(0.8)
    expect(w.low).toBeCloseTo(0.3755, 3)
    expect(w.high).toBeCloseTo(0.9638, 3)
    expect(wilson(0, 0).rate).toBeNull()
  })

  it('Jaccard similarity of sets, and the mean over every pair', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3)
    expect(jaccard(new Set(), new Set())).toBe(1)
    expect(meanPairwiseJaccard([new Set(['a']), new Set(['a']), new Set(['b'])])).toBeCloseTo(1 / 3)
    expect(meanPairwiseJaccard([new Set(['a'])])).toBeNull()
  })
})

describe('the suite summary', () => {
  it('keeps code-only results out of the primary statistics, and counts a gate failure as 0', async () => {
    const rows = [await result({ level: 'excellent' }), await result({ level: 'weak', caseId: 'Q03-participation' }), await result({ failInvariant: true, caseId: 'Q05-exit-ticket' }), await result({ codeOnly: true, caseId: 'Q06-vocab-study' })]
    const s = summarize(rows)
    expect(s.comparable).toMatchObject({ n: 2, mean: 70, min: 40, max: 100 })
    // 100, 40 and the failure's 0; the code-only row adds nothing.
    expect(s.suiteCount).toBe(3)
    expect(s.suiteMean).toBeCloseTo(140 / 3)
    expect(s.byMode).toEqual({ 'visual+code': 2, none: 1, 'code-only': 1 })
    expect(s.gatePass).toMatchObject({ rate: 0.75 })
    expect(s.notComparable.map((n) => n.caseId)).toEqual(['Q05-exit-ticket', 'Q06-vocab-study'])
    expect(s.dimensions.workflow_completeness).toMatchObject({ n: 2, mean: 14 })
  })

  it('a scripted judge’s score and a build the eval’s own cap stopped stay out of every suite statistic', async () => {
    const s = summarize([await result({ scriptedJudge: true }), await result({ capped: true, caseId: 'Q02-office-hours-booking' })])
    expect(s.comparable.n).toBe(0)
    expect(s.suiteCount).toBe(0)
    expect(s.notComparable.map((n) => n.failureClass)).toEqual(['none', 'capped_by_eval'])
  })

  it('reports development and holdout cases, and workflow categories, apart', async () => {
    const rows = [await result({ level: 'excellent', set: 'dev', category: 'A' }), await result({ level: 'weak', set: 'holdout', category: 'B', caseId: 'Q07-lab-checkoff' })]
    const s = summarize(rows)
    expect(s.bySet.dev.comparable.mean).toBe(100)
    expect(s.bySet.holdout.comparable.mean).toBe(40)
    expect(Object.keys(s.byCategory).sort()).toEqual(['A', 'B'])
  })

  it('measures judge variance from the runs on each artifact', async () => {
    const s = summarize([await result({ judgeLevels: ['weak', 'excellent', 'acceptable'] })])
    expect(s.judgeVariance.meanDimensionSpread).toBe(2)
    expect(s.judgeVariance.totalSd).toBeCloseTo(sd([40, 100, 70])!)
  })
})

describe('nondeterminism', () => {
  it('groups a case’s generations once each, in order, the baseline build being generation 1', async () => {
    const g1 = await result({ generation: 1, group: 'base' })
    const g3 = await result({ generation: 3, group: 'base' })
    const g2 = await result({ generation: 2, group: 'base' })
    const again = await result({ generation: 2, group: 'base' })
    const other = await result({ caseId: 'Q02-office-hours-booking' })
    expect(generationsOf([g3, g1, g2, again, other], 'Q01-attendance').map((r) => r.rerun.generation)).toEqual([1, 2, 3])
    // Another rerun group's generation 2 is a different generation, not a duplicate.
    const otherGroup = await result({ generation: 2, group: 'second' })
    expect(generationsOf([g1, g2, otherGroup], 'Q01-attendance').map((r) => `${r.rerun.groupId}#${r.rerun.generation}`)).toEqual(['base#1', 'base#2', 'second#2'])
  })

  it('measures score, dimension, output and cost variance across generations', async () => {
    const rows = [
      await result({ generation: 1, level: 'excellent', cost: 0.1, actions: ['Mark everyone present', 'Edit a mark'], access: ['staffPerStudent'] }),
      await result({ generation: 2, level: 'acceptable', cost: 0.3, actions: ['Mark everyone present'], access: ['staffPerStudent'] }),
      await result({ generation: 3, failInvariant: true, cost: 0.2, access: ['perStudent'] }),
    ]
    const v = caseVariance(rows, 'Q01-attendance')
    expect(v.generations).toBe(3)
    expect(v.gatePass.rate).toBeCloseTo(2 / 3)
    expect(v.score).toMatchObject({ n: 2, mean: 85, min: 70, max: 100 })
    expect(v.dimensions.workflow_completeness).toMatchObject({ n: 2, mean: 17 })
    expect(v.costUsd.n).toBe(3)
    expect(v.costUsd.mean).toBeCloseTo(0.2)
    expect(v.signatures).toEqual({ 'student[] professor[course.roster] access[staffPerStudent]': 2, 'student[] professor[course.roster] access[perStudent]': 1 })
    expect(v.coreActionPresent).toEqual({ professor: 2, student: 2, of: 2 })
    // {mark a student present, mark everyone present, edit a mark} against {mark a student present, mark everyone present}.
    expect(v.professorActionJaccard).toBeCloseTo(2 / 3)
  })
})

describe('comparing a candidate with the baseline', () => {
  it('gives the same bootstrap interval every time', () => {
    // Irregular values and few iterations, so an unseeded resample would differ between calls.
    const base = [12.5, 47.3, 61.8, 33.1, 90.4, 5.2]
    const cand = [40.7, 52.9, 88.6, 71.2, 14.8, 66.3]
    expect(bootstrapMeanDifference(base, cand, 200)).toEqual(bootstrapMeanDifference(base, cand, 200))
    const a = bootstrapMeanDifference([50, 60, 70], [70, 80, 90])
    expect(a.difference).toBe(20)
    expect(a.low!).toBeGreaterThan(0)
  })

  it('a clearly better mean is still not an improvement when the gate pass rate fell', async () => {
    const base = await Promise.all(Array.from({ length: 10 }, (_, i) => result({ level: 'weak', generation: i + 1 })))
    const better = await Promise.all(Array.from({ length: 10 }, (_, i) => result({ level: 'excellent', generation: i + 1 })))
    const cmp = compareSuites(base, [...better, await result({ failInvariant: true, generation: 11 })])
    expect(cmp.suiteMean.low!).toBeGreaterThan(0)
    expect(cmp.gatePassRate.candidate!).toBeLessThan(cmp.gatePassRate.baseline!)
    expect(cmp.improved).toBe(false)
  })

  it('calls a change an improvement only when the interval is above zero and gates don’t fall', async () => {
    const base = [await result({ level: 'weak' }), await result({ level: 'weak', caseId: 'Q02-office-hours-booking' }), await result({ level: 'weak', caseId: 'Q03-participation' })]
    const better = [await result({ level: 'excellent' }), await result({ level: 'excellent', caseId: 'Q02-office-hours-booking' }), await result({ level: 'excellent', caseId: 'Q03-participation' })]
    expect(compareSuites(base, better).improved).toBe(true)
    const brokeOne = [...better.slice(0, 2), await result({ failInvariant: true, caseId: 'Q03-participation' })]
    expect(compareSuites(base, brokeOne).improved).toBe(false)
    expect(compareSuites(base, base).improved).toBe(false)
  })
})

describe('the two tiers', () => {
  it('reports Tier 1 and Tier 2 apart, each with development, holdout, gate rate and outcomes, and the overall as the plain mean of canonical cases', async () => {
    const rows = await Promise.all([
      result({ caseId: 'Q01-attendance', level: 'acceptable' }),
      result({ caseId: 'Q03-participation', failInvariant: true }),
      result({ caseId: 'Q07-lab-checkoff', set: 'holdout', level: 'weak' }),
      result({ caseId: 'D01-form-builder', tier: 'deep', level: 'acceptable' }),
      // A repeat for the variance experiment: never counted as a second case.
      result({ caseId: 'D01-form-builder', tier: 'deep', level: 'excellent', generation: 2 }),
      result({ caseId: 'D03-spaced-practice', tier: 'deep', status: 'budget_exhausted' }),
      result({ caseId: 'D04-staged-case', tier: 'deep', isolationFails: true }),
      result({ caseId: 'D02-branching-stories', tier: 'deep', set: 'holdout', level: 'excellent' }),
    ])
    const t = tierSummary(rows)

    expect(t.core).toMatchObject({ label: 'Tier 1, Core Educational Workflows', cases: 3, suiteMean: (70 + 0 + 40) / 3 })
    expect(t.core.dev).toMatchObject({ cases: 2, suiteMean: 35 })
    expect(t.core.holdout).toMatchObject({ cases: 1, suiteMean: 40 })
    expect(t.core.gatePass.rate).toBeCloseTo(2 / 3)
    expect(t.core.outcomes).toEqual({ budget_exhausted: 0, invariant_or_security: 1, build_or_gate: 0, eval_failure: 0, low_quality: 1, scored: 1 })
    expect(t.core.missing).toHaveLength(17)

    expect(t.deep).toMatchObject({ label: 'Tier 2, Complex Product Reasoning', cases: 4 })
    expect(t.deep.dev.suiteMean).toBeCloseTo((70 + 0 + 0) / 3)
    expect(t.deep.holdout).toMatchObject({ cases: 1, suiteMean: 100 })
    expect(t.deep.gatePass.rate).toBe(0.5)
    expect(t.deep.outcomes).toEqual({ budget_exhausted: 1, invariant_or_security: 1, build_or_gate: 0, eval_failure: 0, low_quality: 0, scored: 2 })
    expect(t.deep.failureClasses).toEqual({ none: 2, budget_exhausted: 1, stage2_failed: 1 })
    expect(t.deep.missing).toEqual(['D05-review-game', 'D06-final-grade-calculator', 'D07-peer-feedback', 'D08-lab-notebook'])
    expect(t.deep.quality.mean).toBe(85)

    // Seven canonical cases, each once: the plain mean, failures counted as 0.
    expect(t.overall.cases).toBe(7)
    expect(t.overall.suiteMean).toBeCloseTo((70 + 0 + 40 + 70 + 0 + 0 + 100) / 7)
    expect(t.overall.gatePass.rate).toBeCloseTo(4 / 7)
    expect(Object.values(t.overall.outcomes).reduce((a, b) => a + b, 0)).toBe(7)
    expect(summarize(rows).tiers).toEqual(t)
  })

  it('a canonical case is its first generation, and anything outside the case list is left out', async () => {
    const rows = await Promise.all([
      result({ caseId: 'D01-form-builder', tier: 'deep', level: 'weak', generation: 3 }),
      result({ caseId: 'D01-form-builder', tier: 'deep', level: 'acceptable', generation: 1 }),
      result({ caseId: 'import:G-attendance', tier: null }),
    ])
    expect(canonicalResults(rows).map((r) => [r.case.id, r.rerun.generation])).toEqual([['D01-form-builder', 1]])
  })

  it('tells running out of budget, a broken invariant or isolation, a failed gate, an evaluation gap and a low score apart', async () => {
    const outcome = async (spec: Parameters<typeof result>[0]) => outcomeOf(await result(spec))
    expect(await outcome({ status: 'budget_exhausted' })).toBe('budget_exhausted')
    expect(await outcome({ failInvariant: true })).toBe('invariant_or_security')
    expect(await outcome({ isolationFails: true })).toBe('invariant_or_security')
    // A Stage 2 failure is a security outcome only when isolation failed; a view that won't boot is a gate failure.
    expect(await outcome({ bootFails: true })).toBe('build_or_gate')
    expect(await outcome({ draftFails: true })).toBe('build_or_gate')
    expect(await outcome({ status: 'failed' })).toBe('build_or_gate')
    expect(await outcome({ status: 'blocked' })).toBe('build_or_gate')
    expect(await outcome({ codeOnly: true })).toBe('eval_failure')
    expect(await outcome({ capped: true })).toBe('eval_failure')
    expect(await outcome({ level: 'weak' })).toBe('low_quality')
    expect(await outcome({ level: 'acceptable' })).toBe('scored')
  })

  it('a Tier 2 regression blocks "improved" even when the overall mean rose clearly', async () => {
    const coreIds = ['Q01-attendance', 'Q02-office-hours-booking', 'Q03-participation', 'Q04-peer-review', 'Q05-exit-ticket', 'Q06-vocab-study', 'Q08-group-formation', 'Q09-reading-reflections', 'Q11-anonymous-qa', 'Q12-project-milestones', 'Q14-help-queue', 'Q16-course-pulse']
    const suite = (coreLevel: Level, deepLevel: Level) =>
      Promise.all([
        ...coreIds.map((caseId) => result({ caseId, level: coreLevel })),
        ...['D01-form-builder', 'D03-spaced-practice'].map((caseId) => result({ caseId, tier: 'deep', level: deepLevel })),
      ])
    const baseline = await suite('acceptable', 'acceptable')
    const worseDeep = compareSuites(baseline, await suite('excellent', 'weak'))
    expect(worseDeep.suiteMean.low).toBeGreaterThan(0)
    expect(worseDeep.tiers.deep.regressed).toBe(true)
    expect(worseDeep.tiers.core.regressed).toBe(false)
    expect(worseDeep.improved).toBe(false)
    expect(compareSuites(baseline, await suite('excellent', 'acceptable')).improved).toBe(true)
  })

  it('a tier whose gate pass rate fell regressed, even when its score interval and the overall gate rate held', async () => {
    const coreIds = ['Q01-attendance', 'Q02-office-hours-booking', 'Q03-participation', 'Q04-peer-review', 'Q05-exit-ticket', 'Q06-vocab-study', 'Q08-group-formation', 'Q09-reading-reflections', 'Q11-anonymous-qa', 'Q12-project-milestones', 'Q14-help-queue', 'Q16-course-pulse']
    // Baseline: one Tier 1 gate failure. Candidate: Tier 1 fixed and better, one Tier 2 gate failure.
    const baseline = await Promise.all([
      ...coreIds.map((caseId, i) => result({ caseId, level: 'acceptable', failInvariant: i === 0 })),
      ...['D01-form-builder', 'D03-spaced-practice'].map((caseId) => result({ caseId, tier: 'deep', level: 'acceptable' })),
    ])
    const candidate = await Promise.all([
      ...coreIds.map((caseId) => result({ caseId, level: 'excellent' })),
      result({ caseId: 'D01-form-builder', tier: 'deep', level: 'acceptable' }),
      result({ caseId: 'D03-spaced-practice', tier: 'deep', failInvariant: true }),
    ])
    const c = compareSuites(baseline, candidate)
    expect(c.gatePassRate.candidate).toBe(c.gatePassRate.baseline)
    expect(c.suiteMean.low).toBeGreaterThan(0)
    expect(c.tiers.deep.gatePassRate).toEqual({ baseline: 1, candidate: 0.5 })
    // Two cases can't put the interval below zero, so the gate rate alone marks the regression.
    expect(c.tiers.deep.suiteMean.high).toBeGreaterThanOrEqual(0)
    expect(c.tiers.deep.regressed).toBe(true)
    expect(c.tiers.core.regressed).toBe(false)
    expect(c.improved).toBe(false)
  })

  it('a result written before Tier 2 has no tier, and is still counted in its case’s tier', async () => {
    const written = await Promise.all([result({ caseId: 'Q01-attendance', level: 'acceptable' }), result({ caseId: 'D01-form-builder', tier: 'deep', level: 'excellent' })])
    const old = written.map((r) => {
      const raw = JSON.parse(JSON.stringify(r))
      delete raw.case.tier
      return qualityResultSchema.parse(raw)
    })
    expect(old.map((r) => r.case.tier)).toEqual([null, null])
    const t = tierSummary(old)
    expect([t.core.cases, t.core.suiteMean, t.deep.cases, t.deep.suiteMean]).toEqual([1, 70, 1, 100])
    expect(tierSummary(old)).toEqual(tierSummary(written))
  })
})
