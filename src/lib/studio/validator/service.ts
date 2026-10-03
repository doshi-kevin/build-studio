/**
 * The pre-publish validator's trusted service: start runs, record results, read the
 * verdict. docs/reference/studio-plugin-validator.md.
 *
 *   Stage 1 (static) runs automatically after a version is published, and again when the
 *   ruleset changes. It never executes plugin code.
 *   Stage 2 (runtime) runs when the section's professor asks (or after install and
 *   activation, or revalidation), after Stage 1 passed, through a runner
 *   (runtime-runner.ts, cloud-runner.ts), inside per-institution and global caps. Its
 *   result is bound to the run, the exact payload and a single-use nonce.
 *   Reviews: only a Scholera super admin resolves a `needs_review` check, never the
 *   professor who built the tool.
 *
 * A verdict is reused for an identical artifact, stage and ruleset: browser and AI work
 * isn't repeated for content that can't have changed.
 *
 * Plain server module, not 'use server'. Callers are actions, routes and jobs.
 */
import 'server-only'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { logger } from '@/lib/logger'
import { sendStudioReviewWaiting } from '@/lib/email'
import { enqueueJob } from '@/lib/jobs/enqueue'
import { logEvent } from '@/lib/supabase/event-logger'
import { STUDIO_PAUSED, studioAccess } from '../access'
import { requireProfessor } from '../context'
import * as db from '../db'
import {
  STUDIO_BUNDLE_MAX_BYTES,
  STUDIO_SOURCE_MAX_BYTES,
  STUDIO_SOURCE_MAX_FILES,
  STUDIO_PURPOSE_DAILY_PER_INSTITUTION,
  STUDIO_REVALIDATE_PAGE,
  STUDIO_REVIEW_QUEUE_LISTED,
  STUDIO_VALIDATOR_CALLBACK_TTL_MS,
  STUDIO_VALIDATOR_CHECK_METADATA_MAX_BYTES,
  STUDIO_VALIDATOR_RETRY_COOLDOWN_MS,
  STUDIO_VALIDATOR_STAGE2_GLOBAL_CONCURRENT,
  STUDIO_VALIDATOR_STAGE2_INSTITUTION_CONCURRENT,
  STUDIO_VALIDATOR_STAGE2_INSTITUTION_DAILY,
  STUDIO_VALIDATOR_STAGE2_SYSTEM_CONCURRENT,
  STUDIO_VALIDATOR_STATIC_TIMEOUT_MS,
} from '../limits'
import { artifactHash, type PluginArtifact } from './artifact'
import { PURPOSE_RUBRIC_VERSION, type PurposeClassifier, type PurposeClassifierResult } from './purpose'
import { createPurposeClassifier } from './purpose-ai'
import {
  checkDefinition,
  checksFor,
  requiredCheckIds,
  STUDIO_VALIDATOR_RULESET,
  VALIDATOR_RUNTIME_VERSION,
  VALIDATOR_VERSION,
  type StaticCheckId,
} from './ruleset'
import { runtimeEnvelopeSchema, summarizeRuntimeReport } from './runtime-report'
import { buildPayload, runLocally, runnerMode } from './runtime-runner'
import { runStaticChecks, type CheckOutcome } from './static-checks'
import { stageStatus, versionVerdict, type VersionVerdict } from './verdict'

type Trigger = 'publish' | 'professor' | 'ruleset_change' | 'retry' | 'test'

/** The background job that dispatches one cloud Stage 2 run. */
export const STUDIO_VALIDATOR_RUNTIME_JOB = 'studio_validator_runtime'
/** The background job that re-checks one institution's tools after the minimum is raised. */
export const STUDIO_VALIDATOR_REVALIDATE_JOB = 'studio_validator_revalidate'
/** Its dedup key: one revalidation job per institution is active at a time. */
export const REVALIDATE_SUBJECT = 'revalidate'

/**
 * The purpose classifier with the institution's daily cap: over it, the classifier is not
 * called and the purpose check goes to review (never a pass). With `reuseFor`, an earlier
 * answer for the same version under the same rubric is reused instead: a version never
 * changes, so its manifest's purpose can't have either.
 */
function quotaClassifier(institutionId: string, userId: string | null, reuseFor: string | null, admitted: boolean): PurposeClassifier {
  return async (input): Promise<PurposeClassifierResult> => {
    if (reuseFor) {
      const prior = await db.loadLatestPurposeOutcome(reuseFor, PURPOSE_RUBRIC_VERSION)
      const m = prior?.metadata as { verdict?: unknown; confidence?: unknown; category?: unknown } | null | undefined
      if (m && (m.verdict === 'educational' || m.verdict === 'not_educational') && typeof m.confidence === 'number' && typeof m.category === 'string') {
        return { ok: true, result: { verdict: m.verdict, confidence: m.confidence, category: m.category, reasons: [] } as never, model: prior!.aiModel ?? 'reused' }
      }
    }
    if (!admitted && (await db.purposeAdmit(institutionId, STUDIO_PURPOSE_DAILY_PER_INSTITUTION)) !== true) return { ok: false, reason: 'unavailable' }
    return createPurposeClassifier({ institutionId, userId })(input)
  }
}

