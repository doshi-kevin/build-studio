/**
 * Step 12A.3, evaluating the evaluator: contrast pairs, repeatability, the blind human pack
 * and the AI-versus-human comparison, the holdout seal, and the rubric and judge-prompt freeze.
 * Results come through the real evaluation with a scripted judge.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  analyseRepeatability,
  applyEdits,
  assertNoHoldout,
  compareWithHuman,
  CONTRASTS,
  contrastLinkSchema,
  humanScoresSchema,
  humanTemplate,
  materializeContrast,
  scoreContrast,
  writeHumanPack,
  type ContrastPair,
  type HumanScores,
  type PackKey,
} from '../../eval/studio-quality/calibration'
import { QUALITY_CASES } from '../../eval/studio-quality/cases'
import { artifactHash, evaluateArtifact, type Artifact } from '../../eval/studio-quality/evaluate'
import { createScriptedJudge } from '../../eval/studio-quality/judge'
import { unpreviewableCapabilities } from '../../eval/studio-quality/evidence'
import { comparability } from '../../eval/studio-quality/gates'
import { QUALITY_FROZEN, judgePromptFingerprint, qualityFreezeDrift, rubricFingerprint } from '../../eval/studio-quality/quality-freeze'
import { DIMENSION_KEYS, type DimensionKey, type Level } from '../../eval/studio-quality/rubric'
import type { QualityResult } from '../../eval/studio-quality/schema'
import { NORMAL_SHOTS, PROFESSOR_SRC, STUDENT_SRC, validJudge } from './helpers/quality-fixtures'

const tmp = () => mkdtempSync(join(tmpdir(), 'sgq-cal-'))
const STAGE2 = ['runtime.boot', 'runtime.isolation'].map((checkId) => ({ checkId, status: 'passed', views: { student: 'passed', professor: 'passed' }, findings: [] }))
/** Sources long enough for the fixture's line citations, made distinct by a trailing comment. */
const variant = (n: string | number) => ({ professor: `${PROFESSOR_SRC}
// ${n}`, student: `${STUDENT_SRC}
// ${n}` })
const all = (level: Level) => Object.fromEntries(DIMENSION_KEYS.map((k) => [k, level])) as Record<DimensionKey, Level>

/** A judged result whose runs give these levels (each run: every dimension at that level, with overrides). */
async function judged(runs: Partial<Record<DimensionKey, Level>>[], files = { professor: PROFESSOR_SRC, student: STUDENT_SRC }, caseId = 'import:x'): Promise<{ result: QualityResult; dir: string }> {
  const dir = tmp()
  const a: Artifact = {
    provenance: 'imported-artifact',
    case: { id: caseId, prompt: 'Build an attendance tracker.', category: 'imported', tier: null, set: 'imported', variance: false, inPattern: null },
    judgeContext: { professorGoal: null, studentGoal: null, hints: [] },
    rerun: { groupId: 'g', generation: 1 },
    dir,
    expectedArtifactSha256: null,
    manifest: { bridgeVersion: 'v2', views: {}, collections: {} },
    files,
    sample: null,
    git: { commit: null, dirty: null },
    builder: { model: null, thinkingLevel: null, maxOutputTokens: null, instructionsVersion: null, instructionsSha256: null, reviewVersion: null, reviewSha256: null, rendererMode: null },
    build: { statuses: ['preview_ready'], errorCode: null, cappedByEval: null, snapshotHash: null, invariants: null, costUsd: null, tokens: null, modelTurns: null, toolCalls: null, repairRounds: null, checkRuns: null, durationMs: null, questionsAsked: null, approvalsGiven: null, builderReview: null },
  }
  const judge = createScriptedJudge(validJudge(runs.map((r) => ({ ...all('acceptable'), ...r }))), { kind: 'live', provider: 'test', model: 'test-judge' })
  const result = await evaluateArtifact(a, {
    draftGate: async () => ({ passed: true, failing: [], bundles: { student: 's', professor: 'p' }, compiler: 'c' }),
    stage2: async () => ({ checks: STAGE2, runner: { name: 'r', version: '1' }, bound: true }),
    capture: async () => ({ shots: NORMAL_SHOTS, failures: [], missing: [], bound: true }),
    readImage: () => new Uint8Array([1]),
    judge,
    platformCard: 'card',
    judgePasses: runs.length,
    ledger: null,
    allowCodeOnly: false,
    now: () => new Date('2026-10-07T00:00:00Z'),
  })
  return { result, dir }
}

