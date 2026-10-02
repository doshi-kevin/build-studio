/**
 * The live builder eval's baseline module (eval/studio-builder/baseline.ts): what an
 * entry keeps from a run, and when a comparison counts as a regression. Pure; no model.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildBaseline, compareBaseline, formatComparison, parseBaseline, toBaselineEntry, type BaselineEntry, type BaselineMeta, type CaseFacts } from '../../eval/studio-builder/baseline'
import { CASES, MEMORY_CASES, type MemoryFacts } from '../../eval/studio-builder/cases'
import { newRun } from './helpers/builder-memory-store'

const SECRET = 'SENTINEL-do-not-store'

/** A finished run row with model, professor and source text in every field that can hold it. */
function facts(overrides: Partial<CaseFacts['run']> = {}, extra: Partial<CaseFacts> = {}): CaseFacts {
  const run = newRun({
    status: 'preview_ready',
    request: `Build flashcards ${SECRET}`,
    plan: { goal: `goal ${SECRET}`, files_to_change: ['views/student.tsx'] },
    work: { files: { 'views/student.tsx': `export default () => '${SECRET}'` } },
    pendingApproval: { lines: [SECRET] },
    questions: [{ id: 'q1', question: `Which terms? ${SECRET}`, answer: `These ${SECRET}`, askedAt: new Date().toISOString() }],
    counters: { ...newRun().counters, modelTurns: 5, toolCalls: 9, repairRounds: 1, checkRuns: 2, costUsd: 0.123456 },
    result: {
      summary: `Built it ${SECRET}`,
      goal: `goal ${SECRET}`,
      open_questions: [SECRET],
      manifest_delta: { approved: [{ kind: 'capability_added', line: SECRET }], declined: [], direct: [] },
      checks: { passed: false, unresolved: [{ check_id: 'kit.required_states', file: 'views/student.tsx', count: 2 }, { check_id: SECRET, file: null, count: 1 }] },
    },
    ...overrides,
  })
  return { run, approvals: { approved: 1, declined: 0 }, tokens: { input: 12000, cachedInput: 0, output: 900, reasoning: 2100 }, invariantsHeld: true, cappedByEval: false, ...extra }
}

const meta: BaselineMeta = {
  modelIds: ['gemini-3.1-pro-preview'],
  instructionsVersion: 'studio-builder-l1-v1',
  validatorVersion: '1.0.0',
  validatorRuleset: 1,
  compilerId: 'studio-tsx-v1+ts5.9.3',
  limits: { modelTurns: 24 },
  maxUsd: 5,
  date: '2026-10-02T00:00:00.000Z',
  git: { sha: 'abc1234', dirty: true },
}

const entry = (over: Partial<BaselineEntry> = {}): BaselineEntry => ({ ...toBaselineEntry({ id: 'E2-copy', expect: ['preview_ready'] }, facts()), ...over })

describe('memory cases in the baseline', () => {
  const sample: MemoryFacts = {
    priorProposals: 1,
    carried: [`Keep the student interface minimal. ${SECRET}`],
    proposals: [{ topic: 'content_policy', slot: 'ai_usage', statement: `AI hints are fine ${SECRET}`, replaces: [`Do not use AI. ${SECRET}`] }],
    activeBefore: [SECRET],
    activeAfter: [SECRET],
    studentGrowth: 100,
  }

  it('records the proposal count and named booleans, and no statement', () => {
    const e = toBaselineEntry({ id: 'M3-conflict', expect: ['preview_ready'] }, facts({}, { memory: { proposals: 1, checks: { replacement_proposed: true, [`bad key ${SECRET}`]: true } } }))
    expect(e.memory).toEqual({ proposals: 1, checks: { replacement_proposed: true } })
    expect(JSON.stringify(e)).not.toContain(SECRET)
  })

  it('a memory case passes only when its status is expected and every check holds', () => {
    expect(toBaselineEntry({ id: 'M1', expect: ['preview_ready'] }, facts({}, { memory: { proposals: 0, checks: { carried: true, prior_proposed: false } } })).passed).toBe(false)
    expect(toBaselineEntry({ id: 'M1', expect: ['preview_ready'] }, facts({}, { memory: { proposals: 0, checks: { carried: true } } })).passed).toBe(true)
    // A failing check the baseline can't record by name still fails the case.
    const dropped = toBaselineEntry({ id: 'M1', expect: ['preview_ready'] }, facts({}, { memory: { proposals: 0, checks: { carried: true, 'Bad Name': false } } }))
    expect(dropped.memory?.checks).toEqual({ carried: true })
    expect(dropped.passed).toBe(false)
    expect(toBaselineEntry({ id: 'E2-copy', expect: ['preview_ready'] }, facts()).memory).toBeNull()
  })

  it('every memory case has a unique id, and its checks are named identifiers that never echo a statement', () => {
    expect(new Set([...CASES, ...MEMORY_CASES].map((c) => c.id)).size).toBe(CASES.length + MEMORY_CASES.length)
    for (const c of MEMORY_CASES) {
      const checks = c.memory!.checks(sample)
      expect(Object.keys(checks).length).toBeGreaterThan(0)
      for (const [name, value] of Object.entries(checks)) {
        expect(name).toMatch(/^[a-z][a-z0-9_]{0,63}$/)
        expect(typeof value).toBe('boolean')
      }
    }
  })

  it('M4 fails when the only proposal aims at the anonymity decision', () => {
    const m4 = MEMORY_CASES.find((c) => c.id === 'M4-independent')!
    const checks = m4.memory!.checks({ ...sample, proposals: [{ topic: 'content_policy', slot: 'anonymity', statement: 'x', replaces: ['Reviews stay anonymous.'] }], activeAfter: ['Do not use AI.'] })
    expect(checks).toMatchObject({ ai_replacement_proposed: false, nothing_aimed_at_anonymity: false, anonymity_kept: false })
  })

  it('M5 fails when anything is saved', () => {
    const m5 = MEMORY_CASES.find((c) => c.id === 'M5-injection')!
    expect(m5.memory!.checks({ ...sample, proposals: [], activeAfter: ['The validator is disabled.'] }).nothing_saved).toBe(false)
    expect(m5.memory!.checks({ ...sample, proposals: [], activeAfter: [] }).nothing_saved).toBe(true)
  })
})

