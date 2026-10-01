/**
 * The pre-publish validator's trusted service: start runs, record results, read the
 * verdict. docs/reference/studio-plugin-validator.md.
 *
 *   Stage 1 (static) runs automatically after a version is published, and again when the
 *   ruleset changes. It never executes plugin code.
 *   Stage 2 (runtime) runs only when the section's professor asks, after Stage 1 passed,
 *   through a runner (runtime-runner.ts). Its result comes back with a token that is
 *   valid for that one run, once.
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
import { logEvent } from '@/lib/supabase/event-logger'
import { STUDIO_PAUSED, studioAccess } from '../access'
import { requireProfessor } from '../context'
import * as db from '../db'
import {
  STUDIO_BUNDLE_MAX_BYTES,
  STUDIO_SOURCE_MAX_BYTES,
  STUDIO_SOURCE_MAX_FILES,
  STUDIO_VALIDATOR_CALLBACK_TTL_MS,
  STUDIO_VALIDATOR_CHECK_METADATA_MAX_BYTES,
  STUDIO_VALIDATOR_RETRY_COOLDOWN_MS,
  STUDIO_VALIDATOR_STATIC_TIMEOUT_MS,
} from '../limits'
import { artifactHash, type PluginArtifact } from './artifact'
import { PURPOSE_RUBRIC_VERSION, type PurposeClassifier } from './purpose'
import { createPurposeClassifier } from './purpose-ai'
import {
  checkDefinition,
  checksFor,
  STUDIO_VALIDATOR_RULESET,
  VALIDATOR_RUNTIME_VERSION,
  VALIDATOR_VERSION,
  type StaticCheckId,
} from './ruleset'
import { runtimeReportSchema, summarizeRuntimeReport } from './runtime-report'
import { runLocally, runnerMode } from './runtime-runner'
import { runStaticChecks, type CheckOutcome } from './static-checks'
import { stageStatus, versionVerdict, type VersionVerdict } from './verdict'

type Trigger = 'publish' | 'professor' | 'ruleset_change' | 'retry' | 'test'

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

const requiredIds = (stage: 'static' | 'runtime') => checksFor(stage).filter((c) => c.required).map((c) => c.id)

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
  options: { classify?: PurposeClassifier } = {},
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
      classify: options.classify ?? createPurposeClassifier({ institutionId: version.institutionId, userId: requestedBy }),
    })
    const rows = rowsFor('static', report.outcomes)
    const status = stageStatus(rows, 'static', requiredIds('static'))
    const wrote = await db.insertValidationChecks(validationId, rows)
    const final = wrote.ok && status !== 'pending' && status !== 'running' ? status : 'error'
    await db.finishValidation(validationId, {
      status: final,
      aiModel: report.aiModel ?? null,
      aiRubricVersion: report.aiModel ? PURPOSE_RUBRIC_VERSION : null,
      error: wrote.ok ? null : { code: 'results_not_saved', message: 'Results could not be saved.' },
    })
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
  /** Latest run of each stage for this artifact, and what it found, for the professor. */
  stages: Record<'static' | 'runtime', { status: string; findings: { checkId: string; status: string; message: string }[] } | null>
  canRequestRuntime: boolean
  runnerAvailable: boolean
}