describe('the contrast set', () => {
  it('has one realistic contrast for each kind A to F, each with must-drop dimensions and a pinned original', () => {
    expect(CONTRASTS.map((c) => c.kind)).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    const expected: Record<string, DimensionKey> = { A: 'workflow_completeness', B: 'workflow_completeness', C: 'responsiveness_accessibility', D: 'edge_states', E: 'student_experience', F: 'information_design' }
    for (const c of CONTRASTS) {
      expect(c.targeted).toContain(expected[c.kind])
      expect(c.targeted.some((t) => c.mayAlsoDecline.includes(t))).toBe(false)
      expect(c.originalSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(c.edits.length).toBeGreaterThan(0)
    }
    expect(new Set(CONTRASTS.map((c) => c.id)).size).toBe(CONTRASTS.length)
  })

  it('an edit must match exactly once, or nothing is changed', () => {
    const files = { professor: 'a b a', student: 'x' }
    expect(applyEdits(files, [{ file: 'student.tsx', find: 'x', replace: 'y' }])).toEqual({ professor: 'a b a', student: 'y' })
    expect(() => applyEdits(files, [{ file: 'professor.tsx', find: 'a', replace: 'z' }])).toThrow(/matched 2 times/)
    expect(() => applyEdits(files, [{ file: 'professor.tsx', find: /q+/, replace: 'z' }])).toThrow(/matched 0 times/)
  })

  it('writes original, degraded and the link between them, and refuses an original that changed', () => {
    const root = tmp()
    const src = join(root, 'orig')
    mkdirSync(src)
    writeFileSync(join(src, 'manifest.json'), '{"name":"T"}')
    writeFileSync(join(src, 'professor.tsx'), 'export default function P() { return <Button>Call next</Button> }')
    writeFileSync(join(src, 'student.tsx'), 'S')
    writeFileSync(join(src, 'sample.json'), 'null')
    const pair: ContrastPair = { id: 'A-test', kind: 'A', label: 'Core action removed', original: 'orig', originalSha256: '', targeted: ['workflow_completeness'], mayAlsoDecline: [], change: 'no call', edits: [{ file: 'professor.tsx', find: '<Button>Call next</Button>', replace: 'null' }] }
    const link = materializeContrast(pair, root, join(root, 'out'))
    expect(contrastLinkSchema.parse(JSON.parse(readFileSync(join(root, 'out', 'A-test', 'contrast.json'), 'utf8')))).toEqual(link)
    expect(readFileSync(join(link.degraded.dir, 'professor.tsx'), 'utf8')).toContain('return null')
    expect(readFileSync(join(link.original.dir, 'professor.tsx'), 'utf8')).toContain('Call next')
    expect(link.degraded.artifactSha256).not.toBe(link.original.artifactSha256)
    expect(link.original.artifactSha256).toBe(artifactHash({ name: 'T' }, { professor: 'export default function P() { return <Button>Call next</Button> }', student: 'S' }, null))
    expect(() => materializeContrast({ ...pair, originalSha256: 'f'.repeat(64) }, root, join(root, 'out2'))).toThrow(/not the artifact this contrast was written for/)
    expect(() => materializeContrast({ ...pair, edits: [{ file: 'professor.tsx', find: 'Call later', replace: '' }] }, root, join(root, 'out3'))).toThrow(/matched 0 times/)
    // A refused pair leaves nothing behind that a later judge-only run could pick up.
    expect(existsSync(join(root, 'out2'))).toBe(false)
    expect(existsSync(join(root, 'out3'))).toBe(false)
  })

  it('passes only when every targeted dimension drops a median level, and names collateral changes', async () => {
    const original = await judged([{ workflow_completeness: 'excellent', edge_states: 'acceptable' }])
    const degraded = await judged([{ workflow_completeness: 'weak', edge_states: 'weak', information_design: 'excellent' }], variant('changed'))
    const link = {
      format: 'studio-quality-contrast-v1' as const,
      id: 'A-x',
      kind: 'A' as const,
      label: 'x',
      change: 'x',
      original: { source: 'o', dir: 'o', artifactSha256: original.result.build.artifactSha256 },
      degraded: { dir: 'd', artifactSha256: degraded.result.build.artifactSha256 },
      targeted: ['workflow_completeness' as const],
      mayAlsoDecline: ['edge_states' as const],
    }
    const ok = scoreContrast(link, original.result, degraded.result)
    expect(ok.passed).toBe(true)
    expect(ok.targeted[0]).toMatchObject({ original: 'excellent', degraded: 'weak', drop: 2 })
    expect(ok.collateral).toEqual([
      { dimension: 'information_design', original: 'acceptable', degraded: 'excellent', change: 1, expected: false },
      { dimension: 'edge_states', original: 'acceptable', degraded: 'weak', change: -1, expected: true },
    ])
    // No drop: fails. Results of the wrong artifacts: fail with the reason, whatever the levels say.
    expect(scoreContrast(link, original.result, original.result).passed).toBe(false)
    const swapped = scoreContrast({ ...link, degraded: { ...link.degraded, artifactSha256: 'f'.repeat(64) } }, original.result, degraded.result)
    expect(swapped.passed).toBe(false)
    expect(swapped.problems).toContain('the degraded result is of a different artifact')
    expect(scoreContrast(link, original.result, null).problems).toContain('the degraded artifact has no judgement')
  })
})

describe('repeatability', () => {
  it('counts agreement per dimension and recommends one run when runs never disagree', async () => {
    const steady = await judged([{}, {}, {}, {}, {}])
    const r = analyseRepeatability([steady.result])
    expect(r.dimensionAgreement).toEqual({ judgements: 9, allAgree: 9, oneApart: 0, moreApart: 0 })
    expect(r.singleRunVsMedian).toEqual({ exact: 45, withinOne: 45, of: 45 })
    expect(r.recommendedPasses).toBe(1)
    expect(r.totalSpread[0].range).toBe(0)
  })

  it('recommends three runs when a single run is unreliable but a median of three is stable', async () => {
    // Three dimensions each come out one level lower in 2 of 5 runs. One run alone matches the
    // five-run median 39 times in 45 (86.7%); a median of three matches it 81 times in 90 (90%).
    const off = { workflow_completeness: 'weak', professor_experience: 'weak', student_experience: 'weak' } as const
    const shaky = await judged([off, off, {}, {}, {}])
    const r = analyseRepeatability([shaky.result])
    expect(r.dimensionAgreement).toEqual({ judgements: 9, allAgree: 6, oneApart: 3, moreApart: 0 })
    expect(r.singleRunVsMedian).toEqual({ exact: 39, withinOne: 45, of: 45 })
    expect(r.medianOf3VsAll).toEqual({ exact: 81, of: 90 })
    expect(r.recommendedPasses).toBe(3)
  })

  it('with fewer than five runs, keeps three unmeasured against more, and ignores single-run results', async () => {
    const off = { workflow_completeness: 'weak', professor_experience: 'weak', student_experience: 'weak' } as const
    const three = await judged([off, {}, {}])
    const single = await judged([all('excellent')], variant('single'))
    const r = analyseRepeatability([three.result, single.result])
    // A single run always agrees with itself, so counting it would flatter the judge.
    expect(r.artifacts).toBe(1)
    expect(r.runsPerArtifact).toEqual([3])
    expect(r.singleRunVsMedian).toEqual({ exact: 24, withinOne: 27, of: 27 })
    expect(r.medianOf3VsAll).toEqual({ exact: 0, of: 0 })
    expect(r.recommendedPasses).toBe(3)
    expect(r.reason).toMatch(/no artifact had five runs/)
  })

  it('recommends five when even a median of three often disagrees with the full set', async () => {
    const noisy = await judged(
      DIMENSION_KEYS.length
        ? [all('excellent'), all('weak'), all('excellent'), all('weak'), all('acceptable')]
        : [],
    )
    const r = analyseRepeatability([noisy.result])
    expect(r.dimensionAgreement.moreApart).toBe(9)
    expect(r.recommendedPasses).toBe(5)
  })
})

describe('the blind human pack', () => {
  it('holds the request, screenshots and source, and no AI level, score, reasoning or evidence', async () => {
    const items = await Promise.all([judged([all('excellent')]), judged([all('weak')], variant('P2'))])
    for (const { dir } of items) {
      mkdirSync(join(dir, 'evidence'), { recursive: true })
      for (const s of NORMAL_SHOTS) writeFileSync(join(dir, 'evidence', s.file), 'jpg')
    }
    const pack = join(tmp(), 'pack')
    const key = join(pack, '..', 'sealed', 'key.json')
    writeHumanPack(items.map((x, i) => ({ id: `H0${i + 1}`, result: x.result, resultDir: x.dir })), pack, key)

    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]))
    const text = files(pack).filter((f) => !f.endsWith('.jpg')).map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(text).toContain('Build an attendance tracker.')
    expect(existsSync(join(pack, 'H01', 'professor-desktop-normal.jpg'))).toBe(true)
    expect(readFileSync(join(pack, 'H02', 'professor.tsx'), 'utf8')).toBe(variant('P2').professor)
    for (const leak of ['qualityScore', 'suiteContribution', 'passLevels', 'Because.', 'Fine for the professor.', 'test-judge', 'degraded', 'contrast', 'original']) expect(text).not.toContain(leak)
    // The key, which says which artifact each item is, is outside the pack.
    expect(files(pack).some((f) => f.endsWith('key.json'))).toBe(false)
    expect(JSON.parse(readFileSync(key, 'utf8')).items.H01.artifactSha256).toBe(items[0].result.build.artifactSha256)
    expect(humanScoresSchema.parse(JSON.parse(readFileSync(join(pack, 'human-scores.json'), 'utf8')))).toEqual(humanTemplate(['H01', 'H02']))
  })
})

