/**
 * One artifact in, one validated studio-generation-quality-result-v1 out.
 *
 *   draft gate again (fresh bundles) -> Stage 2 -> screenshots -> gates -> judge -> result
 *
 * The judge runs only when no correctness gate failed. Without the required screenshots
 * it runs only as a diagnostic code-only evaluation, when asked for, and the result is
 * never comparable. Every external step is injectable, so tests run with no browser,
 * worker or model.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDraftChecks } from '../../src/lib/studio/builder/checks'
import { runWorkerCheck } from '../../src/lib/studio/builder/check-worker'
import { canonicalJson } from '../../src/lib/studio/validator/artifact'
import { VENDOR_V2_SHA256, VENDOR_V1_SHA256 } from '../../src/lib/studio/kit/vendor-hash'
import { snapshotHash } from '../../src/lib/studio/builder/snapshot'
import { STUDIO_VALIDATOR_RULESET, VALIDATOR_VERSION } from '../../src/lib/studio/validator/ruleset'
import { captureScreens, evidenceCatalog, runStage2, unpreviewableCapabilities, type Bundled, type CaptureOutcome, type Shot, type Stage2Outcome } from './evidence'
import { comparability, computeGates, failureClassOf, publishable, type GateFacts } from './gates'
import { judgeArtifact, JUDGE_PROMPT_VERSION, type JudgeImage, type JudgeModel, type JudgeRender, type SpendLedger } from './judge'
import { judgeRender, type CrossCheck } from './render'
import { platformCardSha256 } from './platform-card'
import { RUBRIC_VERSION } from './rubric'
import { parseQualityResult, RESULT_SCHEMA, type QualityResult } from './schema'

export interface Artifact {
  provenance: 'live-build' | 'imported-artifact'
  case: QualityResult['case']
  /** For the judge only. Never given to a build. */
  judgeContext: { professorGoal: string | null; studentGoal: string | null; hints: string[] }
  rerun: QualityResult['rerun']
  /** Where the result, the source and the screenshots are written. */
  dir: string
  /** The artifact hash recorded when the build was saved; null for an imported folder. */
  expectedArtifactSha256: string | null
  manifest: Record<string, unknown> | null
  files: { student: string | null; professor: string | null }
  sample: unknown
  git: { commit: string | null; dirty: boolean | null }
  builder: QualityResult['build']['builder']
  build: {
    statuses: string[] | null
    errorCode: string | null
    cappedByEval: boolean | null
    snapshotHash: string | null
    invariants: Record<string, boolean> | null
    costUsd: number | null
    tokens: QualityResult['build']['tokens']
    modelTurns: number | null
    toolCalls: number | null
    repairRounds: number | null
    checkRuns: number | null
    durationMs: number | null
    questionsAsked: number | null
    approvalsGiven: number | null
    builderReview: QualityResult['build']['builderReview']
  }
}

export interface EvaluateDeps {
  draftGate: (artifact: Artifact) => Promise<{ passed: boolean; failing: string[]; bundles: { student: string; professor: string } | null; compiler: string | null } | null>
  stage2: (bundled: Bundled) => Promise<Stage2Outcome | null>
  capture: (bundled: Bundled, outDir: string) => Promise<CaptureOutcome | null>
  readImage: (path: string) => Uint8Array
  judge: JudgeModel | null
  platformCard: string
  judgePasses: number
  /** The spend cap judging runs under; null when the judge costs nothing. */
  ledger: SpendLedger | null
  /** Run a diagnostic code-only judgement when the screenshots are missing. */
  allowCodeOnly: boolean
  now: () => Date
}

