/**
 * studio-generation-quality-result-v1: one evaluated generation. Strict: a result with a
 * missing, extra or mistyped field is refused, so a baseline never holds a half-made row.
 *
 * Metadata an artifact doesn't have (an imported Step 11 benchmark folder has no token
 * counts or instruction hash) is null, never guessed.
 */
import { z } from 'zod'
import { DIMENSION_KEYS, LEVELS, RUBRIC_VERSION } from './rubric'

export const RESULT_SCHEMA = 'studio-generation-quality-result-v1'

const level = z.enum(LEVELS)
const count = z.number().int().min(0)
const nullableCount = count.nullable()
const usd = z.number().min(0)

export const gateStatus = z.enum(['passed', 'failed', 'unknown'])
export type GateStatus = z.infer<typeof gateStatus>

export const judgeIdentitySchema = z.strictObject({
  /** scripted: tests and plumbing only, never a real judgement. live: a model. */
  kind: z.enum(['scripted', 'live']),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** The reasoning or thinking setting the model ran with, or null where it has none. */
  reasoning: z.string().nullable(),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  promptVersion: z.string().min(1),
})
export type JudgeIdentity = z.infer<typeof judgeIdentitySchema>

/** Something the judge may cite: a screenshot, a view's source, the manifest, the sample data or a Stage 2 check. */
export const evidenceSourceSchema = z.strictObject({
  id: z.string().regex(/^(shot:[a-z0-9-]+|views\/(student|professor)\.tsx|manifest|sample|stage2:[a-z_.]+)$/),
  kind: z.enum(['screenshot', 'source', 'manifest', 'sample', 'stage2']),
  label: z.string(),
  /** Screenshots: the file under the artifact's evidence folder. */
  file: z.string().nullable(),
  /** Source files: how many lines can be cited. */
  lines: count.nullable(),
})
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>

export const extractedItemSchema = z.strictObject({
  id: z.string().regex(/^e[0-9]{1,3}$/),
  role: z.enum(['professor', 'student', 'both']),
  kind: z.enum(['action', 'write', 'data', 'state', 'layout', 'absence']),
  text: z.string().min(1).max(400),
  /** Evidence source ids, or a source line such as views/professor.tsx:42. */
  sources: z.array(z.string()).min(1).max(8),
})
export type ExtractedItem = z.infer<typeof extractedItemSchema>

export const extractionSchema = z.strictObject({
  items: z.array(extractedItemSchema).min(1).max(120),
  core: z.strictObject({
    professor: z.strictObject({ present: z.boolean(), evidence: z.array(z.string()).max(8) }),
    student: z.strictObject({ present: z.boolean(), evidence: z.array(z.string()).max(8) }),
  }),
})
export type Extraction = z.infer<typeof extractionSchema>

const dimensionResult = z.strictObject({
  maxPoints: z.number().positive(),
  /** False only for visual quality in a code-only evaluation: it can't be judged from source. */
  assessed: z.boolean(),
  level: level.nullable(),
  points: z.number().min(0).nullable(),
  /** Each judge run's level, in run order. */
  passLevels: z.array(level.nullable()),
  /** How many levels apart the judge runs were. */
  spread: count,
  evidence: z.array(z.string()),
  reasoning: z.string(),
})

const judgeAttempt = z.strictObject({
  pass: z.number().int().min(1),
  stage: z.enum(['extract', 'score']),
  attempt: z.number().int().min(1),
  ok: z.boolean(),
  error: z.string().nullable(),
})

export const failureClass = z.enum([
  'none',
  'build_failed',
  'build_blocked',
  'budget_exhausted',
  'invariant_violation',
  'draft_gate_failed',
  'stage2_failed',
  'capture_failed',
  'judge_failed',
  'capped_by_eval',
  'metadata_incomplete',
])
export type FailureClass = z.infer<typeof failureClass>

