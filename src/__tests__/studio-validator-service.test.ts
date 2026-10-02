/**
 * The validator's trusted service (validator/service.ts) over an in-memory stand-in for
 * db.ts that keeps the rules the database enforces: one active run per version and
 * stage, results only while a run is open. The database's own triggers are tested in
 * db/studio-validator.test.ts; here we check what the service starts, reuses, refuses
 * and accepts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ValidationCheckRow, ValidationRunRow } from '@/lib/studio/db'
import type { PurposeClassifier } from '@/lib/studio/validator/purpose'
import { STUDIO_VALIDATOR_RULESET } from '@/lib/studio/validator/ruleset'

vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/studio/context', () => ({ requireProfessor: vi.fn() }))
vi.mock('@/lib/studio/access', () => ({ studioAccess: vi.fn(), STUDIO_PAUSED: 'Studio is paused right now. Try again later.' }))
vi.mock('@/lib/auth/super-admin-context', () => ({ verifySuperAdmin: vi.fn() }))
vi.mock('@/lib/studio/validator/purpose-ai', () => ({ createPurposeClassifier: vi.fn() }))
vi.mock('@/lib/studio/validator/runtime-runner', () => ({ runnerMode: vi.fn(), runLocally: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({
  loadVersionSizes: vi.fn(),
  loadVersion: vi.fn(),
  loadVersionArtifact: vi.fn(),
  loadInstallation: vi.fn(),
  loadMinAcceptedRuleset: vi.fn(),
  listValidations: vi.fn(),
  loadValidation: vi.fn(),
  insertValidation: vi.fn(),
  insertValidationChecks: vi.fn(),
  startValidation: vi.fn(),
  finishValidation: vi.fn(),
  listValidationChecks: vi.fn(),
  listValidationReviews: vi.fn(),
  insertValidationReview: vi.fn(),
  listActiveCurrentVersions: vi.fn(),
}))

const db = await import('@/lib/studio/db')
const { requireProfessor } = await import('@/lib/studio/context')
const { studioAccess } = await import('@/lib/studio/access')
const { verifySuperAdmin } = await import('@/lib/auth/super-admin-context')
const { createPurposeClassifier } = await import('@/lib/studio/validator/purpose-ai')
const { runnerMode, runLocally } = await import('@/lib/studio/validator/runtime-runner')
const { logEvent } = await import('@/lib/supabase/event-logger')
const service = await import('@/lib/studio/validator/service')
const { artifactHash } = await import('@/lib/studio/validator/artifact')
const { GOOD, STATIC_BAD } = await import('@/lib/studio/validator/fixtures')
const { RUNTIME_CHECK_IDS } = await import('@/lib/studio/validator/ruleset')

const INSTITUTION = crypto.randomUUID()
const SECTION = crypto.randomUUID()
const VERSION = crypto.randomUUID()
const INSTALLATION = crypto.randomUUID()
const PROFESSOR = { userId: crypto.randomUUID(), sectionId: SECTION, institutionId: INSTITUTION }
const ADMIN = crypto.randomUUID()

const educational: PurposeClassifier = async (input) => ({
  ok: true,
  model: 'test-model',
  result: { verdict: 'educational', category: input.category, confidence: 0.97, reasons: [] },
})

/** The database, in memory. */
let runs: ValidationRunRow[]
let checks: (ValidationCheckRow & { validationId: string })[]
let artifact: typeof GOOD
let storedHash: string | null
let clock: number

const bytes = (s: string) => new TextEncoder().encode(s).length

function useArtifact(a: typeof GOOD, hash: string | null = artifactHash(a)) {
  artifact = a
  storedHash = hash
}

const goodReport = () => ({
  runner: { name: 'test-runner', version: '1.0.0' },
  browser: 'chromium test',
  checks: RUNTIME_CHECK_IDS.flatMap((id) => (['student', 'professor'] as const).map((view) => ({ id, view, status: 'passed', findings: [] }))),
})