export type StaticRunResult =
  | { ok: true; validationId: string | null; status: 'passed' | 'failed' | 'needs_review' | 'error' | 'running'; reused: boolean }
  | { ok: false; reason: 'not_found' | 'write_failed' }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Check metadata within the stored byte budget. Quotes are clamped by characters, so
 * twenty of them in a multi-byte script could otherwise exceed it and fail the write. */
export function boundedMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const fits = (m: unknown) => Buffer.byteLength(JSON.stringify(m)) <= STUDIO_VALIDATOR_CHECK_METADATA_MAX_BYTES
  if (fits(metadata)) return metadata
  const findings = Array.isArray(metadata.findings) ? [...metadata.findings] : null
  if (findings) {
    while (findings.length > 0 && !fits({ ...metadata, findings, truncated: true })) findings.pop()
    const trimmed = { ...metadata, findings, truncated: true }
    if (fits(trimmed)) return trimmed
  }
  return { truncated: true }
}

function rowsFor(stage: 'static', outcomes: Record<StaticCheckId, CheckOutcome>): db.ValidationCheckRow[] {
  return checksFor(stage).map((def) => {
    const o = outcomes[def.id as StaticCheckId]
    return {
      checkId: def.id,
      ruleRefs: def.rules,
      stage,
      status: o.status,
      severity: def.severity,
      message: o.message.slice(0, 500),
      metadata: boundedMetadata(o.metadata ?? {}),
    }
  })
}


/** A run still open after the callback TTL was abandoned (a crashed process, a runner
 * that never reported). It ends as `error`, so it neither blocks a new run through the
 * one-active-run index nor reads as "checking" forever. */
async function expireAbandoned(runs: db.ValidationRunRow[]): Promise<db.ValidationRunRow[]> {
  const now = Date.now()
  return Promise.all(
    runs.map(async (r) => {
      if ((r.status !== 'pending' && r.status !== 'running') || now - new Date(r.createdAt).getTime() <= STUDIO_VALIDATOR_CALLBACK_TTL_MS) return r
      await db.finishValidation(r.id, { status: 'error', error: { code: 'abandoned', message: 'The checks stopped without a result.' } })
      return { ...r, status: 'error' as const }
    }),
  )
}

/** Whether a run of this stage for this artifact ended in error within the cooldown. */
async function coolingDown(versionId: string, stage: 'static' | 'runtime', hash: string): Promise<boolean> {
  const runs = (await db.listValidations(versionId)) ?? []
  const since = Date.now() - STUDIO_VALIDATOR_RETRY_COOLDOWN_MS
  return runs.some((r) => r.stage === stage && r.artifactSha256 === hash && r.status === 'error' && new Date(r.createdAt).getTime() > since)
}

/** An existing run for the same version, stage, ruleset and artifact, other than an
 * error: its verdict stands (or is still coming), so nothing is spent again. */
async function reusable(versionId: string, stage: 'static' | 'runtime', hash: string) {
  const runs = await expireAbandoned((await db.listValidations(versionId)) ?? [])
  return runs.find(
    (r) => r.stage === stage && r.rulesetVersion === STUDIO_VALIDATOR_RULESET && r.artifactSha256 === hash && r.status !== 'error',
  )
}

