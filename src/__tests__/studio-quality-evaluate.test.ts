/**
 * From one artifact to one studio-generation-quality-result-v1, with every external step
 * injected: the hard gates, comparability, code-only diagnostics, judge failure, and the
 * result schema.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { artifactHash, evaluateArtifact, type Artifact, type EvaluateDeps } from '../../eval/studio-quality/evaluate'
import { snapshotHash } from '@/lib/studio/builder/snapshot'
import { createScriptedJudge } from '../../eval/studio-quality/judge'
import { parseQualityResult, RESULT_SCHEMA } from '../../eval/studio-quality/schema'
import type { Stage2Check } from '../../eval/studio-quality/gates'
import { NORMAL_SHOTS, PROFESSOR_SRC, STUDENT_SRC, shot, validJudge } from './helpers/quality-fixtures'

const INVARIANTS = { terminal: true, onlyTwoFiles: true, catalogCapabilitiesOnly: true, noUnapprovedCapability: true, noUnapprovedMemory: true }

function artifact(overrides: Partial<Artifact> = {}, build: Partial<Artifact['build']> = {}): Artifact {
  return {
    provenance: 'live-build',
    case: { id: 'Q01-attendance', prompt: 'I want to take attendance in my lectures this semester.', category: 'Staff tracking', tier: 'core', set: 'dev', variance: true, inPattern: true },
    judgeContext: { professorGoal: 'Record each session.', studentGoal: 'See their record.', hints: ['sessions or dates'] },
    rerun: { groupId: 'group-1', generation: 1 },
    dir: mkdtempSync(join(tmpdir(), 'sgq-')),
    expectedArtifactSha256: null,
    manifest: { bridgeVersion: 'v2', views: { student: { capabilities: ['context.get'] }, professor: { capabilities: ['course.roster'] } }, collections: { marks: { access: 'staffPerStudent' } } },
    files: { student: STUDENT_SRC, professor: PROFESSOR_SRC },
    sample: { marks: [] },
    git: { commit: 'abcdef12', dirty: false },
    builder: { model: 'gemini-3.1-pro-preview', thinkingLevel: 'low', maxOutputTokens: 24000, instructionsVersion: 'studio-builder-l1-v12', instructionsSha256: 'a'.repeat(64), reviewVersion: 'studio-review-v2', reviewSha256: 'b'.repeat(64), rendererMode: 'local' },
    build: {
      statuses: ['preview_ready'],
      errorCode: null,
      cappedByEval: false,
      snapshotHash: null,
      invariants: { ...INVARIANTS },
      costUsd: 0.2,
      tokens: { input: 1000, cachedInput: 0, output: 200, reasoning: 50 },
      modelTurns: 6,
      toolCalls: 12,
      repairRounds: 0,
      checkRuns: 1,
      durationMs: 60000,
      questionsAsked: 0,
      approvalsGiven: 1,
      builderReview: { rounds: 1, rendered: true, verdict: 'ready' },
      ...build,
    },
    ...overrides,
  }
}

const STAGE2_PASS: Stage2Check[] = ['runtime.boot', 'runtime.isolation', 'runtime.mobile_layout', 'runtime.touch_targets', 'runtime.accessibility', 'runtime.states'].map((checkId) => ({
  checkId,
  status: 'passed',
  views: { student: 'passed', professor: 'passed' },
  findings: [],
}))
const failing = (checkId: string): Stage2Check[] => STAGE2_PASS.map((c) => (c.checkId === checkId ? { ...c, status: 'failed', views: { student: 'passed', professor: 'failed' } } : c))

function deps(overrides: Partial<EvaluateDeps> = {}, judge = createScriptedJudge(validJudge(), { kind: 'live', provider: 'test', model: 'test-judge', reasoning: 'high' })): EvaluateDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    draftGate: async () => (calls.push('draftGate'), { passed: true, failing: [], bundles: { student: 'S', professor: 'P' }, compiler: 'studio-tsx-v1+ts5.9.3' }),
    stage2: async () => (calls.push('stage2'), { checks: STAGE2_PASS, runner: { name: 'scholera-local-runner', version: '1.0.0' }, bound: true }),
    capture: async () => (calls.push('capture'), { shots: [...NORMAL_SHOTS, shot('student', 'desktop', 'empty')], failures: [], missing: [], bound: true }),
    readImage: () => new Uint8Array([1, 2, 3]),
    judge,
    platformCard: 'card',
    judgePasses: 3,
    ledger: null,
    allowCodeOnly: false,
    now: () => new Date('2026-10-07T12:00:00Z'),
    ...overrides,
  }
}

describe('a clean live build', () => {
  it('passes every gate, is judged on screenshots and code, and is comparable', async () => {
    const a = artifact()
    const r = await evaluateArtifact(a, deps())
    expect(r.gates).toMatchObject({ build: 'passed', correctness: 'passed', visualEvidence: { status: 'passed' } })
    expect(r.evaluation.mode).toBe('visual+code')
    expect(r.evaluation.passesSucceeded).toBe(3)
    expect(r.qualityScore).toBe(70)
    expect(r.comparable).toBe(true)
    expect(r.suiteContribution).toBe(70)
    expect(r.failureClass).toBe('none')
    expect(r.stage2.publishable).toBe(true)
    expect(r.build.signature).toEqual({ studentCapabilities: ['context.get'], professorCapabilities: ['course.roster'], accessModes: ['staffPerStudent'] })
    expect(r.build.platform.kitVendorSha256).toMatch(/^[0-9a-f]{64}$/)
    // The result on disk is the same validated object.
    expect(JSON.parse(readFileSync(join(a.dir, 'result.json'), 'utf8'))).toEqual(r)
  })

  it('a scripted judge never makes a result comparable', async () => {
    const r = await evaluateArtifact(artifact(), deps({}, createScriptedJudge(validJudge())))
    expect(r.qualityScore).toBe(70)
    expect(r.comparable).toBe(false)
    expect(r.suiteContribution).toBeNull()
    expect(r.comparabilityNotes).toContain('scripted judge: pipeline check only, not a judgement')
  })
})

describe('correctness gates: no score, and 0 in the suite', () => {
  it.each([
    ['a failed invariant', artifact({}, { invariants: { ...INVARIANTS, noUnapprovedCapability: false } }), {}, 'invariant_violation', 'invariant noUnapprovedCapability'],
    ['a blocked build', artifact({}, { statuses: ['blocked'] }), {}, 'build_blocked', 'build ended blocked'],
    ['a failed build', artifact({}, { statuses: ['failed'] }), {}, 'build_failed', 'build ended failed'],
    ['a first build that found nothing to make', artifact({}, { statuses: ['completed'] }), {}, 'build_failed', 'build ended completed'],
    ['a failed draft gate', artifact(), { draftGate: async () => ({ passed: false, failing: ['code.network'], bundles: null, compiler: null }) }, 'draft_gate_failed', 'draft gate: code.network'],
    ['a Stage 2 boot failure', artifact(), { stage2: async () => ({ checks: failing('runtime.boot'), runner: { name: 'r', version: '1' }, bound: true }) }, 'stage2_failed', 'Stage 2 runtime.boot'],
    ['a Stage 2 isolation failure', artifact(), { stage2: async () => ({ checks: failing('runtime.isolation'), runner: { name: 'r', version: '1' }, bound: true }) }, 'stage2_failed', 'Stage 2 runtime.isolation'],
  ] as const)('%s', async (_name, a, override, failureClass, failure) => {
    const d = deps(override as Partial<EvaluateDeps>)
    const r = await evaluateArtifact(a, d)
    expect(r.gates.correctness).toBe('failed')
    expect(r.gates.failures).toContain(failure)
    expect(r.failureClass).toBe(failureClass)
    expect(r.qualityScore).toBeNull()
    expect(r.suiteContribution).toBe(0)
    expect(r.comparable).toBe(false)
    // Nothing is judged, or screenshotted, once correctness has failed.
    expect(r.evaluation.mode).toBe('none')
    expect(d.calls).not.toContain('capture')
  })

  it('a missing view fails the draft gate without calling it', async () => {
    const d = deps()
    const r = await evaluateArtifact(artifact({ files: { student: STUDENT_SRC, professor: null } }), d)
    expect(r.gates.draftGate).toEqual({ status: 'failed', failing: ['builder.files'] })
    expect(r.failureClass).toBe('draft_gate_failed')
    expect(r.suiteContribution).toBe(0)
    expect(d.calls).toEqual([])
  })

  it('a Stage 2 quality failure is recorded as not publishable, not as a gate', async () => {
    const r = await evaluateArtifact(artifact(), deps({ stage2: async () => ({ checks: failing('runtime.touch_targets'), runner: { name: 'r', version: '1' }, bound: true }) }))
    expect(r.gates.correctness).toBe('passed')
    expect(r.stage2.publishable).toBe(false)
    expect(r.comparable).toBe(true)
  })
})

describe('missing screenshots', () => {
  const noShots = { capture: async () => ({ shots: [shot('student', 'desktop')], failures: [{ id: 'professor-desktop-normal', reason: 'crashed' }], missing: ['professor-desktop-normal', 'professor-phone-normal', 'student-phone-normal'], bound: true }) }

  it('are recorded, and by default nothing is judged', async () => {
    const r = await evaluateArtifact(artifact(), deps(noShots))
    expect(r.gates.visualEvidence).toEqual({ status: 'failed', missing: ['professor-desktop-normal', 'professor-phone-normal', 'student-phone-normal'] })
    expect(r.gates.correctness).toBe('passed')
    expect(r.failureClass).toBe('capture_failed')
    expect(r.evaluation.mode).toBe('none')
    expect(r.suiteContribution).toBeNull()
    expect(r.comparable).toBe(false)
  })

  it('allow a diagnostic code-only evaluation that never scores visual quality and never counts', async () => {
    const judge = createScriptedJudge(validJudge([{}], false), { kind: 'live', provider: 'test', model: 'test-judge' })
    const r = await evaluateArtifact(artifact(), deps({ ...noShots, allowCodeOnly: true }, judge))
    expect(r.evaluation.mode).toBe('code-only')
    expect(r.evaluation.dimensions!.visual_quality).toMatchObject({ assessed: false, level: null })
    expect(r.qualityScore).toBeNull()
    expect(r.comparable).toBe(false)
    expect(r.suiteContribution).toBeNull()
    expect(r.comparabilityNotes).toContain('code-only evaluation: visual quality not measured')
    expect(judge.requests.every((q) => q.images.length === 0)).toBe(true)
    expect(r.evaluation.evidence.some((e) => e.kind === 'screenshot')).toBe(false)
  })

  it('a capture process that fails outright counts as missing evidence', async () => {
    const r = await evaluateArtifact(artifact(), deps({ capture: async () => null }))
    expect(r.gates.visualEvidence).toEqual({ status: 'failed', missing: ['capture failed'] })
  })
})

describe('the judge failing', () => {
  it('leaves no score, keeps the case out of the suite, and records why', async () => {
    const r = await evaluateArtifact(artifact(), deps({}, createScriptedJudge(() => 'nonsense', { kind: 'live' })))
    expect(r.failureClass).toBe('judge_failed')
    expect(r.qualityScore).toBeNull()
    expect(r.suiteContribution).toBeNull()
    expect(r.evaluation.passesSucceeded).toBe(0)
    expect(r.evaluation.attempts.length).toBeGreaterThan(0)
  })
})

describe('imported artifacts', () => {
  it('are never comparable, and their unknown metadata stays unknown', async () => {
    const a = artifact({ provenance: 'imported-artifact' }, { invariants: null, tokens: null, snapshotHash: null })
    const r = await evaluateArtifact(a, deps())
    expect(r.gates.invariants.status).toBe('unknown')
    expect(r.gates.correctness).toBe('unknown')
    expect(r.failureClass).toBe('metadata_incomplete')
    expect(r.comparable).toBe(false)
    expect(r.suiteContribution).toBeNull()
    expect(r.build.tokens).toBeNull()
  })
})

describe('evidence integrity: everything is of the same artifact', () => {
  it('records the checks, and passes when they all hold', async () => {
    const a = artifact()
    const compiler = 'studio-tsx-v1+ts5.9.3'
    a.build.snapshotHash = snapshotHash(compiler, a.manifest, { 'views/student.tsx': STUDENT_SRC, 'views/professor.tsx': PROFESSOR_SRC }, a.sample)
    a.expectedArtifactSha256 = artifactHash(a.manifest, a.files, a.sample)
    const r = await evaluateArtifact(a, deps())
    expect(r.integrity).toMatchObject({ artifactMatches: true, snapshotHashMatches: true, stage2Bound: true, captureBound: true, ok: true })
    expect(r.integrity.bundleSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.comparable).toBe(true)
  })

  it.each([
    ['source from another generation', (a: Artifact): void => {
      a.expectedArtifactSha256 = 'f'.repeat(64)
    }, {}, 'artifactMatches'],
    ['a snapshot hash of another build', (a: Artifact): void => {
      a.build.snapshotHash = 'c'.repeat(64)
    }, {}, 'snapshotHashMatches'],
    ['a Stage 2 report of another payload', (): void => {}, { stage2: async () => ({ checks: STAGE2_PASS, runner: { name: 'r', version: '1' }, bound: false }) }, 'stage2Bound'],
    ['screenshots of other bundles', (): void => {}, { capture: async () => ({ shots: NORMAL_SHOTS, failures: [], missing: [], bound: false }) }, 'captureBound'],
  ] as const)('%s fails integrity: no score, out of the suite, never 0', async (_name, mutate, override, check) => {
    const a = artifact()
    mutate(a)
    const r = await evaluateArtifact(a, deps(override as Partial<EvaluateDeps>))
    expect(r.integrity[check]).toBe(false)
    expect(r.integrity.ok).toBe(false)
    expect(r.failureClass).toBe('integrity_failed')
    // Never judged: a score it can't keep isn't worth paying for.
    expect(r.evaluation.mode).toBe('none')
    expect(r.evaluation.passesSucceeded).toBe(0)
    expect(r.qualityScore).toBeNull()
    expect(r.suiteContribution).toBeNull()
    expect(r.comparable).toBe(false)
  })

  it('keeps the exact source it judged beside the result', async () => {
    const a = artifact()
    await evaluateArtifact(a, deps())
    expect(readFileSync(join(a.dir, 'source', 'professor.tsx'), 'utf8')).toBe(PROFESSOR_SRC)
    expect(readFileSync(join(a.dir, 'source', 'student.tsx'), 'utf8')).toBe(STUDENT_SRC)
  })
})

describe('the result schema', () => {
  it('round-trips, and refuses a wrong version, a missing field or an extra one', async () => {
    const r = await evaluateArtifact(artifact(), deps())
    const again = parseQualityResult(JSON.parse(JSON.stringify(r)))
    expect(again.ok && again.result).toEqual(r)
    expect(r.schema).toBe(RESULT_SCHEMA)
    expect(parseQualityResult({ ...r, schema: 'studio-generation-quality-result-v1' }).ok).toBe(false)
    expect(parseQualityResult({ ...r, rubricVersion: 'studio-generation-quality-v0' }).ok).toBe(false)
    const missing: Record<string, unknown> = { ...r }
    delete missing.failureClass
    expect(parseQualityResult(missing).ok).toBe(false)
    expect(parseQualityResult({ ...r, extra: true }).ok).toBe(false)
    expect(parseQualityResult({ ...r, qualityScore: 101 }).ok).toBe(false)
  })
})