describe('the sealed key', () => {
  it('is refused anywhere inside the pack, before any item is written', async () => {
    const item = await judged([all('acceptable')])
    const pack = join(tmp(), 'pack')
    for (const key of [join(pack, 'key.json'), join(pack, 'H01', 'key.json'), join(pack, 'sealed', 'key.json')]) {
      expect(() => writeHumanPack([{ id: 'H01', result: item.result, resultDir: item.dir }], pack, key)).toThrow(/outside the pack/)
    }
    expect(existsSync(join(pack, 'H01', 'index.html'))).toBe(false)
  })
})

describe('the human score file', () => {
  it('accepts the blank template and a filled one, and refuses a wrong rubric, an unknown id, a made-up level or a missing dimension', () => {
    const blank = humanTemplate(['H01'])
    expect(humanScoresSchema.safeParse(blank).success).toBe(true)
    const filled: HumanScores = { ...blank, scorer: 'kd', scoredAt: '2026-10-08', items: { H01: { dimensions: all('weak'), notes: 'n' } } }
    expect(humanScoresSchema.safeParse(filled).success).toBe(true)
    const withDims = (dimensions: Record<string, unknown>) => ({ ...filled, items: { H01: { dimensions, notes: '' } } })
    const missingOne: Record<string, Level> = all('weak')
    delete missingOne.edge_states
    for (const bad of [
      { ...filled, rubricVersion: 'studio-generation-quality-v0' },
      { ...filled, items: { item1: filled.items.H01 } },
      withDims({ ...all('weak'), edge_states: 'good' }),
      withDims(missingOne),
      withDims({ ...all('weak'), originality: 'weak' }),
      { ...filled, aiLevels: {} },
    ]) expect(humanScoresSchema.safeParse(bad).success).toBe(false)
  })
})

