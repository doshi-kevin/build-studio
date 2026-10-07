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
  caseVariance,
  compareSuites,
  generationsOf,
  jaccard,
  meanPairwiseJaccard,
  sd,
  stats,
  summarize,
  wilson,
} from '../../eval/studio-quality/aggregate'
import { evaluateArtifact, type Artifact, type EvaluateDeps } from '../../eval/studio-quality/evaluate'
import { createScriptedJudge } from '../../eval/studio-quality/judge'
import type { Level } from '../../eval/studio-quality/rubric'
import type { QualityResult } from '../../eval/studio-quality/schema'
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
    case: { id: spec.caseId ?? 'Q01-attendance', prompt: 'p', category: spec.category ?? 'Staff tracking', set: spec.set ?? 'dev', variance: true, inPattern: true },
    judgeContext: { professorGoal: null, studentGoal: null, hints: [] },
    rerun: { groupId: spec.group ?? 'g', generation: spec.generation ?? 1 },
    dir: mkdtempSync(join(tmpdir(), 'sgq-agg-')),
    manifest: { bridgeVersion: 'v2', views: { student: { capabilities: [] }, professor: { capabilities: ['course.roster'] } }, collections: Object.fromEntries((spec.access ?? ['staffPerStudent']).map((m, i) => [`c${i}`, { access: m }])) },
    files: { student: STUDENT_SRC, professor: PROFESSOR_SRC },
    sample: null,
    git: { commit: 'abc', dirty: false },
    builder: { model: 'm', thinkingLevel: 'low', maxOutputTokens: 1, instructionsVersion: 'v', instructionsSha256: 's', reviewVersion: 'r', reviewSha256: 's', rendererMode: 'local' },
    build: {
      statuses: ['preview_ready'],
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
    draftGate: async () => ({ passed: true, failing: [], bundles: { student: 's', professor: 'p' }, compiler: 'c' }),
    stage2: async () => ({ checks: STAGE2, runner: { name: 'r', version: '1' } }),
    capture: async () => (spec.codeOnly ? { shots: [], failures: [], missing: ['professor-desktop-normal'] } : { shots: NORMAL_SHOTS, failures: [], missing: [] }),
    readImage: () => new Uint8Array([1]),
    judge,
    platformCard: 'card',
    judgePasses: levels.length,
    judgeBudgetUsd: () => Infinity,
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