/** Stage 1 for one version. Oversized versions are refused before their content loads. */
export async function runStaticValidation(
  versionId: string,
  trigger: Trigger,
  requestedBy: string | null,
  /** reusePurpose: reuse this version's earlier purpose answer. purposeAdmitted: the caller
   * already took today's classifier slot (revalidation checks the quota before starting). */
  options: { classify?: PurposeClassifier; reusePurpose?: boolean; purposeAdmitted?: boolean } = {},
): Promise<StaticRunResult> {
  const sizes = await db.loadVersionSizes(versionId)
  const meta = await db.loadVersion(versionId)
  if (!sizes || !meta) return { ok: false, reason: 'not_found' }

  const oversized =
    sizes.studentBytes > STUDIO_BUNDLE_MAX_BYTES * 4 ||
    sizes.professorBytes > STUDIO_BUNDLE_MAX_BYTES * 4 ||
    sizes.sourceBytes > STUDIO_SOURCE_MAX_BYTES * 4 ||
    sizes.sourceFiles > STUDIO_SOURCE_MAX_FILES * 4
  if (oversized) {
    // Far past the limits: record the refusal without loading the content at all.
    const hash = meta.artifactSha256 ?? sha256(`unhashed:${versionId}`)
    const created = await db.insertValidation({
      versionId, institutionId: meta.institutionId, stage: 'static', status: 'running', artifactSha256: hash,
      validatorVersion: VALIDATOR_VERSION, rulesetVersion: STUDIO_VALIDATOR_RULESET, runtimeVersion: VALIDATOR_RUNTIME_VERSION,
      trigger, requestedBy,
    })
    if (!created.ok) return { ok: false, reason: 'write_failed' }
    if (!created.value) return { ok: true, validationId: null, status: 'running', reused: true }
    const outcomes = Object.fromEntries(
      checksFor('static').map((d) => [d.id, d.id === 'artifact.size'
        ? { status: 'failed', message: 'This tool is far larger than Studio allows.', metadata: { ...sizes } }
        : { status: 'skipped', message: 'Not checked: the tool is too large.' }]),
    ) as Record<StaticCheckId, CheckOutcome>
    await db.insertValidationChecks(created.value, rowsFor('static', outcomes))
    await db.finishValidation(created.value, { status: 'failed' })
    return { ok: true, validationId: created.value, status: 'failed', reused: false }
  }

  const version = await db.loadVersionArtifact(versionId)
  if (!version) return { ok: false, reason: 'not_found' }
  const artifact: PluginArtifact = {
    manifest: version.manifest,
    source: version.source,
    studentBundle: version.studentBundle,
    professorBundle: version.professorBundle,
  }
  const hash = artifactHash(artifact)

  const existing = await reusable(versionId, 'static', hash)
  if (existing) {
    return { ok: true, validationId: existing.id, status: existing.status === 'pending' ? 'running' : existing.status, reused: true }
  }

  const created = await db.insertValidation({
    versionId, institutionId: version.institutionId, stage: 'static', status: 'running', artifactSha256: hash,
    validatorVersion: VALIDATOR_VERSION, rulesetVersion: STUDIO_VALIDATOR_RULESET, runtimeVersion: VALIDATOR_RUNTIME_VERSION,
    trigger, requestedBy,
  })
  if (!created.ok) return { ok: false, reason: 'write_failed' }
  if (!created.value) return { ok: true, validationId: null, status: 'running', reused: true }
  const validationId = created.value

  try {
    const report = await runStaticChecks({
      artifact,
      storedHash: version.artifactSha256,
      deadline: Date.now() + STUDIO_VALIDATOR_STATIC_TIMEOUT_MS,
      classify: options.classify ?? quotaClassifier(version.institutionId, requestedBy, options.reusePurpose ? versionId : null, options.purposeAdmitted === true),
    })
    const rows = rowsFor('static', report.outcomes)
    const status = stageStatus(rows, 'static', requiredCheckIds('static'))
    const wrote = await db.insertValidationChecks(validationId, rows)
    const final = wrote.ok && status !== 'pending' && status !== 'running' ? status : 'error'
    const closed = await db.finishValidation(validationId, {
      status: final,
      aiModel: report.aiModel ?? null,
      aiRubricVersion: report.aiModel ? PURPOSE_RUBRIC_VERSION : null,
      error: wrote.ok ? null : { code: 'results_not_saved', message: 'Results could not be saved.' },
    })
    // A run closes once (the write is guarded on its open status), so only the call that
    // closed it as needs_review emails: one email per validation, however often it's read.
    if (final === 'needs_review' && closed.ok && closed.value) void notifyReviewers(version.institutionId, artifact.manifest)
    return { ok: true, validationId, status: final, reused: false }
  } catch (error) {
    // The validator broke, not the plugin. Never a pass; never the plugin's text in logs.
    logger.error('studio/validator.runStaticValidation: crashed', error instanceof Error ? error.name : 'unknown', { versionId, validationId })
    await db.finishValidation(validationId, { status: 'error', error: { code: 'validator_exception', message: 'The checks failed to run.' } })
    return { ok: true, validationId, status: 'error', reused: false }
  }
}

/** Stage 1 after publish. Never throws; publishing has already succeeded. */
export async function validateAfterPublish(versionId: string, publishedBy: string): Promise<void> {
  try {
    await runStaticValidation(versionId, 'publish', publishedBy)
  } catch (error) {
    logger.error('studio/validator.validateAfterPublish', error instanceof Error ? error.name : 'unknown', { versionId })
  }
}

// ── The verdict ──────────────────────────────────────────────────────

/** Everything the publication gate decides from, read fresh. Fails closed: anything
 * unreadable is "unavailable", never passed. */
export async function currentVerdict(versionId: string): Promise<VersionVerdict> {
  const sizes = await db.loadVersionSizes(versionId)
  if (!sizes) return { status: 'unavailable', reason: 'not_checked' }
  if (
    sizes.studentBytes > STUDIO_BUNDLE_MAX_BYTES * 4 || sizes.professorBytes > STUDIO_BUNDLE_MAX_BYTES * 4 ||
    sizes.sourceBytes > STUDIO_SOURCE_MAX_BYTES * 4
  ) {
    return { status: 'failed', reason: 'static_failed' }
  }
  const [version, runs, min] = await Promise.all([db.loadVersionArtifact(versionId), db.listValidations(versionId), db.loadMinAcceptedRuleset()])
  if (!version || !runs) return { status: 'unavailable', reason: 'validator_error' }
  const recomputedHash = artifactHash({
    manifest: version.manifest,
    source: version.source,
    studentBundle: version.studentBundle,
    professorBundle: version.professorBundle,
  })
  const reviewRunIds = runs.filter((r) => r.status === 'needs_review').map((r) => r.id)
  const [checks, reviews] = await Promise.all([db.listValidationChecks(reviewRunIds), db.listValidationReviews(reviewRunIds)])
  if (!checks || !reviews) return { status: 'unavailable', reason: 'validator_error' }
  const reviewChecks: Record<string, string[]> = {}
  for (const c of checks) if (c.status === 'needs_review') (reviewChecks[c.validationId] ??= []).push(c.checkId)
  return versionVerdict({
    storedHash: version.artifactSha256,
    recomputedHash,
    runs: runs.map((r) => ({ id: r.id, stage: r.stage, status: r.status, artifactSha256: r.artifactSha256, rulesetVersion: r.rulesetVersion, createdAt: r.createdAt })),
    reviewChecks,
    reviews,
    minRuleset: min,
  })
}