describe('comparing the AI with a person', () => {
  async function setup(aiLevels: Level[]) {
    const items = await Promise.all(aiLevels.map((l, i) => judged([all(l)], variant(i))))
    const key: PackKey = { format: 'studio-quality-pack-key-v1', items: Object.fromEntries(items.map((x, i) => [`H0${i + 1}`, { resultDir: x.dir, artifactSha256: x.result.build.artifactSha256 }])) }
    const results = Object.fromEntries(items.map((x, i) => [`H0${i + 1}`, x.result]))
    return { key, results }
  }
  const filled = (levels: Level[]): HumanScores => ({
    ...humanTemplate(levels.map((_, i) => `H0${i + 1}`)),
    scorer: 'kd',
    scoredAt: '2026-10-08',
    items: Object.fromEntries(levels.map((l, i) => [`H0${i + 1}`, { dimensions: all(l), notes: '' }])),
  })

  it('is awaiting human calibration while any level is blank', async () => {
    const { key, results } = await setup(['excellent', 'weak'])
    const c = compareWithHuman(humanTemplate(['H01', 'H02']), key, results)
    expect(c.status).toBe('AWAITING HUMAN CALIBRATION')
    expect(c.missing).toEqual(['H01', 'H02'])
  })

  it('accepts close agreement, reporting exact agreement separately', async () => {
    const { key, results } = await setup(['excellent', 'weak'])
    const human = filled(['excellent', 'weak'])
    human.items.H02.dimensions.workflow_completeness = 'acceptable'
    const c = compareWithHuman(human, key, results)
    expect(c.status).toBe('ACCEPTED')
    expect(c.exact).toBe(17)
    expect(c.withinOne).toBe(18)
    expect(c.judgements).toBe(18)
    expect(c.artifacts).toEqual([
      { id: 'H01', ai: 100, human: 100, difference: 0 },
      { id: 'H02', ai: 40, human: 46, difference: -6 },
    ])
    expect(c.perDimensionBias.workflow_completeness).toBe(-0.5)
    expect(c.ordering).toEqual({ pairs: 1, preserved: 1 })
  })

  it('rejects a reversed weak/strong order and levels far apart', async () => {
    const { key, results } = await setup(['excellent', 'none'])
    const c = compareWithHuman(filled(['none', 'excellent']), key, results)
    expect(c.status).toBe('NOT ACCEPTED')
    expect(c.checks.find((x) => x.name.startsWith('obvious weak/strong ordering'))!.passed).toBe(false)
    expect(c.checks.find((x) => x.name.startsWith('at least 80%'))!.passed).toBe(false)
  })

  it('rejects a systematic bias of more than one level on a major dimension, even when everything else agrees', async () => {
    // The AI rates the professor's experience two levels above the person on both items.
    const items = await Promise.all([judged([all('excellent')]), judged([{ ...all('weak'), professor_experience: 'excellent' }], variant(1))])
    const key: PackKey = { format: 'studio-quality-pack-key-v1', items: Object.fromEntries(items.map((x, i) => [`H0${i + 1}`, { resultDir: x.dir, artifactSha256: x.result.build.artifactSha256 }])) }
    const results = Object.fromEntries(items.map((x, i) => [`H0${i + 1}`, x.result]))
    const human = filled(['excellent', 'weak'])
    human.items.H01.dimensions.professor_experience = 'weak'
    const c = compareWithHuman(human, key, results)
    expect(c.perDimensionBias.professor_experience).toBe(2)
    expect(c.checks.filter((x) => !x.passed).map((x) => x.name)).toEqual(['no systematic bias over one level on a major dimension'])
    expect(c.status).toBe('NOT ACCEPTED')
  })

  it('refuses a result that is not the artifact the person scored', async () => {
    const { key, results } = await setup(['excellent'])
    key.items.H01.artifactSha256 = 'f'.repeat(64)
    expect(() => compareWithHuman(filled(['excellent']), key, results)).toThrow(/not of the artifact in the pack/)
  })
})