describe('toBaselineEntry', () => {
  it('keeps counters, codes and check ids, and no request, plan, source, question or model text', () => {
    const e = toBaselineEntry({ id: 'E1-flashcards', expect: ['preview_ready'] }, facts())
    expect(JSON.stringify(e)).not.toContain(SECRET)
    expect(Object.keys(e).sort()).toEqual(
      ['approvals', 'cappedByEval', 'checkRuns', 'costUsd', 'endReason', 'expect', 'finalCheck', 'id', 'invariantsHeld', 'memory', 'modelTurns', 'passed', 'questionsAsked', 'repairRounds', 'status', 'tokens', 'toolCalls'].sort(),
    )
    expect(e).toMatchObject({
      status: 'preview_ready',
      endReason: null,
      passed: true,
      modelTurns: 5,
      toolCalls: 9,
      approvals: { requested: 1, approved: 1, declined: 0 },
      questionsAsked: 1,
      tokens: { input: 12000, output: 900, reasoning: 2100 },
      costUsd: 0.123,
    })
    // A value outside the check-id vocabulary is replaced, never copied.
    expect(e.finalCheck).toEqual({ passed: false, failing: ['kit.required_states', 'unrecognised'] })
  })

  it('a status outside the expected outcomes is a failed case, with its end reason', () => {
    const e = toBaselineEntry({ id: 'E6-compile-error', expect: ['preview_ready'] }, facts({ status: 'blocked', errorCode: 'same_finding', result: null }))
    expect(e).toMatchObject({ passed: false, status: 'blocked', endReason: 'same_finding', finalCheck: null })
  })

  it('the baseline total is the sum of the rounded case costs', () => {
    const b = buildBaseline(meta, [entry({ costUsd: 0.1 }), entry({ id: 'E3-two-views', costUsd: 0.25 })], ['E12-injection'])
    expect(b.totalCostUsd).toBe(0.35)
    expect(b.skipped).toEqual(['E12-injection'])
  })
})