export interface ValidationSummary {
  verdict: VersionVerdict
  /** The run of each stage the verdict reads (or the newest for this artifact), what it found,
   * and any reviewer's decision on a flagged check, for the professor. */
  stages: Record<
    'static' | 'runtime',
    { status: string; findings: { checkId: string; status: string; message: string; review: { decision: 'approved' | 'rejected'; reason: string } | null }[] } | null
  >
  canRequestRuntime: boolean
  runnerAvailable: boolean
}

/** For the professor's publish dialog. The caller has verified the section's professor. */
export async function validationSummary(versionId: string): Promise<ValidationSummary | null> {
  const [verdict, runs, version] = await Promise.all([currentVerdict(versionId), db.listValidations(versionId), db.loadVersion(versionId)])
  if (!runs || !version) return null
  const hash = version.artifactSha256
  // The runs the verdict decided from, when it names them; otherwise the newest for this
  // artifact at any ruleset, so a ruleset change never leaves the dialog empty.
  const named: Record<string, string> = {}
  if (verdict.status === 'passed') Object.assign(named, { static: verdict.staticRunId, runtime: verdict.runtimeRunId })
  if (verdict.status === 'needs_review') named[runs.find((r) => r.id === verdict.runId)?.stage ?? 'static'] = verdict.runId
  const latest = (stage: 'static' | 'runtime') => runs.find((r) => r.id === named[stage]) ?? runs.find((r) => r.stage === stage && r.artifactSha256 === hash)
  const staticRun = latest('static')
  const runtimeRun = latest('runtime')
  const ids = [staticRun?.id, runtimeRun?.id].filter((x): x is string => !!x)
  const [checks, reviews] = await Promise.all([db.listValidationChecks(ids), db.listValidationReviewDetails(ids)])
  const decided = new Map((reviews ?? []).map((r) => [`${r.validationId}|${r.checkId}`, { decision: r.decision, reason: r.reason }]))
  const describe = (run: typeof staticRun) => {
    if (!run) return null
    const own = (checks ?? []).filter((c) => c.validationId === run.id)
    const flagged = own.filter((c) => c.status === 'needs_review')
    // A run whose flagged checks were all decided reads as its reviewed outcome.
    const reviewed = run.status === 'needs_review' && flagged.length > 0 && flagged.every((c) => decided.has(`${run.id}|${c.checkId}`))
    const rejected = flagged.some((c) => decided.get(`${run.id}|${c.checkId}`)?.decision === 'rejected')
    return {
      status: reviewed ? (rejected ? 'failed' : 'passed') : run.status,
      findings: own
        .filter((c) => c.status !== 'passed' && c.status !== 'skipped')
        .map((c) => {
          const review = decided.get(`${run.id}|${c.checkId}`) ?? null
          // A decided check reads as what was decided, not "a reviewer needs to confirm".
          return { checkId: c.checkId, status: c.status, message: review ? (checkDefinition(c.checkId)?.summary ?? c.message) : c.message, review }
        }),
    }
  }
  return {
    verdict,
    stages: { static: describe(staticRun), runtime: describe(runtimeRun) },
    canRequestRuntime: verdict.status === 'unavailable' && RETRYABLE.has(verdict.reason),
    runnerAvailable: runnerMode() !== 'unavailable',
  }
}

// ── Stage 2 ───────────────────────────────────────────────────────────

const requestInput = z.strictObject({ sectionId: z.uuid(), installationId: z.uuid() })

export type RuntimeRequestResult =
  | { ok: true; status: 'running' | 'passed' | 'failed' | 'error' }
  | { ok: false; error: string }

const NOT_AVAILABLE = 'This isn’t available.'
const TOO_SOON = 'The checks just ran. Try again in a minute.'

/** Verdicts asking for the browser checks can move forward. The first three need Stage 1
 * again first (below_minimum_ruleset: the old verdict no longer counts); the browser checks
 * start only once Stage 1 has passed. */
const RETRYABLE = new Set<string>(['not_checked', 'validator_error', 'below_minimum_ruleset', 'runtime_not_checked', 'runtime_error'])
const NEEDS_STAGE1 = new Set<string>(['not_checked', 'validator_error', 'below_minimum_ruleset'])

const ADMIT_REFUSED: Record<'busy' | 'daily' | 'global_busy', string> = {
  busy: 'Browser checks are already running for your school. Try again in a few minutes.',
  daily: 'Your school has used today’s browser checks. They’re available again tomorrow.',
  global_busy: 'Studio’s browser checks are busy right now. Try again in a few minutes.',
}