export const realEvaluateDeps = (
  judge: JudgeModel | null,
  platformCard: string,
  options: { judgePasses: number; allowCodeOnly: boolean; ledger: SpendLedger | null },
): EvaluateDeps => ({
  draftGate: async (artifact) => {
    if (!artifact.manifest) return { passed: false, failing: ['builder.manifest'], bundles: null, compiler: null }
    try {
      const files: Record<string, string> = {}
      if (artifact.files.student !== null) files['views/student.tsx'] = artifact.files.student
      if (artifact.files.professor !== null) files['views/professor.tsx'] = artifact.files.professor
      const r = await runDraftChecks({ manifest: artifact.manifest as never, files, sample: (artifact.sample ?? null) as never }, { workerCheck: runWorkerCheck, rosterFullNames: ['Maria Lopez'], published: null, disclosureSources: [] })
      const failing = [...new Set(r.findings.filter((f) => f.required).map((f) => f.check_id))]
      return { passed: r.passed, failing, bundles: r.bundles, compiler: r.compiler }
    } catch {
      return null
    }
  },
  stage2: runStage2,
  capture: (bundled, outDir) => captureScreens(bundled, outDir),
  readImage: (path) => readFileSync(path),
  judge,
  platformCard,
  judgePasses: options.judgePasses,
  ledger: options.ledger,
  allowCodeOnly: options.allowCodeOnly,
  now: () => new Date(),
})

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** The hash of what was generated: the manifest, both views and the sample data. */
export const artifactHash = (manifest: unknown, files: { student: string | null; professor: string | null }, sample: unknown) =>
  sha256(canonicalJson({ manifest, files: { student: files.student ?? '', professor: files.professor ?? '' }, sample: sample ?? null }))

function signature(manifest: Record<string, unknown> | null): QualityResult['build']['signature'] {
  const views = (manifest?.views ?? {}) as Record<string, { capabilities?: string[] }>
  const collections = (manifest?.collections ?? {}) as Record<string, { access?: string }>
  return {
    studentCapabilities: [...(views.student?.capabilities ?? [])].sort(),
    professorCapabilities: [...(views.professor?.capabilities ?? [])].sort(),
    accessModes: Object.values(collections).map((c) => String(c.access)).sort(),
  }
}