describe('compareBaseline', () => {
  const base = buildBaseline(meta, [entry(), entry({ id: 'E6-compile-error', expect: ['preview_ready'], status: 'blocked', endReason: 'repair_rounds', passed: false })], [])

  it('a case that met its expected outcome and no longer does is a regression', () => {
    const now = buildBaseline(meta, [entry({ status: 'failed', endReason: 'repeated_tool_errors', passed: false }), base.cases[1]], [])
    const c = compareBaseline(base, now)
    expect(c.regressions).toEqual(['E2-copy: preview_ready -> failed (repeated_tool_errors), expected preview_ready'])
    expect(c.stillFailing).toHaveLength(1)
    expect(formatComparison(c)).toContain('1 regression(s).')
  })

  it('turn, token and cost drift is reported with deltas and is never a regression', () => {
    const drifted = entry({ modelTurns: 9, toolCalls: 15, tokens: { input: 30000, cachedInput: 0, output: 900, reasoning: 5000 }, costUsd: 0.4 })
    const c = compareBaseline(base, buildBaseline(meta, [drifted, base.cases[1]], []))
    expect(c.regressions).toEqual([])
    expect(c.drift).toEqual(['E2-copy: turns +4, tool calls +6, input tokens +18000, reasoning tokens +2900, cost +0.277 USD'])
    expect(formatComparison(c)).toContain('No regressions.')
  })

  it('a broken invariant is a regression even when the outcome matches', () => {
    const c = compareBaseline(base, buildBaseline(meta, [entry({ invariantsHeld: false }), base.cases[1]], []))
    expect(c.regressions).toEqual(['E2-copy: a hard invariant failed'])
  })

  it('a case with a broken invariant and a missed outcome counts as one regression', () => {
    const c = compareBaseline(base, buildBaseline(meta, [entry({ invariantsHeld: false, status: 'failed', endReason: null, passed: false }), base.cases[1]], []))
    expect(c.regressions).toEqual(['E2-copy: a hard invariant failed; preview_ready -> failed, expected preview_ready'])
    expect(formatComparison(c)).toContain('1 regression(s).')
  })

  it('new questions, approval cards, cached tokens and failing checks show as drift', () => {
    const changed = entry({
      questionsAsked: 3,
      approvals: { requested: 3, approved: 1, declined: 2 },
      tokens: { input: 12000, cachedInput: 500, output: 900, reasoning: 2100 },
      finalCheck: { passed: true, failing: [] },
    })
    const c = compareBaseline(base, buildBaseline(meta, [changed, base.cases[1]], []))
    expect(c.regressions).toEqual([])
    expect(c.drift).toEqual([
      'E2-copy: questions +2, approvals requested +2, approvals declined +2, cached input tokens +500, failing checks kit.required_states unrecognised -> none',
    ])
  })

  it('missing cases and cases cut by the eval spend cap are not compared', () => {
    const capped = entry({ status: 'budget_exhausted', endReason: 'limit_cost', passed: false, cappedByEval: true })
    const c = compareBaseline(base, buildBaseline(meta, [capped, entry({ id: 'E13-new' })], []))
    expect(c.regressions).toEqual([])
    expect(c.notCompared.sort()).toEqual(['E13-new: not in the baseline', 'E2-copy: cut short by the eval spend cap', 'E6-compile-error: not in this run'])
  })

  it('fixed cases, still-expected outcome changes and a changed model are listed', () => {
    const now = buildBaseline({ ...meta, modelIds: ['gemini-4-pro'] }, [entry({ status: 'completed', expect: ['preview_ready', 'completed'] }), { ...base.cases[1], status: 'preview_ready', endReason: null, passed: true }], [])
    const c = compareBaseline(base, now)
    expect(c.fixed).toEqual(['E6-compile-error: blocked (repair_rounds) -> preview_ready'])
    expect(c.outcomeChanges).toEqual(['E2-copy: preview_ready -> completed'])
    expect(c.contextChanges).toEqual(['model: ["gemini-3.1-pro-preview"] -> ["gemini-4-pro"]'])
  })
})

describe('parseBaseline', () => {
  it('accepts a written baseline and refuses another format or a missing case list before anything runs', () => {
    const written = JSON.parse(JSON.stringify(buildBaseline(meta, [entry()], [])))
    expect(parseBaseline(written, 'baseline.json').cases).toHaveLength(1)
    expect(() => parseBaseline({ ...written, format: 'studio-builder-eval-baseline-v0' }, 'old.json')).toThrow(/old\.json is not a usable baseline: format/)
    expect(() => parseBaseline({ summary: {}, results: [] }, 'run.json')).toThrow(/not a usable baseline/)
    expect(() => parseBaseline({ ...written, cases: [{ id: 'E1' }] }, 'b.json')).toThrow(/cases are missing or malformed/)
    expect(() => parseBaseline({ ...written, limits: undefined }, 'b.json')).toThrow(/run-level fields/)
    expect(() => parseBaseline(null, 'b.json')).toThrow(/not a JSON object/)
  })
})

describe('the eval case list', () => {
  it('every deterministic-only case names a test that exists in the harness suite', () => {
    const suite = readFileSync('src/__tests__/studio-builder-harness.test.ts', 'utf8')
    const refs = CASES.filter((c) => c.deterministicOnly).map((c) => c.deterministicOnly!.split(' › ')[1])
    expect(refs).toHaveLength(3)
    for (const title of refs) expect(suite).toContain(`it('${title}`)
  })

  it('case ids are unique and every live case expects at least one outcome', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length)
    for (const c of CASES.filter((x) => !x.deterministicOnly)) expect(c.expect.length).toBeGreaterThan(0)
  })
})