beforeEach(() => {
  vi.clearAllMocks()
  runs = []
  checks = []
  // Runs are created "now", a second apart, so ordering is stable and none look abandoned.
  clock = Date.now() - 60_000
  useArtifact(GOOD)
  vi.mocked(createPurposeClassifier).mockReturnValue(educational)
  vi.mocked(runnerMode).mockReturnValue('unavailable')
  vi.mocked(requireProfessor).mockResolvedValue(PROFESSOR as never)
  vi.mocked(studioAccess).mockResolvedValue('full')
  vi.mocked(verifySuperAdmin).mockResolvedValue({ userId: ADMIN } as never)

  vi.mocked(db.loadVersionSizes).mockImplementation(async () => ({
    studentBytes: bytes(artifact.studentBundle),
    professorBytes: bytes(artifact.professorBundle),
    sourceBytes: Object.values(artifact.source).reduce((n, f) => n + bytes(f), 0),
    sourceFiles: Object.keys(artifact.source).length,
  }))
  vi.mocked(db.loadVersion).mockImplementation(async () => ({
    id: VERSION, projectId: 'p', institutionId: INSTITUTION, version: '1.0.0', bridgeVersion: 'v1', manifest: artifact.manifest, artifactSha256: storedHash,
  }))
  vi.mocked(db.loadVersionArtifact).mockImplementation(async () => ({
    id: VERSION, projectId: 'p', institutionId: INSTITUTION, publishedBy: PROFESSOR.userId, artifactSha256: storedHash, ...artifact,
  }))
  vi.mocked(db.loadInstallation).mockResolvedValue({
    id: INSTALLATION, institutionId: INSTITUTION, sectionId: SECTION, projectId: 'p', status: 'active', currentVersionId: VERSION, studentVisibility: 'hidden',
  })
  vi.mocked(db.loadMinAcceptedRuleset).mockResolvedValue(1)
  vi.mocked(db.listValidations).mockImplementation(async (v) =>
    runs.filter((r) => r.versionId === v).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  )
  vi.mocked(db.loadValidation).mockImplementation(async (id) => runs.find((r) => r.id === id) ?? null)
  vi.mocked(db.insertValidation).mockImplementation(async (row) => {
    if (runs.some((r) => r.versionId === row.versionId && r.stage === row.stage && (r.status === 'pending' || r.status === 'running'))) {
      return { ok: true, value: null }
    }
    const id = crypto.randomUUID()
    clock += 1000
    runs.push({
      id, versionId: row.versionId, institutionId: row.institutionId, stage: row.stage, status: row.status, artifactSha256: row.artifactSha256,
      rulesetVersion: row.rulesetVersion, callbackSha256: row.callbackSha256 ?? null, startedAt: null, createdAt: new Date(clock).toISOString(),
    })
    return { ok: true, value: id }
  })
  const open = (id: string) => runs.find((r) => r.id === id && (r.status === 'pending' || r.status === 'running'))
  vi.mocked(db.insertValidationChecks).mockImplementation(async (id, rows) => {
    if (!open(id)) return { ok: false, error: { code: '23514', message: 'closed' } }
    checks.push(...rows.map((r) => ({ ...r, validationId: id })))
    return { ok: true, value: null }
  })
  vi.mocked(db.startValidation).mockImplementation(async (id) => {
    const run = runs.find((r) => r.id === id && r.status === 'pending')
    if (run) run.status = 'running'
    return { ok: true, value: !!run }
  })
  vi.mocked(db.finishValidation).mockImplementation(async (id, result) => {
    const run = open(id)
    if (run) run.status = result.status
    return { ok: true, value: !!run }
  })
  vi.mocked(db.listValidationChecks).mockImplementation(async (ids) =>
    checks.filter((c) => ids.includes(c.validationId)).map((c) => ({ validationId: c.validationId, checkId: c.checkId, status: c.status, severity: c.severity, message: c.message })),
  )
  vi.mocked(db.listValidationReviews).mockResolvedValue([])
})

const verdict = () => service.currentVerdict(VERSION)

