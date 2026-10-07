/**
 * Artifact folders: what a generation produced, saved so it can be judged again later
 * without building. Two kinds are read:
 *
 *   studio-quality-artifact-v1   written by this framework after a live build (artifact.json)
 *   Step 11 product benchmark    tmp/product-bench*\/<case>/ from eval/studio-builder/product.ts
 *
 * An imported benchmark folder keeps only what it really recorded. It has no token counts,
 * instruction hash, invariants or commit, so those are null, and it is never comparable.
 * It is not the Step 12A baseline; it exists to test the plumbing.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { artifactHash, type Artifact } from './evaluate'
import type { BuildOutcome } from './build'
import type { QualityCase } from './cases'
import type { QualityResult } from './schema'

export const ARTIFACT_FORMAT = 'studio-quality-artifact-v1'

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null)

export function judgeContextOf(c: QualityCase): Artifact['judgeContext'] {
  if (c.sealed && c.hints.length === 0) throw new Error(`${c.id}: its judge guidance is sealed. Only the Step 12A.4 baseline loads it (--allow-holdout).`)
  return { professorGoal: c.professorGoal, studentGoal: c.studentGoal, hints: [...c.hints] }
}

export const caseMeta = (c: QualityCase): QualityResult['case'] => ({ id: c.id, prompt: c.prompt, category: c.category, tier: c.tier, set: c.set, variance: c.variance, inPattern: c.inPattern })

/** Saves a live build as an artifact folder, and returns it ready to evaluate. */
export function saveLiveArtifact(input: {
  dir: string
  case: QualityCase
  rerun: QualityResult['rerun']
  outcome: BuildOutcome
  git: Artifact['git']
  builder: Artifact['builder']
}): Artifact {
  const { dir, outcome } = input
  // Before anything is written: a sealed case without its guidance stops here.
  const judgeContext = judgeContextOf(input.case)
  mkdirSync(dir, { recursive: true })
  const snap = outcome.snapshot
  if (snap) {
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(snap.manifest, null, 2)}\n`)
    writeFileSync(join(dir, 'professor.tsx'), snap.files.professor)
    writeFileSync(join(dir, 'student.tsx'), snap.files.student)
    writeFileSync(join(dir, 'sample.json'), `${JSON.stringify(snap.sample ?? null, null, 2)}\n`)
  }
  const build: Artifact['build'] = {
    statuses: [outcome.status],
    errorCode: outcome.errorCode,
    cappedByEval: outcome.cappedByEval,
    snapshotHash: snap?.hash ?? null,
    invariants: outcome.invariants,
    costUsd: outcome.costUsd,
    tokens: outcome.tokens,
    modelTurns: outcome.modelTurns,
    toolCalls: outcome.toolCalls,
    repairRounds: outcome.repairRounds,
    checkRuns: outcome.checkRuns,
    durationMs: outcome.durationMs,
    questionsAsked: outcome.questionsAsked,
    approvalsGiven: outcome.approvalsGiven,
    builderReview: outcome.builderReview,
  }
  const files = { student: snap?.files.student ?? null, professor: snap?.files.professor ?? null }
  const artifactSha256 = artifactHash(snap?.manifest ?? null, files, snap?.sample ?? null)
  writeFileSync(
    join(dir, 'artifact.json'),
    `${JSON.stringify({ format: ARTIFACT_FORMAT, provenance: 'live-build', caseId: input.case.id, rerun: input.rerun, artifactSha256, git: input.git, builder: input.builder, build, refusals: outcome.refusals }, null, 2)}\n`,
  )
  return {
    provenance: 'live-build',
    case: caseMeta(input.case),
    judgeContext,
    rerun: input.rerun,
    dir,
    expectedArtifactSha256: artifactSha256,
    manifest: snap?.manifest ?? null,
    files: { student: snap?.files.student ?? null, professor: snap?.files.professor ?? null },
    sample: snap?.sample ?? null,
    git: input.git,
    builder: input.builder,
    build,
  }
}

const savedArtifact = z.object({
  format: z.literal(ARTIFACT_FORMAT),
  provenance: z.literal('live-build'),
  caseId: z.string(),
  rerun: z.object({ groupId: z.string(), generation: z.number().int().min(1) }),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
  git: z.object({ commit: z.string().nullable(), dirty: z.boolean().nullable() }),
  builder: z.record(z.string(), z.unknown()),
  build: z.record(z.string(), z.unknown()),
  refusals: z.array(z.string()).optional(),
})

const productResult = z.object({
  id: z.string(),
  costUsd: z.number().nullable().optional(),
  seconds: z.number().nullable().optional(),
  builds: z
    .array(
      z.object({
        request: z.string(),
        status: z.string(),
        errorCode: z.string().nullable().optional(),
        modelTurns: z.number().optional(),
        repairRounds: z.number().optional(),
        review: z.object({ rounds: z.number(), rendered: z.boolean(), verdict: z.string().nullable() }).nullable().optional(),
      }),
    )
    .min(1),
})

const UNKNOWN_BUILDER: QualityResult['build']['builder'] = {
  model: null,
  thinkingLevel: null,
  maxOutputTokens: null,
  instructionsVersion: null,
  instructionsSha256: null,
  reviewVersion: null,
  reviewSha256: null,
  rendererMode: null,
}

/**
 * Reads one artifact folder for evaluation into `outDir`. `cases` resolves a saved live
 * artifact's case, whose goals and hints come from the current case list, never the folder.
 */
export function loadArtifact(dir: string, outDir: string, cases: readonly QualityCase[]): Artifact {
  const manifestRaw = existsSync(join(dir, 'manifest.json')) ? (readJson(join(dir, 'manifest.json')) as Record<string, unknown> | null) : null
  const files = { student: readText(join(dir, 'student.tsx')), professor: readText(join(dir, 'professor.tsx')) }
  const sample = existsSync(join(dir, 'sample.json')) ? readJson(join(dir, 'sample.json')) : null

  if (existsSync(join(dir, 'artifact.json'))) {
    const saved = savedArtifact.parse(readJson(join(dir, 'artifact.json')))
    const c = cases.find((x) => x.id === saved.caseId)
    if (!c) throw new Error(`${dir}: case ${saved.caseId} is not in the canonical suite.`)
    return {
      provenance: 'live-build',
      case: caseMeta(c),
      judgeContext: judgeContextOf(c),
      rerun: saved.rerun,
      dir: outDir,
      expectedArtifactSha256: saved.artifactSha256,
      manifest: manifestRaw,
      files,
      sample,
      git: saved.git,
      builder: saved.builder as QualityResult['build']['builder'],
      build: saved.build as Artifact['build'],
    }
  }

  if (existsSync(join(dir, 'result.json'))) {
    const r = productResult.parse(readJson(join(dir, 'result.json')))
    const [first, ...followUps] = r.builds
    const sum = (key: 'modelTurns' | 'repairRounds') => (r.builds.every((b) => typeof b[key] === 'number') ? r.builds.reduce((n, b) => n + (b[key] ?? 0), 0) : null)
    const reviewed = r.builds.find((b) => b.review)?.review ?? null
    return {
      provenance: 'imported-artifact',
      case: {
        id: `import:${r.id}`,
        prompt: [first.request, ...followUps.map((b) => `Then: ${b.request}`)].join('\n\n'),
        category: 'imported',
        tier: null,
        set: 'imported',
        variance: false,
        inPattern: null,
      },
      judgeContext: { professorGoal: null, studentGoal: null, hints: [] },
      rerun: { groupId: `import:${basename(dir)}`, generation: 1 },
      dir: outDir,
      expectedArtifactSha256: null,
      manifest: manifestRaw,
      files,
      sample,
      git: { commit: null, dirty: null },
      builder: UNKNOWN_BUILDER,
      build: {
        statuses: r.builds.map((b) => b.status),
        errorCode: r.builds.at(-1)!.errorCode ?? null,
        cappedByEval: null,
        snapshotHash: null,
        invariants: null,
        costUsd: typeof r.costUsd === 'number' ? r.costUsd : null,
        tokens: null,
        modelTurns: sum('modelTurns'),
        toolCalls: null,
        repairRounds: sum('repairRounds'),
        checkRuns: null,
        durationMs: typeof r.seconds === 'number' ? Math.round(r.seconds * 1000) : null,
        questionsAsked: null,
        approvalsGiven: null,
        builderReview: reviewed,
      },
    }
  }
  throw new Error(`${dir}: neither a quality artifact (artifact.json) nor a Step 11 benchmark folder (result.json).`)
}

/** Every artifact folder under `root`, at any depth. A folder that is an artifact isn't searched further. */
export function artifactDirs(root: string): string[] {
  if (existsSync(join(root, 'artifact.json')) || existsSync(join(root, 'result.json'))) return [root]
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => artifactDirs(join(root, e.name)))
    .sort()
}