/** The section's professor asks for the browser checks of their installation's current version. */
export async function requestRuntimeValidation(raw: z.input<typeof requestInput>): Promise<RuntimeRequestResult> {
  const parsed = requestInput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: NOT_AVAILABLE }
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return { ok: false, error: NOT_AVAILABLE }
  const installation = await db.loadInstallation(parsed.data.installationId)
  if (!installation || installation.sectionId !== professor.sectionId || installation.status !== 'active') {
    return { ok: false, error: NOT_AVAILABLE }
  }
  return startRuntime(installation, { lane: 'professor', actorId: professor.userId, sectionId: professor.sectionId })
}

/** Revalidation asks for the browser checks without a professor session: the system lane,
 * with the installation, access and Stage 1 rules unchanged. */
export async function requestRuntimeValidationAsSystem(installationId: string, actorId: string): Promise<RuntimeRequestResult> {
  const installation = await db.loadInstallation(installationId)
  if (!installation || installation.status !== 'active') return { ok: false, error: NOT_AVAILABLE }
  return startRuntime(installation, { lane: 'system', actorId, sectionId: installation.sectionId })
}

async function startRuntime(
  installation: db.InstallationRow,
  who: { lane: 'professor' | 'system'; actorId: string; sectionId: string },
): Promise<RuntimeRequestResult> {
  // Running plugin code is new Studio work: not while Studio is paused or not entitled.
  const access = await studioAccess(installation.institutionId)
  if (access === 'off') return { ok: false, error: STUDIO_PAUSED }
  if (access === 'read_only') return { ok: false, error: entitlementRefusalMessage('studio') }

  const stored = await db.loadVersion(installation.currentVersionId)
  if (!stored?.artifactSha256) return { ok: false, error: NOT_AVAILABLE }

  let verdict = await currentVerdict(installation.currentVersionId)
  if (verdict.status === 'unavailable' && NEEDS_STAGE1.has(verdict.reason)) {
    // Stage 1 has no usable result under the accepted ruleset: run it again first.
    if (await coolingDown(stored.id, 'static', stored.artifactSha256)) return { ok: false, error: TOO_SOON }
    await runStaticValidation(installation.currentVersionId, who.lane === 'system' ? 'ruleset_change' : 'retry', who.actorId, {
      reusePurpose: who.lane === 'system',
    })
    verdict = await currentVerdict(installation.currentVersionId)
  }
  if (verdict.status === 'passed') return { ok: true, status: 'passed' }
  // A run is already under way (either stage): nothing new is started.
  if (verdict.status === 'unavailable' && verdict.reason === 'checking') return { ok: true, status: 'running' }
  if (!(verdict.status === 'unavailable' && (verdict.reason === 'runtime_not_checked' || verdict.reason === 'runtime_error'))) {
    return { ok: false, error: 'The automatic checks have to pass before the browser checks can run.' }
  }

  const version = await db.loadVersionArtifact(installation.currentVersionId)
  if (!version || !version.artifactSha256) return { ok: false, error: NOT_AVAILABLE }
  if (await coolingDown(version.id, 'runtime', version.artifactSha256)) return { ok: false, error: TOO_SOON }
  const existing = await reusable(version.id, 'runtime', version.artifactSha256)
  if (existing && existing.status !== 'pending' && existing.status !== 'running') {
    return { ok: true, status: existing.status === 'needs_review' ? 'failed' : existing.status }
  }

  const mode = runnerMode()
  // A local run's nonce is known now; a cloud run's is created by the dispatcher, so it is
  // never stored in a job row.
  const nonce = mode === 'local' ? randomBytes(32).toString('base64url') : null
  const admitted = await db.admitRuntimeRun({
    versionId: version.id, institutionId: version.institutionId, artifactSha256: version.artifactSha256,
    validatorVersion: VALIDATOR_VERSION, rulesetVersion: STUDIO_VALIDATOR_RULESET, runtimeVersion: VALIDATOR_RUNTIME_VERSION,
    trigger: who.lane === 'system' ? 'ruleset_change' : 'professor', requestedBy: who.actorId,
    callbackSha256: nonce ? sha256(nonce) : null, lane: who.lane,
    caps: {
      global_concurrent: STUDIO_VALIDATOR_STAGE2_GLOBAL_CONCURRENT,
      institution_concurrent: STUDIO_VALIDATOR_STAGE2_INSTITUTION_CONCURRENT,
      institution_daily: STUDIO_VALIDATOR_STAGE2_INSTITUTION_DAILY,
      system_concurrent: STUDIO_VALIDATOR_STAGE2_SYSTEM_CONCURRENT,
    },
  })
  if (!admitted) return { ok: false, error: 'Something went wrong. Try again.' }
  if (admitted.outcome === 'exists') return { ok: true, status: 'running' }
  if (admitted.outcome !== 'admitted') return { ok: false, error: ADMIT_REFUSED[admitted.outcome] }
  const validationId = admitted.id
  logEvent({
    userId: who.actorId,
    eventType: 'studio.validation.runtime_requested',
    eventCategory: 'studio',
    sectionId: who.sectionId,
    metadata: { installationId: installation.id, versionId: version.id, validationId, lane: who.lane },
  })

  if (mode === 'unavailable') {
    await db.finishValidation(validationId, {
      status: 'error',
      runner: 'unavailable',
      error: { code: 'runner_unavailable', message: 'Browser checks can’t run in this environment yet.' },
    })
    return { ok: true, status: 'error' }
  }

  if (mode === 'cloud') {
    // The dispatcher job starts one Cloud Run execution; the jobs kick's upkeep collects it.
    const queued = await enqueueJob({ type: STUDIO_VALIDATOR_RUNTIME_JOB, institutionId: version.institutionId, params: { validationId }, createdBy: who.actorId, subjectKey: validationId }).then(
      () => true,
      () => false,
    )
    if (!queued) {
      await db.finishValidation(validationId, { status: 'error', error: { code: 'runner_unavailable', message: 'The browser checks couldn’t start. Try again shortly.' } })
      return { ok: true, status: 'error' }
    }
    return { ok: true, status: 'running' }
  }

  // Local runner: a child process with no secrets runs the browser on this machine.
  const payload = buildPayload(validationId, nonce!, { manifest: version.manifest, studentBundle: version.studentBundle, professorBundle: version.professorBundle })
  if (!(await db.dispatchValidation(validationId, 'local', payload.sha256, null, null, null))) return { ok: true, status: 'running' }
  void runLocally(validationId, payload.bytes).then(async (envelope) => {
    const done = envelope ? await finishRuntimeRun(validationId, envelope, 'local') : null
    if (!done || !done.ok) {
      await db.finishValidation(validationId, { status: 'error', runner: 'local', error: { code: 'runner_failed', message: 'The browser checks didn’t finish.' } })
    }
  })
  return { ok: true, status: 'running' }
}