export async function evaluateArtifact(artifact: Artifact, deps: EvaluateDeps): Promise<QualityResult> {
  mkdirSync(artifact.dir, { recursive: true })
  // The exact source this result judges, kept beside it.
  const sourceDir = join(artifact.dir, 'source')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'manifest.json'), `${JSON.stringify(artifact.manifest, null, 2)}
`)
  writeFileSync(join(sourceDir, 'professor.tsx'), artifact.files.professor ?? '')
  writeFileSync(join(sourceDir, 'student.tsx'), artifact.files.student ?? '')
  writeFileSync(join(sourceDir, 'sample.json'), `${JSON.stringify(artifact.sample ?? null, null, 2)}
`)
  const evidenceDir = join(artifact.dir, 'evidence')
  const bridgeVersion = typeof artifact.manifest?.bridgeVersion === 'string' ? artifact.manifest.bridgeVersion : null

  // A missing view or manifest can't pass the gate; it is recorded, not repaired.
  const viewsPresent = artifact.files.student !== null && artifact.files.professor !== null
  const gate = viewsPresent ? await deps.draftGate(artifact) : { passed: false, failing: ['builder.files'], bundles: null, compiler: null }
  const bundled: Bundled | null = gate?.bundles && artifact.manifest ? { manifest: artifact.manifest, bundles: gate.bundles, sample: artifact.sample } : null
  const stage2 = bundled ? await deps.stage2(bundled) : null

  const facts: GateFacts = {
    provenance: artifact.provenance,
    buildStatuses: artifact.build.statuses,
    cappedByEval: artifact.build.cappedByEval,
    invariants: artifact.build.invariants,
    draftGate: gate ? { passed: gate.passed, failing: gate.failing } : null,
    stage2: stage2?.checks ?? null,
    capture: null,
  }
  // Screenshots only for something that passed every correctness gate it could be checked against.
  let capture: CaptureOutcome | null = null
  if (bundled && computeGates(facts).correctness !== 'failed') {
    capture = await deps.capture(bundled, evidenceDir)
    facts.capture = capture ? { missing: capture.missing } : { missing: ['capture failed'] }
  }
  const gates = computeGates(facts)

  // Every piece of evidence must be of this artifact: the source as saved, the snapshot it
  // claims to be, the Stage 2 report of this payload, the screenshots of these bundles.
  const files0 = { student: artifact.files.student ?? '', professor: artifact.files.professor ?? '' }
  const artifactSha256 = artifactHash(artifact.manifest, artifact.files, artifact.sample)
  const integrityChecks = {
    expectedArtifactSha256: artifact.expectedArtifactSha256,
    artifactMatches: artifact.expectedArtifactSha256 === null ? null : artifact.expectedArtifactSha256 === artifactSha256,
    snapshotHashMatches:
      artifact.build.snapshotHash && gate?.compiler && artifact.manifest && viewsPresent
        ? snapshotHash(gate.compiler, artifact.manifest, { 'views/student.tsx': files0.student, 'views/professor.tsx': files0.professor }, artifact.sample ?? undefined) === artifact.build.snapshotHash
        : null,
    bundleSha256: bundled ? sha256(canonicalJson({ manifest: bundled.manifest, bundles: bundled.bundles, sample: bundled.sample ?? null })) : null,
    stage2Bound: stage2 ? stage2.bound : null,
    captureBound: capture ? capture.bound : null,
  }
  const integrity = { ...integrityChecks, ok: Object.values(integrityChecks).every((v) => v !== false) }

  const shots: Shot[] = capture?.shots ?? []
  const files = { student: artifact.files.student ?? '', professor: artifact.files.professor ?? '' }
  const mode: QualityResult['evaluation']['mode'] =
    gates.correctness === 'failed' || !deps.judge || !viewsPresent || !integrity.ok
      ? 'none'
      : gates.visualEvidence.status === 'passed'
        ? 'visual+code'
        : deps.allowCodeOnly
          ? 'code-only'
          : 'none'

  // The evidence the judge may cite and the result records: no screenshot unless it was judged on them.
  const evidence = evidenceCatalog({ files, sample: artifact.sample, shots: mode === 'visual+code' ? shots : [], stage2: stage2?.checks ?? null })
  // What the screens actually show, and where the source claims more: judged with the screenshots.
  let cross: CrossCheck | null = null
  let render: JudgeRender | null = null
  if (mode === 'visual+code' && capture?.render) {
    const built = judgeRender(capture.render, files)
    cross = built.cross
    render = built.render
    const indexed = built.indexed
    evidence.push(
      ...indexed.map((x) => ({ id: x.id, kind: 'render' as const, label: `${x.key}: ${x.item.kind}`, file: 'render.json', lines: null })),
      ...cross.checks.map((c) => ({ id: c.id, kind: 'check' as const, label: c.detail.slice(0, 300), file: null, lines: null })),
    )
  }
  const images: JudgeImage[] =
    mode === 'visual+code' ? shots.map((s) => ({ id: `shot:${s.id}`, label: s.id, mediaType: 'image/jpeg' as const, bytes: deps.readImage(join(evidenceDir, s.file)) })) : []
  const outcome =
    mode === 'none' || !deps.judge
      ? null
      : await judgeArtifact(
          deps.judge,
          {
            mode,
            request: artifact.case.prompt,
            professorGoal: artifact.judgeContext.professorGoal,
            studentGoal: artifact.judgeContext.studentGoal,
            hints: artifact.judgeContext.hints,
            platformCard: deps.platformCard,
            manifest: artifact.manifest,
            files,
            sample: artifact.sample,
            stage2: stage2?.checks ?? null,
            evidence,
            images,
            render,
          },
          { passes: deps.judgePasses, ledger: deps.ledger ?? undefined },
        )
  const judgeSucceeded = !!outcome?.dimensions
  const unpreviewable = artifact.manifest ? await unpreviewableCapabilities(artifact.manifest) : []
  const verdict = comparability({
    unpreviewable,
    provenance: artifact.provenance,
    cappedByEval: artifact.build.cappedByEval,
    integrityOk: integrity.ok,
    gates,
    mode,
    judgeKind: deps.judge?.identity.kind ?? null,
    judgeSucceeded,
    total: outcome?.total ?? null,
  })

  const kitVendorSha256 = bridgeVersion === 'v2' ? VENDOR_V2_SHA256 : bridgeVersion === 'v1' ? VENDOR_V1_SHA256 : null
  const raw: QualityResult = {
    schema: RESULT_SCHEMA,
    rubricVersion: RUBRIC_VERSION,
    judgePromptVersion: outcome ? JUDGE_PROMPT_VERSION : null,
    createdAt: deps.now().toISOString(),
    provenance: artifact.provenance,
    case: artifact.case,
    rerun: artifact.rerun,
    build: {
      commit: artifact.git.commit,
      dirty: artifact.git.dirty,
      builder: artifact.builder,
      platform: {
        bridgeVersion,
        kitVendorSha256,
        compilerId: gate?.compiler ?? null,
        validatorVersion: VALIDATOR_VERSION,
        validatorRuleset: STUDIO_VALIDATOR_RULESET,
        runner: stage2?.runner ?? null,
        platformCardSha256: platformCardSha256(deps.platformCard),
      },
      status: artifact.build.statuses?.at(-1) ?? null,
      errorCode: artifact.build.errorCode,
      snapshotHash: artifact.build.snapshotHash,
      artifactSha256,
      signature: signature(artifact.manifest),
      costUsd: artifact.build.costUsd,
      tokens: artifact.build.tokens,
      modelTurns: artifact.build.modelTurns,
      toolCalls: artifact.build.toolCalls,
      repairRounds: artifact.build.repairRounds,
      checkRuns: artifact.build.checkRuns,
      durationMs: artifact.build.durationMs,
      questionsAsked: artifact.build.questionsAsked,
      approvalsGiven: artifact.build.approvalsGiven,
      builderReview: artifact.build.builderReview,
    },
    integrity,
    gates,
    stage2: {
      ran: stage2 !== null,
      checks: (stage2?.checks ?? []).map((c) => ({ checkId: c.checkId, status: c.status, views: c.views, findings: c.findings })),
      publishable: publishable(stage2?.checks ?? null),
    },
    evaluation: {
      mode,
      judge: outcome ? deps.judge!.identity : null,
      passesRequested: outcome?.passesRequested ?? 0,
      passesSucceeded: outcome?.passes.length ?? 0,
      attempts: outcome?.attempts ?? [],
      evidence,
      extracted: outcome?.extracted ?? null,
      dimensions: outcome?.dimensions ?? null,
      professorAssessment: outcome?.professorAssessment ?? null,
      studentAssessment: outcome?.studentAssessment ?? null,
      passTotals: outcome?.passes.map((p) => p.total) ?? [],
      unpreviewable,
      render: cross
        ? {
            items: render!.items.length,
            screens: capture!.render!.shots.length,
            checks: cross.checks.map(({ id, view, kind, detail }) => ({ id, view, kind, detail })),
            notSeen: cross.notSeen.length,
          }
        : null,
      costUsd: outcome?.costUsd ?? null,
    },
    qualityScore: verdict.qualityScore,
    comparable: verdict.comparable,
    comparabilityNotes: verdict.notes,
    suiteContribution: verdict.suiteContribution,
    failureClass: failureClassOf(facts, gates, { ran: outcome !== null, succeeded: judgeSucceeded }, integrity.ok),
    artifactsDir: artifact.dir,
  }
  const parsed = parseQualityResult(raw)
  if (!parsed.ok) throw new Error(`The result for ${artifact.case.id} doesn't match ${RESULT_SCHEMA}: ${parsed.issues.slice(0, 5).join('; ')}`)
  writeFileSync(join(artifact.dir, 'result.json'), `${JSON.stringify(parsed.result, null, 2)}\n`)
  return parsed.result
}