describe('Stage 1', () => {
  it('passes the known-good tool, records every static check, and then waits on the browser checks', async () => {
    const result = await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    expect(result).toMatchObject({ ok: true, status: 'passed', reused: false })
    expect(checks.every((c) => c.status === 'passed' || c.status === 'skipped')).toBe(true)
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'runtime_not_checked' })
  })

  it('reuses a finished run for the identical artifact instead of paying for it again', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    const again = await service.runStaticValidation(VERSION, 'retry', PROFESSOR.userId)
    expect(again).toMatchObject({ ok: true, reused: true, status: 'passed' })
    expect(runs).toHaveLength(1)
    expect(createPurposeClassifier).toHaveBeenCalledTimes(1)
  })

  it('fails a tool with a security finding', async () => {
    useArtifact(STATIC_BAD.find((f) => f.name === 'self-navigation')!.artifact)
    expect(await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)).toMatchObject({ status: 'failed' })
    expect(await verdict()).toEqual({ status: 'failed', reason: 'static_failed' })
  })

  it('refuses a version far past the size limits without loading its content', async () => {
    useArtifact({ ...GOOD, studentBundle: 'x'.repeat(256 * 1024 * 4 + 1) })
    expect(await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)).toMatchObject({ ok: true, status: 'failed' })
    expect(db.loadVersionArtifact).not.toHaveBeenCalled()
    expect(checks.find((c) => c.checkId === 'artifact.size')?.status).toBe('failed')
    expect(await verdict()).toEqual({ status: 'failed', reason: 'static_failed' })
  })

  it('ends as error, never a pass, when the checks themselves crash', async () => {
    vi.mocked(createPurposeClassifier).mockReturnValue(async () => {
      throw new Error('classifier exploded')
    })
    const result = await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    expect(result).toMatchObject({ ok: true, status: 'error' })
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'validator_error' })
  })

  it('an AI outage sends the purpose check to review; it never passes the tool', async () => {
    vi.mocked(createPurposeClassifier).mockReturnValue(async () => ({ ok: false, reason: 'unavailable' }))
    expect(await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)).toMatchObject({ status: 'needs_review' })
    expect(await verdict()).toMatchObject({ status: 'needs_review', checkIds: ['edtech.purpose'] })
  })

  it('expires a run abandoned mid-way, so it neither blocks a new run nor reads as checking forever', async () => {
    runs.push({
      id: crypto.randomUUID(), versionId: VERSION, institutionId: INSTITUTION, stage: 'static', status: 'running', artifactSha256: storedHash!,
      rulesetVersion: 1, callbackSha256: null, startedAt: null, createdAt: new Date(Date.now() - 16 * 60_000).toISOString(),
    })
    expect(await service.runStaticValidation(VERSION, 'retry', PROFESSOR.userId)).toMatchObject({ ok: true, status: 'passed', reused: false })
    expect(runs.map((r) => r.status).sort()).toEqual(['error', 'passed'])
  })
})

describe('the verdict reads the stored content, not the stored hash alone', () => {
  it('a version whose content no longer matches its hash fails, whatever its runs say', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    useArtifact({ ...GOOD, studentBundle: GOOD.studentBundle + '\n// changed' }, storedHash)
    expect(await verdict()).toEqual({ status: 'failed', reason: 'artifact_mismatch' })
  })

  it('a version published without a hash fails', async () => {
    useArtifact(GOOD, null)
    expect(await verdict()).toEqual({ status: 'failed', reason: 'artifact_mismatch' })
  })

  it('a minimum ruleset above the one a version was checked under withdraws its verdict', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(db.loadMinAcceptedRuleset).mockResolvedValue(STUDIO_VALIDATOR_RULESET + 1)
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'below_minimum_ruleset' })
  })

  it('unreadable settings or runs fail closed', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(db.loadMinAcceptedRuleset).mockResolvedValue(null)
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'settings_unavailable' })
    vi.mocked(db.listValidations).mockResolvedValue(null)
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'validator_error' })
  })
})