export const qualityResultSchema = z.strictObject({
  schema: z.literal(RESULT_SCHEMA),
  rubricVersion: z.literal(RUBRIC_VERSION),
  judgePromptVersion: z.string().nullable(),
  createdAt: z.string(),
  provenance: z.enum(['live-build', 'imported-artifact']),
  case: z.strictObject({
    id: z.string().min(1),
    prompt: z.string().min(1),
    category: z.string(),
    set: z.enum(['dev', 'holdout', 'imported']),
    variance: z.boolean(),
    inPattern: z.boolean().nullable(),
  }),
  rerun: z.strictObject({
    groupId: z.string().min(1),
    /** Which generation of this case in the group, from 1. */
    generation: z.number().int().min(1),
  }),
  build: z.strictObject({
    commit: z.string().nullable(),
    dirty: z.boolean().nullable(),
    builder: z.strictObject({
      model: z.string().nullable(),
      thinkingLevel: z.string().nullable(),
      maxOutputTokens: nullableCount,
      instructionsVersion: z.string().nullable(),
      instructionsSha256: z.string().nullable(),
      reviewVersion: z.string().nullable(),
      reviewSha256: z.string().nullable(),
      rendererMode: z.enum(['local', 'off']).nullable(),
    }),
    platform: z.strictObject({
      bridgeVersion: z.string().nullable(),
      kitVendorSha256: z.string().nullable(),
      compilerId: z.string().nullable(),
      validatorVersion: z.string(),
      validatorRuleset: z.number().int(),
      runner: z.strictObject({ name: z.string(), version: z.string() }).nullable(),
      platformCardSha256: z.string(),
    }),
    status: z.string().nullable(),
    errorCode: z.string().nullable(),
    snapshotHash: z.string().nullable(),
    /** SHA-256 of the manifest, both views and the sample data, as evaluated. */
    artifactSha256: z.string(),
    signature: z.strictObject({
      studentCapabilities: z.array(z.string()),
      professorCapabilities: z.array(z.string()),
      accessModes: z.array(z.string()),
    }),
    costUsd: usd.nullable(),
    tokens: z.strictObject({ input: count, cachedInput: count, output: count, reasoning: count }).nullable(),
    modelTurns: nullableCount,
    toolCalls: nullableCount,
    repairRounds: nullableCount,
    checkRuns: nullableCount,
    durationMs: nullableCount,
    questionsAsked: nullableCount,
    approvalsGiven: nullableCount,
    builderReview: z.strictObject({ rounds: count, rendered: z.boolean(), verdict: z.string().nullable() }).nullable(),
  }),
  gates: z.strictObject({
    build: gateStatus,
    invariants: z.strictObject({ status: gateStatus, detail: z.record(z.string(), z.boolean()).nullable() }),
    draftGate: z.strictObject({ status: gateStatus, failing: z.array(z.string()) }),
    stage2Boot: gateStatus,
    stage2Isolation: gateStatus,
    visualEvidence: z.strictObject({ status: gateStatus, missing: z.array(z.string()) }),
    /** Gates 1 to 5 all passed: build, invariants, draft gate, Stage 2 boot and isolation. */
    correctness: gateStatus,
    failures: z.array(z.string()),
  }),
  stage2: z.strictObject({
    ran: z.boolean(),
    checks: z.array(
      z.strictObject({
        checkId: z.string(),
        status: z.string(),
        views: z.record(z.string(), z.string()),
        findings: z.array(z.strictObject({ view: z.string(), detail: z.string() })),
      }),
    ),
    /** Every required Stage 2 check passed in both views. */
    publishable: z.boolean().nullable(),
  }),
  evaluation: z.strictObject({
    mode: z.enum(['visual+code', 'code-only', 'none']),
    judge: judgeIdentitySchema.nullable(),
    passesRequested: count,
    passesSucceeded: count,
    attempts: z.array(judgeAttempt),
    evidence: z.array(evidenceSourceSchema),
    extracted: extractionSchema.nullable(),
    dimensions: z.record(z.enum(DIMENSION_KEYS), dimensionResult).nullable(),
    professorAssessment: z.string().nullable(),
    studentAssessment: z.string().nullable(),
    /** Each successful judge run's total, for judge variance. */
    passTotals: z.array(z.number().min(0).max(100).nullable()),
    costUsd: usd.nullable(),
  }),
  qualityScore: z.number().min(0).max(100).nullable(),
  /** In the primary quality statistics: a live build, every gate passed, visual and code
   * evidence, and a live judge. */
  comparable: z.boolean(),
  comparabilityNotes: z.array(z.string()),
  /** What the case adds to the suite mean: the score, 0 after a correctness gate failed,
   * or null when it isn't part of the suite (not comparable for another reason). */
  suiteContribution: z.number().min(0).max(100).nullable(),
  failureClass,
  artifactsDir: z.string(),
})
export type QualityResult = z.infer<typeof qualityResultSchema>

export function parseQualityResult(raw: unknown): { ok: true; result: QualityResult } | { ok: false; issues: string[] } {
  const parsed = qualityResultSchema.safeParse(raw)
  if (parsed.success) return { ok: true, result: parsed.data }
  return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) }
}