export type SubmitResult = { ok: true; status: 'passed' | 'failed' | 'error' } | { ok: false; reason: 'not_found' | 'denied' | 'invalid' }

/**
 * A runner's envelope, from the dispatcher that collected it (`via` is how the run was
 * dispatched). Accepted once, only while the run is open and unexpired, and only when the
 * binding matches what the server recorded: this run's id, the nonce whose hash is on the
 * run, the exact payload's SHA-256, and the runtime version. The server decides the
 * verdict from the measurements.
 */
export async function finishRuntimeRun(validationId: string, raw: unknown, via: 'local' | 'cloud'): Promise<SubmitResult> {
  if (!z.uuid().safeParse(validationId).success) return { ok: false, reason: 'denied' }
  const run = await db.loadValidation(validationId)
  if (!run || run.stage !== 'runtime') return { ok: false, reason: 'not_found' }
  if (run.status !== 'pending' && run.status !== 'running') return { ok: false, reason: 'denied' }
  if (run.runnerMode !== via) return { ok: false, reason: 'denied' }
  if (Date.now() - new Date(run.createdAt).getTime() > STUDIO_VALIDATOR_CALLBACK_TTL_MS) {
    await db.finishValidation(run.id, { status: 'error', error: { code: 'callback_expired', message: 'The browser checks took too long.' } })
    return { ok: false, reason: 'denied' }
  }
  const parsed = runtimeEnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    await db.finishValidation(run.id, { status: 'error', error: { code: 'report_invalid', message: 'The browser checks sent an unreadable report.' } })
    return { ok: false, reason: 'invalid' }
  }
  const { binding, report } = parsed.data
  const same = (a: string | null, b: string) => {
    if (!a) return false
    const x = Buffer.from(a, 'hex')
    const y = Buffer.from(b, 'hex')
    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
  }
  if (
    binding.validationId !== run.id ||
    binding.runtimeVersion !== run.runtimeVersion ||
    !same(run.callbackSha256, sha256(binding.nonce)) ||
    !same(run.payloadSha256, binding.payloadSha256)
  ) {
    await db.finishValidation(run.id, { status: 'error', error: { code: 'binding_mismatch', message: 'The browser checks’ result didn’t match this run.' } })
    return { ok: false, reason: 'denied' }
  }

  const results = summarizeRuntimeReport(report)
  const rows: db.ValidationCheckRow[] = results.map((r) => {
    const def = checkDefinition(r.checkId)!
    return {
      checkId: r.checkId,
      ruleRefs: def.rules,
      stage: 'runtime',
      status: r.status,
      severity: def.severity,
      message: def.summary.slice(0, 500),
      metadata: boundedMetadata({ views: r.views, findings: r.findings }),
    }
  })
  const status = stageStatus(rows, 'runtime', requiredCheckIds('runtime'))
  const wrote = await db.insertValidationChecks(run.id, rows)
  const final = wrote.ok && (status === 'passed' || status === 'failed') ? status : 'error'
  const finished = await db.finishValidation(run.id, {
    status: final,
    browser: report.browser,
    runner: `${report.runner.name}@${report.runner.version}`,
  })
  if (!finished.ok || !finished.value) return { ok: false, reason: 'denied' }
  return { ok: true, status: final }
}

/**
 * The HTTP report path, for the local runner and tests only: the route returns 404 unless
 * the runner mode is local, and this refuses any run not dispatched locally. The bearer
 * token must be the run's nonce, and the envelope's binding is checked as above.
 */