describe('Stage 2: asking for the browser checks', () => {
  const ask = () => service.requestRuntimeValidation({ sectionId: SECTION, installationId: INSTALLATION })

  it('only the section’s professor, and only for an installation in that section', async () => {
    vi.mocked(requireProfessor).mockResolvedValue(null)
    expect(await ask()).toEqual({ ok: false, error: expect.any(String) })
    vi.mocked(requireProfessor).mockResolvedValue(PROFESSOR as never)
    vi.mocked(db.loadInstallation).mockResolvedValue({
      id: INSTALLATION, institutionId: INSTITUTION, sectionId: crypto.randomUUID(), projectId: 'p', status: 'active', currentVersionId: VERSION, studentVisibility: 'hidden',
    })
    expect(await ask()).toEqual({ ok: false, error: expect.any(String) })
    expect(runs).toEqual([])
  })

  it.each([
    ['Studio is paused', () => vi.mocked(studioAccess).mockResolvedValue('off'), /paused/],
    ['the school isn’t entitled', () => vi.mocked(studioAccess).mockResolvedValue('read_only'), /./],
    ['the installation is archived', () => vi.mocked(db.loadInstallation).mockResolvedValue({
      id: INSTALLATION, institutionId: INSTITUTION, sectionId: SECTION, projectId: 'p', status: 'archived', currentVersionId: VERSION, studentVisibility: 'hidden',
    }), /./],
  ] as const)('refuses when %s, and runs nothing', async (_label, arrange, message) => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('local')
    arrange()
    expect(await ask()).toEqual({ ok: false, error: expect.stringMatching(message) })
    expect(runs.filter((r) => r.stage === 'runtime')).toEqual([])
    expect(runLocally).not.toHaveBeenCalled()
  })

  it('after a run ends in error, a retry within the cooldown is refused and starts nothing', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    expect(await ask()).toEqual({ ok: true, status: 'error' })
    expect(await ask()).toEqual({ ok: false, error: expect.stringMatching(/Try again in a minute/) })
    expect(runs.filter((r) => r.stage === 'runtime')).toHaveLength(1)
  })

  it('a local runner that stops without a report ends the run as error', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('local')
    vi.mocked(runLocally).mockResolvedValue(null)
    expect(await ask()).toEqual({ ok: true, status: 'running' })
    await vi.waitFor(() => expect(runs.find((r) => r.stage === 'runtime')?.status).toBe('error'))
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'runtime_error' })
  })

  it('refuses while Stage 1 hasn’t passed, after giving Stage 1 another try', async () => {
    useArtifact(STATIC_BAD.find((f) => f.name === 'eval')!.artifact)
    expect(await ask()).toEqual({ ok: false, error: expect.stringMatching(/automatic checks have to pass/) })
    expect(runs.map((r) => [r.stage, r.status])).toEqual([['static', 'failed']])
  })

  it('with no runner, records an error run and stays blocked', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    expect(await ask()).toEqual({ ok: true, status: 'error' })
    expect(runs.find((r) => r.stage === 'runtime')?.status).toBe('error')
    expect(runLocally).not.toHaveBeenCalled()
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'runtime_error' })
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'studio.validation.runtime_requested' }))
  })

  it('hands a local runner the artifact and a token, never storing the token itself', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('local')
    vi.mocked(runLocally).mockReturnValue(new Promise(() => {}))
    expect(await ask()).toEqual({ ok: true, status: 'running' })
    const job = vi.mocked(runLocally).mock.calls[0][0]
    const run = runs.find((r) => r.stage === 'runtime')!
    expect(job.artifact).toEqual({ manifest: GOOD.manifest, studentBundle: GOOD.studentBundle, professorBundle: GOOD.professorBundle })
    expect(run.callbackSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(run.callbackSha256).not.toBe(job.token)
  })
})

describe('Stage 2: the runner’s report', () => {
  async function openRuntimeRun() {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('local')
    vi.mocked(runLocally).mockReturnValue(new Promise(() => {}))
    await service.requestRuntimeValidation({ sectionId: SECTION, installationId: INSTALLATION })
    const { validationId, token } = vi.mocked(runLocally).mock.calls[0][0]
    return { validationId, token }
  }

  it('accepted with the run’s own token: the version passes', async () => {
    const { validationId, token } = await openRuntimeRun()
    expect(await service.submitRuntimeReport({ validationId, token, report: goodReport() })).toEqual({ ok: true, status: 'passed' })
    expect(await verdict()).toMatchObject({ status: 'passed' })
  })

  it('refused with a wrong token, and the run stays open', async () => {
    const { validationId, token } = await openRuntimeRun()
    expect(await service.submitRuntimeReport({ validationId, token: token.slice(0, -1) + 'x', report: goodReport() })).toEqual({ ok: false, reason: 'denied' })
    expect(runs.find((r) => r.id === validationId)?.status).toBe('pending')
  })

  it('refused when replayed: a token is good once', async () => {
    const { validationId, token } = await openRuntimeRun()
    await service.submitRuntimeReport({ validationId, token, report: goodReport() })
    const failing = { ...goodReport(), checks: goodReport().checks.map((c) => ({ ...c, status: 'failed' })) }
    expect(await service.submitRuntimeReport({ validationId, token, report: failing })).toEqual({ ok: false, reason: 'denied' })
    expect(await verdict()).toMatchObject({ status: 'passed' })
  })

  it('refused after the token expires, and the run ends as error', async () => {
    const { validationId, token } = await openRuntimeRun()
    runs.find((r) => r.id === validationId)!.createdAt = new Date(Date.now() - 16 * 60_000).toISOString()
    expect(await service.submitRuntimeReport({ validationId, token, report: goodReport() })).toEqual({ ok: false, reason: 'denied' })
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'runtime_error' })
  })

  it('a static run’s ID can’t be used to file a runtime report', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    expect(await service.submitRuntimeReport({ validationId: runs[0].id, token: 'x', report: goodReport() })).toEqual({ ok: false, reason: 'not_found' })
  })

  it('a report missing a check for one view is an error, never a pass', async () => {
    const { validationId, token } = await openRuntimeRun()
    const partial = { ...goodReport(), checks: goodReport().checks.filter((c) => !(c.id === 'runtime.accessibility' && c.view === 'professor')) }
    expect(await service.submitRuntimeReport({ validationId, token, report: partial })).toEqual({ ok: true, status: 'error' })
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'runtime_error' })
  })

  it('a report with fields the contract doesn’t have is refused as invalid', async () => {
    const { validationId, token } = await openRuntimeRun()
    expect(await service.submitRuntimeReport({ validationId, token, report: { ...goodReport(), verdict: 'passed' } })).toEqual({ ok: false, reason: 'invalid' })
    expect(runs.find((r) => r.id === validationId)?.status).toBe('error')
  })
})