/** For the professor's publish dialog. The caller has verified the section's professor. */
export async function validationSummary(versionId: string): Promise<ValidationSummary | null> {
  const [verdict, runs, version] = await Promise.all([currentVerdict(versionId), db.listValidations(versionId), db.loadVersion(versionId)])
  if (!runs || !version) return null
  const hash = version.artifactSha256
  const latest = (stage: 'static' | 'runtime') =>
    runs.find((r) => r.stage === stage && r.artifactSha256 === hash && r.rulesetVersion === STUDIO_VALIDATOR_RULESET)
  const staticRun = latest('static')
  const runtimeRun = latest('runtime')
  const ids = [staticRun?.id, runtimeRun?.id].filter((x): x is string => !!x)
  const checks = (await db.listValidationChecks(ids)) ?? []
  const describe = (run: typeof staticRun) =>
    run
      ? {
          status: run.status,
          findings: checks
            .filter((c) => c.validationId === run.id && c.status !== 'passed' && c.status !== 'skipped')
            .map((c) => ({ checkId: c.checkId, status: c.status, message: c.message })),
        }
      : null
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

/** Verdicts the professor's "Run browser checks" can move forward. The first two need
 * Stage 1 again first; the browser checks start only once Stage 1 has passed. */
const RETRYABLE = new Set<string>(['not_checked', 'validator_error', 'runtime_not_checked', 'runtime_error'])

/** The section's professor asks for the browser checks of their installation's current
 * version. Only after Stage 1 passed for that exact artifact. */
export async function requestRuntimeValidation(raw: z.input<typeof requestInput>): Promise<RuntimeRequestResult> {
  const parsed = requestInput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: NOT_AVAILABLE }
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return { ok: false, error: NOT_AVAILABLE }
  const installation = await db.loadInstallation(parsed.data.installationId)
  if (!installation || installation.sectionId !== professor.sectionId || installation.status !== 'active') {
    return { ok: false, error: NOT_AVAILABLE }
  }
  // Running plugin code is new Studio work: not while Studio is paused or not entitled.
  const access = await studioAccess(professor.institutionId)
  if (access === 'off') return { ok: false, error: STUDIO_PAUSED }
  if (access === 'read_only') return { ok: false, error: entitlementRefusalMessage('studio') }

  const stored = await db.loadVersion(installation.currentVersionId)
  if (!stored?.artifactSha256) return { ok: false, error: NOT_AVAILABLE }
  const TOO_SOON = 'The checks just ran. Try again in a minute.'

  let verdict = await currentVerdict(installation.currentVersionId)
  if (verdict.status === 'unavailable' && (verdict.reason === 'not_checked' || verdict.reason === 'validator_error')) {
    // Stage 1 has no usable result for this artifact: run it again first.
    if (await coolingDown(stored.id, 'static', stored.artifactSha256)) return { ok: false, error: TOO_SOON }
    await runStaticValidation(installation.currentVersionId, 'retry', professor.userId)
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

  const token = randomBytes(32).toString('base64url')
  const created = await db.insertValidation({
    versionId: version.id, institutionId: version.institutionId, stage: 'runtime', status: 'pending', artifactSha256: version.artifactSha256,
    validatorVersion: VALIDATOR_VERSION, rulesetVersion: STUDIO_VALIDATOR_RULESET, runtimeVersion: VALIDATOR_RUNTIME_VERSION,
    trigger: 'professor', requestedBy: professor.userId, callbackSha256: sha256(token),
  })
  if (!created.ok) return { ok: false, error: 'Something went wrong. Try again.' }
  if (!created.value) return { ok: true, status: 'running' }
  const validationId = created.value
  logEvent({
    userId: professor.userId,
    eventType: 'studio.validation.runtime_requested',
    eventCategory: 'studio',
    sectionId: professor.sectionId,
    metadata: { installationId: installation.id, versionId: version.id, validationId },
  })

  if (runnerMode() === 'unavailable') {
    await db.finishValidation(validationId, {
      status: 'error',
      runner: 'unavailable',
      error: { code: 'runner_unavailable', message: 'Browser checks can’t run in this environment yet.' },
    })
    return { ok: true, status: 'error' }
  }

  // Local runner: a child process with no secrets runs the browser; the result comes
  // back through the same token-checked path a production container would use.
  void runLocally({
    validationId,
    token,
    artifact: { manifest: version.manifest, studentBundle: version.studentBundle, professorBundle: version.professorBundle },
  }).then(async (report) => {
    const done = report ? await submitRuntimeReport({ validationId, token, report }) : null
    if (!done || !done.ok) {
      await db.finishValidation(validationId, { status: 'error', runner: 'local', error: { code: 'runner_failed', message: 'The browser checks didn’t finish.' } })
    }
  })
  return { ok: true, status: 'running' }
}

export type SubmitResult = { ok: true; status: 'passed' | 'failed' | 'error' } | { ok: false; reason: 'not_found' | 'denied' | 'invalid' }

/** A runner's report, accepted once, only with that run's own token, while the run is
 * open and not expired. The server decides the verdict from the measurements. */
export async function submitRuntimeReport(input: { validationId: string; token: string; report: unknown }): Promise<SubmitResult> {
  if (!z.uuid().safeParse(input.validationId).success || typeof input.token !== 'string' || input.token.length > 200) {
    return { ok: false, reason: 'denied' }
  }
  const run = await db.loadValidation(input.validationId)
  if (!run || run.stage !== 'runtime') return { ok: false, reason: 'not_found' }
  const expected = run.callbackSha256 ? Buffer.from(run.callbackSha256, 'hex') : null
  const given = Buffer.from(sha256(input.token), 'hex')
  if (!expected || expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'denied' }
  if (run.status !== 'pending' && run.status !== 'running') return { ok: false, reason: 'denied' }
  if (Date.now() - new Date(run.createdAt).getTime() > STUDIO_VALIDATOR_CALLBACK_TTL_MS) {
    await db.finishValidation(run.id, { status: 'error', error: { code: 'callback_expired', message: 'The browser checks took too long.' } })
    return { ok: false, reason: 'denied' }
  }
  if (run.status === 'pending') await db.startValidation(run.id)

  const parsed = runtimeReportSchema.safeParse(input.report)
  if (!parsed.success) {
    await db.finishValidation(run.id, { status: 'error', error: { code: 'report_invalid', message: 'The browser checks sent an unreadable report.' } })
    return { ok: false, reason: 'invalid' }
  }
  const results = summarizeRuntimeReport(parsed.data)
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
  const status = stageStatus(rows, 'runtime', requiredIds('runtime'))
  const wrote = await db.insertValidationChecks(run.id, rows)
  const final = wrote.ok && (status === 'passed' || status === 'failed') ? status : 'error'
  const finished = await db.finishValidation(run.id, {
    status: final,
    browser: parsed.data.browser,
    runner: `${parsed.data.runner.name}@${parsed.data.runner.version}`,
  })
  if (!finished.ok || !finished.value) return { ok: false, reason: 'denied' }
  return { ok: true, status: final }
}

// ── Review ───────────────────────────────────────────────────────────

const reviewInput = z.strictObject({
  validationId: z.uuid(),
  checkId: z.string().max(80),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(1).max(500),
})

/** A Scholera super admin resolves one `needs_review` check. The database checks again
 * that the reviewer is a super admin and didn't publish the version. */
export async function resolveValidationReview(raw: z.input<typeof reviewInput>): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = reviewInput.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid review.' }
  const admin = await verifySuperAdmin()
  if ('error' in admin) return { ok: false, error: NOT_AVAILABLE }
  const saved = await db.insertValidationReview({ ...parsed.data, reviewerId: admin.userId })
  if (!saved.ok) return { ok: false, error: 'This review couldn’t be saved.' }
  logEvent({
    userId: admin.userId,
    eventType: `studio.validation.review_${parsed.data.decision}`,
    eventCategory: 'studio',
    metadata: { validationId: parsed.data.validationId, checkId: parsed.data.checkId },
  })
  return { ok: true }
}

// ── Ruleset changes ──────────────────────────────────────────────────

/** Re-checks Stage 1 for one page of active installations' current versions under the
 * current ruleset. Identical artifacts already checked under it are skipped. Pass the
 * returned `next` back as `offset` until it's null. Super admin only. */
export async function revalidateCurrentVersions(
  limit = 50,
  offset = 0,
): Promise<{ ok: true; checked: number; next: number | null } | { ok: false; error: string }> {
  const admin = await verifySuperAdmin()
  if ('error' in admin) return { ok: false, error: NOT_AVAILABLE }
  const size = Math.min(Math.max(Math.floor(limit), 1), 200)
  const start = Math.max(Math.floor(offset), 0)
  const page = await db.listActiveCurrentVersions(size, start)
  let checked = 0
  for (const v of page.versions) {
    const result = await runStaticValidation(v.versionId, 'ruleset_change', admin.userId)
    if (result.ok && !result.reused) checked += 1
  }
  logEvent({ userId: admin.userId, eventType: 'studio.validation.revalidated', eventCategory: 'studio', metadata: { checked, offset: start, ruleset: STUDIO_VALIDATOR_RULESET } })
  return { ok: true, checked, next: page.installations === size ? start + size : null }
}