export async function submitRuntimeReport(input: { token: string; envelope: unknown }): Promise<SubmitResult> {
  if (runnerMode() !== 'local') return { ok: false, reason: 'denied' }
  if (typeof input.token !== 'string' || input.token.length > 200) return { ok: false, reason: 'denied' }
  const id = (input.envelope as { binding?: { validationId?: unknown; nonce?: unknown } } | null)?.binding?.validationId
  const nonce = (input.envelope as { binding?: { nonce?: unknown } } | null)?.binding?.nonce
  if (typeof id !== 'string' || nonce !== input.token) return { ok: false, reason: 'denied' }
  return finishRuntimeRun(id, input.envelope, 'local')
}

// ── Review ───────────────────────────────────────────────────────────

const reviewInput = z.strictObject({
  validationId: z.uuid(),
  checkId: z.string().max(80),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(1).max(500),
})

/**
 * A Scholera super admin resolves one `needs_review` check, bound to the artifact they saw:
 * refused when the version's content changed, the check is no longer waiting, or it was
 * already reviewed. The database checks again that the reviewer is a super admin and didn't
 * publish the version, and refuses a second review of the same check.
 */
export async function resolveValidationReview(raw: z.input<typeof reviewInput>): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = reviewInput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid review.' }
  const admin = await verifySuperAdmin()
  if ('error' in admin) return { ok: false, error: NOT_AVAILABLE }
  const run = await db.loadValidation(parsed.data.validationId)
  if (!run || run.status !== 'needs_review' || run.artifactSha256 !== parsed.data.artifactSha256) {
    return { ok: false, error: 'This tool changed or was already decided. Reload the queue.' }
  }
  const version = await db.loadVersion(run.versionId)
  if (!version || version.artifactSha256 !== parsed.data.artifactSha256) return { ok: false, error: 'This tool changed or was already decided. Reload the queue.' }
  const saved = await db.insertValidationReview({ validationId: parsed.data.validationId, checkId: parsed.data.checkId, decision: parsed.data.decision, reason: parsed.data.reason, reviewerId: admin.userId })
  if (!saved.ok) return { ok: false, error: 'This review couldn’t be saved. It may already be decided, or you published this tool yourself.' }
  logEvent({
    userId: admin.userId,
    eventType: `studio.validation.review_${parsed.data.decision}`,
    eventCategory: 'studio',
    metadata: { validationId: parsed.data.validationId, checkId: parsed.data.checkId },
  })
  return { ok: true }
}

export interface ReviewQueueView {
  validationId: string
  checkId: string
  checkSummary: string
  message: string
  findings: { view: string | null; detail: string }[]
  stage: 'static' | 'runtime'
  /** The run was a re-check after the accepted checks were raised. */
  recheck: boolean
  waitingSince: string
  institution: string
  /** Courses the tool is installed in; empty when it isn't installed anywhere yet. */
  courses: string[]
  pluginName: string
  version: string
  purpose: string
  artifactSha256: string
  /** The flagged view's source, shown as escaped text. Null when the check isn't about a view. */
  source: { view: 'student' | 'professor'; text: string } | null
  publishedByYou: boolean
}

/** How many checks wait for a reviewer, for the super-admin landing page. Null for anyone else or when unreadable. */
export async function countWaitingReviews(): Promise<number | null> {
  const admin = await verifySuperAdmin()
  if ('error' in admin) return null
  return db.countReviewQueue()
}

/** The super admin's review queue. Null for anyone else or when unreadable. */
export async function getReviewQueue(): Promise<ReviewQueueView[] | null> {
  const admin = await verifySuperAdmin()
  if ('error' in admin) return null
  const items = await db.listReviewQueue(STUDIO_REVIEW_QUEUE_LISTED)
  if (!items) return null
  const [names, courses] = await Promise.all([
    db.loadInstitutionNames([...new Set(items.map((i) => i.institutionId))]),
    db.loadProjectCourses([...new Set(items.map((i) => i.projectId).filter(Boolean))]),
  ])
  return Promise.all(
    items.map(async (i) => {
      const manifest = (i.manifest ?? {}) as { name?: unknown; purpose?: { summary?: unknown } }
      const view = i.findings.some((f) => f.view === 'professor') && !i.findings.some((f) => f.view !== 'professor') ? 'professor' : i.checkId === 'edtech.purpose' ? null : 'student'
      const artifact = view ? await db.loadVersionArtifact(i.versionId) : null
      const sourceText = view && artifact ? String((artifact.source as Record<string, unknown>)[`views/${view}.tsx`] ?? '') : ''
      return {
        validationId: i.validationId,
        checkId: i.checkId,
        checkSummary: checkDefinition(i.checkId)?.summary ?? i.checkId,
        message: i.message,
        findings: i.findings.map((f) => ({ view: typeof f.view === 'string' ? f.view : null, detail: String(f.detail ?? '').slice(0, 200) })),
        stage: i.stage,
        recheck: i.trigger === 'ruleset_change',
        waitingSince: i.createdAt,
        institution: names?.[i.institutionId] ?? 'Unknown institution',
        courses: courses?.[i.projectId] ?? [],
        pluginName: typeof manifest.name === 'string' ? manifest.name : 'Tool',
        version: i.version,
        purpose: typeof manifest.purpose?.summary === 'string' ? manifest.purpose.summary : '',
        artifactSha256: i.artifactSha256,
        source: view && sourceText ? { view, text: sourceText.slice(0, 64 * 1024) } : null,
        publishedByYou: i.publishedBy === admin.userId,
      }
    }),
  )
}