describe('what the professor’s dialog is given', () => {
  it('after Stage 1 passes: no findings, and the browser checks can be asked for', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    expect(await service.validationSummary(VERSION)).toMatchObject({
      verdict: { status: 'unavailable', reason: 'runtime_not_checked' },
      stages: { static: { status: 'passed', findings: [] }, runtime: null },
      canRequestRuntime: true,
      runnerAvailable: false,
    })
  })

  it('after Stage 1 fails: the failing checks, and no browser checks', async () => {
    useArtifact(STATIC_BAD.find((f) => f.name === 'eval')!.artifact)
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    const summary = await service.validationSummary(VERSION)
    expect(summary?.canRequestRuntime).toBe(false)
    expect(summary?.stages.static?.findings).toEqual(expect.arrayContaining([expect.objectContaining({ checkId: 'code.dynamic_code', status: 'failed' })]))
  })
})

describe('check metadata stays within what the database stores', () => {
  it('trims findings to the byte budget, even in a multi-byte script', () => {
    const findings = Array.from({ length: 20 }, () => ({ view: 'student', line: 1, detail: '網'.repeat(80) }))
    const bounded = service.boundedMetadata({ findings })
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(3500)
    expect(bounded).toMatchObject({ truncated: true })
    expect((bounded.findings as unknown[]).length).toBeGreaterThan(0)
    expect(service.boundedMetadata({ findings: findings.slice(0, 2) })).toEqual({ findings: findings.slice(0, 2) })
  })
})

describe('reviews and revalidation are super-admin work', () => {
  it('a non-super-admin can’t resolve a review or revalidate', async () => {
    vi.mocked(verifySuperAdmin).mockResolvedValue({ error: 'Forbidden' } as never)
    const review = { validationId: crypto.randomUUID(), checkId: 'edtech.purpose', decision: 'approved' as const, reason: 'Fine.' }
    expect(await service.resolveValidationReview(review)).toEqual({ ok: false, error: expect.any(String) })
    expect(await service.revalidateCurrentVersions()).toEqual({ ok: false, error: expect.any(String) })
    expect(db.insertValidationReview).not.toHaveBeenCalled()
    expect(db.listActiveCurrentVersions).not.toHaveBeenCalled()
  })

  it('revalidation re-runs Stage 1 for one page of current versions, counts only new runs, and pages on', async () => {
    vi.mocked(db.listActiveCurrentVersions).mockResolvedValue({ versions: [{ versionId: VERSION, institutionId: INSTITUTION }], installations: 1 })
    expect(await service.revalidateCurrentVersions(1)).toEqual({ ok: true, checked: 1, next: 1 })
    expect(vi.mocked(db.insertValidation).mock.calls[0][0]).toMatchObject({ trigger: 'ruleset_change', requestedBy: ADMIN })
    // Already checked under this ruleset: reused, not counted.
    expect(await service.revalidateCurrentVersions(5)).toEqual({ ok: true, checked: 0, next: null })
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'studio.validation.revalidated' }))
  })

  it('revalidation clamps the page size', async () => {
    vi.mocked(db.listActiveCurrentVersions).mockResolvedValue({ versions: [], installations: 0 })
    await service.revalidateCurrentVersions(0)
    await service.revalidateCurrentVersions(10_000, 400)
    expect(vi.mocked(db.listActiveCurrentVersions).mock.calls).toEqual([[1, 0], [200, 400]])
  })

  it('a super admin’s review is saved under their own ID, and logged', async () => {
    vi.mocked(db.insertValidationReview).mockResolvedValue({ ok: true, value: null })
    const review = { validationId: crypto.randomUUID(), checkId: 'edtech.purpose', decision: 'rejected' as const, reason: 'Not a course tool.' }
    expect(await service.resolveValidationReview(review)).toEqual({ ok: true })
    expect(db.insertValidationReview).toHaveBeenCalledWith({ ...review, reviewerId: ADMIN })
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'studio.validation.review_rejected', userId: ADMIN }))
  })
})