describe('evidence the preview can’t produce', () => {
  const manifest = (professor: string[]) => ({
    manifestVersion: 2,
    id: 'probe-plugin',
    name: 'Probe',
    version: '0.0.0',
    description: 'A probe for the preview.',
    bridgeVersion: 'v2',
    purpose: { category: 'practice', summary: 'Students write short notes so they can review what they practised during the course.', audience: 'students' },
    signals: [],
    skillSlots: [],
    aiFallback: 'not-applicable',
    views: { student: { entry: 'views/student.tsx', capabilities: [] }, professor: { entry: 'views/professor.tsx', capabilities: professor } },
    collections: { notes: { access: 'perStudent', fields: { text: 'text' } } },
  })

  it('names a declared capability the preview answers as unsupported, and only that one', async () => {
    expect(await unpreviewableCapabilities(manifest(['course.skills', 'course.roster', 'context.get']))).toEqual(['professor:course.skills'])
    expect(await unpreviewableCapabilities(manifest(['course.roster', 'course.assignments']))).toEqual([])
  })

  it('a result whose evidence can’t show a declared capability is never comparable', () => {
    const gates: QualityResult['gates'] = { build: 'passed', invariants: { status: 'passed', detail: {} }, draftGate: { status: 'passed', failing: [] }, stage2Boot: 'passed', stage2Isolation: 'passed', visualEvidence: { status: 'passed', missing: [] }, correctness: 'passed', failures: [] }
    const base = { provenance: 'live-build' as const, cappedByEval: false, integrityOk: true, gates, mode: 'visual+code' as const, judgeKind: 'live' as const, judgeSucceeded: true, total: 70 }
    expect(comparability(base).comparable).toBe(true)
    const limited = comparability({ ...base, unpreviewable: ['professor:course.skills'] })
    expect(limited).toMatchObject({ comparable: false, suiteContribution: null, qualityScore: 70 })
    expect(limited.notes.join(' ')).toMatch(/can't serve professor:course.skills/)
  })
})

describe('the holdout stays sealed in calibration', () => {
  it('refuses holdout cases unless the baseline explicitly allows them', () => {
    const holdout = QUALITY_CASES.filter((c) => c.set === 'holdout')
    expect(holdout.map((c) => c.id)).toEqual([
      'Q07-lab-checkoff', 'Q10-extension-requests', 'Q13-equipment-booking', 'Q15-rubric-scoring', 'Q17-student-progress', 'Q20-predict-reveal',
      'D02-branching-stories', 'D05-review-game', 'D06-final-grade-calculator',
    ])
    expect(() => assertNoHoldout([QUALITY_CASES.find((c) => c.id === 'D01-form-builder')!, QUALITY_CASES.find((c) => c.id === 'D05-review-game')!], false)).toThrow(/D05-review-game are sealed/)
    expect(() => assertNoHoldout([QUALITY_CASES[0], holdout[0]], false)).toThrow(/Q07-lab-checkoff are sealed until Step 12A.4/)
    expect(() => assertNoHoldout(QUALITY_CASES.filter((c) => c.set === 'dev'), false)).not.toThrow()
    expect(() => assertNoHoldout(holdout, true)).not.toThrow()
  })
})

describe('the rubric and judge prompt freeze', () => {
  it('the frozen fingerprints match the current rubric and prompt', () => {
    expect(rubricFingerprint()).toBe(QUALITY_FROZEN.rubricSha256)
    expect(judgePromptFingerprint()).toBe(QUALITY_FROZEN.judgePromptSha256)
    expect(qualityFreezeDrift()).toEqual([])
  })

  describe('drift', () => {
    const RUBRIC = '../../eval/studio-quality/rubric'
    const JUDGE = '../../eval/studio-quality/judge'
    async function driftWith(mock: () => void): Promise<string[]> {
      vi.resetModules()
      mock()
      try {
        return (await import('../../eval/studio-quality/quality-freeze')).qualityFreezeDrift()
      } finally {
        vi.doUnmock(RUBRIC)
        vi.doUnmock(JUDGE)
        vi.resetModules()
      }
    }

    it('a level’s wording changed under the same rubric version is drift', async () => {
      const drift = await driftWith(() =>
        vi.doMock(RUBRIC, async (importOriginal) => {
          const real = await importOriginal<typeof import('../../eval/studio-quality/rubric')>()
          return { ...real, DIMENSIONS: real.DIMENSIONS.map((d, i) => (i === 0 ? { ...d, levels: { ...d.levels, weak: `${d.levels.weak} Reworded.` } } : d)) }
        }),
      )
      expect(drift).toContain('the rubric changed without a new version (still studio-generation-quality-v1)')
    })

    it('a new rubric or judge prompt version is drift from the frozen pair', async () => {
      const rubric = await driftWith(() =>
        vi.doMock(RUBRIC, async (importOriginal) => ({ ...(await importOriginal<typeof import('../../eval/studio-quality/rubric')>()), RUBRIC_VERSION: 'studio-generation-quality-v2' })),
      )
      expect(rubric).toContain('rubric version studio-generation-quality-v2, frozen studio-generation-quality-v1')
      const prompt = await driftWith(() =>
        vi.doMock(JUDGE, async (importOriginal) => ({ ...(await importOriginal<typeof import('../../eval/studio-quality/judge')>()), JUDGE_PROMPT_VERSION: 'sgq-judge-v6' })),
      )
      expect(prompt).toEqual(['judge prompt version sgq-judge-v6, frozen sgq-judge-v5'])
    })
  })
})