/** Tells Scholera's super admins a check is waiting for them. Names the tool and school
 * only; never the tool's code. Never throws. */
async function notifyReviewers(institutionId: string, manifest: unknown): Promise<void> {
  try {
    const [emails, names] = await Promise.all([db.listSuperAdminEmails(), db.loadInstitutionNames([institutionId])])
    if (!emails || emails.length === 0) return
    const name = (manifest as { name?: unknown } | null)?.name
    await sendStudioReviewWaiting(emails, { pluginName: typeof name === 'string' ? name : 'A Studio tool', institution: names?.[institutionId] ?? 'an institution' })
  } catch (error) {
    logger.error('studio/validator.notifyReviewers', error instanceof Error ? error.name : 'unknown')
  }
}

// ── Ruleset changes ──────────────────────────────────────────────────

export interface ValidatorPanel {
  /** The ruleset this code checks with, and the lowest one a verdict may have been reached under. */
  codeRuleset: number
  minAccepted: number | null
  /** Institutions whose tools are still being re-checked, and of those, how many wait on capacity. */
  revalidating: number
  waitingOnCapacity: number
  reviewsWaiting: number | null
}

/** The "Studio validator" panel on AI Controls. Null for anyone but a super admin. */
export async function getValidatorPanel(): Promise<ValidatorPanel | null> {
  const admin = await verifySuperAdmin()
  if ('error' in admin) return null
  const [minAccepted, progress, reviewsWaiting] = await Promise.all([db.loadMinAcceptedRuleset(), db.revalidationProgress(STUDIO_VALIDATOR_REVALIDATE_JOB), db.countReviewQueue()])
  return { codeRuleset: STUDIO_VALIDATOR_RULESET, minAccepted, revalidating: progress?.active ?? 0, waitingOnCapacity: progress?.waiting ?? 0, reviewsWaiting }
}

/**
 * After a super admin raised the minimum (through their own client, so the database saw
 * who): one revalidation job per institution with active tools, as that super admin. An
 * institution already being re-checked keeps its job, which starts over on its own when
 * it sees the minimum moved. Returns how many institutions were queued, or null when the
 * list couldn't be read or any school couldn't be queued, so the caller offers a retry.
 */
/** The accepted minimum ruleset, or null when unreadable. For super-admin actions. */
export async function loadAcceptedMinimum(): Promise<number | null> {
  return db.loadMinAcceptedRuleset()
}

export async function enqueueRevalidation(actorId: string, minRuleset: number): Promise<number | null> {
  const institutions = await db.listInstitutionsWithInstallations()
  if (!institutions) return null
  let queued = 0
  for (const institutionId of institutions) {
    try {
      await enqueueJob({ type: STUDIO_VALIDATOR_REVALIDATE_JOB, institutionId, params: { offset: 0, minRuleset }, createdBy: actorId, subjectKey: REVALIDATE_SUBJECT })
      queued += 1
    } catch (error) {
      logger.error('studio/validator.enqueueRevalidation', error instanceof Error ? error.name : 'unknown', { institutionId })
    }
  }
  return queued < institutions.length ? null : queued
}

/**
 * Stage 1 again for one page of one institution's active installations, and the browser
 * checks for the ones students can see (system lane). Called by the revalidation job, with
 * the super admin who raised the minimum as the actor. Stops early, with the same offset to
 * resume from, when the Stage 2 lane or the classifier quota is full: nothing is recorded
 * as a quota failure.
 */
export async function revalidateInstitutionPage(
  institutionId: string,
  actorId: string,
  offset: number,
): Promise<{ next: number | null; checked: number; waiting: boolean }> {
  const page = await db.listInstitutionCurrentVersions(institutionId, STUDIO_REVALIDATE_PAGE, offset)
  if (!page) return { next: offset, checked: 0, waiting: true }
  let checked = 0
  for (let i = 0; i < page.rows.length; i++) {
    const row = page.rows[i]
    const verdict = await currentVerdict(row.versionId)
    if (verdict.status === 'passed' || verdict.status === 'failed' || verdict.status === 'needs_review') continue
    if (verdict.status === 'unavailable' && NEEDS_STAGE1.has(verdict.reason)) {
      const prior = await db.loadLatestPurposeOutcome(row.versionId, PURPOSE_RUBRIC_VERSION)
      if (!prior && (await db.purposeAdmit(institutionId, STUDIO_PURPOSE_DAILY_PER_INSTITUTION)) !== true) {
        return { next: offset + i, checked, waiting: true }
      }
      await runStaticValidation(row.versionId, 'ruleset_change', actorId, { reusePurpose: true, purposeAdmitted: !prior })
      checked += 1
    }
    if (row.visible) {
      const r = await requestRuntimeValidationAsSystem(row.installationId, actorId)
      if (!r.ok && Object.values(ADMIT_REFUSED).includes(r.error)) return { next: offset + i, checked, waiting: true }
    }
  }
  return { next: page.installations === STUDIO_REVALIDATE_PAGE ? offset + STUDIO_REVALIDATE_PAGE : null, checked, waiting: false }
}
