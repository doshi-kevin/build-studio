/**
 * The validator's trusted service (validator/service.ts) over an in-memory stand-in for
 * db.ts that keeps the rules the database enforces: one active run per version and
 * stage, results only while a run is open. The database's own triggers are tested in
 * db/studio-validator.test.ts; here we check what the service starts, reuses, refuses
 * and accepts.
 */
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ValidationCheckRow, ValidationRunRow } from '@/lib/studio/db'
import type { PurposeClassifier } from '@/lib/studio/validator/purpose'
import { STUDIO_VALIDATOR_RULESET } from '@/lib/studio/validator/ruleset'

vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/studio/context', () => ({ requireProfessor: vi.fn() }))
vi.mock('@/lib/studio/access', () => ({ studioAccess: vi.fn(), STUDIO_PAUSED: 'Studio is paused right now. Try again later.' }))
vi.mock('@/lib/auth/super-admin-context', () => ({ verifySuperAdmin: vi.fn() }))
vi.mock('@/lib/studio/validator/purpose-ai', () => ({ createPurposeClassifier: vi.fn() }))
vi.mock('@/lib/jobs/enqueue', () => ({ enqueueJob: vi.fn() }))
vi.mock('@/lib/email', () => ({ sendStudioReviewWaiting: vi.fn() }))
vi.mock('@/lib/studio/validator/runtime-runner', async (importActual) => ({
  runnerMode: vi.fn(),
  runLocally: vi.fn(),
  buildPayload: (await importActual<typeof import('@/lib/studio/validator/runtime-runner')>()).buildPayload,
}))
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
  listValidationReviewDetails: vi.fn(),
  admitRuntimeRun: vi.fn(),
  dispatchValidation: vi.fn(),
  purposeAdmit: vi.fn(),
  loadLatestPurposeOutcome: vi.fn(),
  listInstitutionCurrentVersions: vi.fn(),
  listInstitutionsWithInstallations: vi.fn(),
  listSuperAdminEmails: vi.fn(),
  loadInstitutionNames: vi.fn(),
  revalidationProgress: vi.fn(),
  countReviewQueue: vi.fn(),
  listReviewQueue: vi.fn(),
  loadProjectCourses: vi.fn(),
}))

const db = await import('@/lib/studio/db')
const { requireProfessor } = await import('@/lib/studio/context')
const { studioAccess } = await import('@/lib/studio/access')
const { verifySuperAdmin } = await import('@/lib/auth/super-admin-context')
const { createPurposeClassifier } = await import('@/lib/studio/validator/purpose-ai')
const { runnerMode, runLocally } = await import('@/lib/studio/validator/runtime-runner')
const { logEvent } = await import('@/lib/supabase/event-logger')
const { enqueueJob } = await import('@/lib/jobs/enqueue')
const { sendStudioReviewWaiting } = await import('@/lib/email')
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
/** What studio_runtime_admit answers when it isn't 'admitted' or 'exists'. */
let admitRefusal: 'busy' | 'daily' | 'global_busy' | null

const bytes = (s: string) => new TextEncoder().encode(s).length
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

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
  admitRefusal = null
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
    runs.push(runRow({ id, versionId: row.versionId, stage: row.stage, status: row.status, artifactSha256: row.artifactSha256, rulesetVersion: row.rulesetVersion, callbackSha256: row.callbackSha256 ?? null }))
    return { ok: true, value: id }
  })
  vi.mocked(db.admitRuntimeRun).mockImplementation(async (row) => {
    if (runs.some((r) => r.versionId === row.versionId && r.stage === 'runtime' && (r.status === 'pending' || r.status === 'running'))) return { outcome: 'exists' }
    if (admitRefusal) return { outcome: admitRefusal }
    const id = crypto.randomUUID()
    clock += 1000
    runs.push(runRow({ id, versionId: row.versionId, stage: 'runtime', status: 'pending', artifactSha256: row.artifactSha256, rulesetVersion: row.rulesetVersion, callbackSha256: row.callbackSha256, trigger: row.trigger }))
    return { outcome: 'admitted', id }
  })
  vi.mocked(db.dispatchValidation).mockImplementation(async (id, mode, payloadSha256, execution, image, callbackSha256) => {
    const run = runs.find((r) => r.id === id && r.stage === 'runtime' && r.status === 'pending' && r.runnerMode === null)
    if (!run || (!run.callbackSha256 && !callbackSha256)) return false
    Object.assign(run, { runnerMode: mode, payloadSha256, executionName: execution, runnerImage: image, callbackSha256: run.callbackSha256 ?? callbackSha256, status: 'running' })
    return true
  })
  vi.mocked(db.purposeAdmit).mockResolvedValue(true)
  vi.mocked(db.loadLatestPurposeOutcome).mockResolvedValue(null)
  vi.mocked(enqueueJob).mockResolvedValue({ jobId: crypto.randomUUID(), alreadyActive: false, kicked: true })
  vi.mocked(db.listSuperAdminEmails).mockResolvedValue(['reviewer@scholera.test'])
  vi.mocked(db.loadInstitutionNames).mockResolvedValue({ [INSTITUTION]: 'Test University' })
  vi.mocked(sendStudioReviewWaiting).mockResolvedValue(true)
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
  vi.mocked(db.listValidationReviewDetails).mockResolvedValue([])
})

/** A stored run with the columns the tests don't care about filled in. */
function runRow(r: Pick<ValidationRunRow, 'id' | 'versionId' | 'stage' | 'status' | 'artifactSha256' | 'rulesetVersion' | 'callbackSha256'> & Partial<ValidationRunRow>): ValidationRunRow {
  return {
    institutionId: INSTITUTION, startedAt: null, createdAt: new Date(clock).toISOString(), runtimeVersion: 'v1', trigger: 'publish',
    runnerMode: null, payloadSha256: null, executionName: null, runnerImage: null, ...r,
  }
}

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

  it('over the school’s daily classifier quota, the purpose check goes to review without calling the classifier', async () => {
    vi.mocked(db.purposeAdmit).mockResolvedValue(false)
    expect(await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)).toMatchObject({ status: 'needs_review' })
    expect(createPurposeClassifier).not.toHaveBeenCalled()
    expect(await verdict()).toMatchObject({ status: 'needs_review', checkIds: ['edtech.purpose'] })
    // An unreadable quota fails the same way, never as a pass.
    vi.mocked(db.purposeAdmit).mockResolvedValue(null)
    expect(await service.runStaticValidation(crypto.randomUUID(), 'publish', PROFESSOR.userId)).toMatchObject({ status: 'needs_review' })
    expect(createPurposeClassifier).not.toHaveBeenCalled()
  })

  it('expires a run abandoned mid-way, so it neither blocks a new run nor reads as checking forever', async () => {
    runs.push(runRow({
      id: crypto.randomUUID(), versionId: VERSION, stage: 'static', status: 'running', artifactSha256: storedHash!,
      rulesetVersion: 1, callbackSha256: null, createdAt: new Date(Date.now() - 16 * 60_000).toISOString(),
    }))
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

  it('hands a local runner the payload, recording its hash and only the nonce’s hash', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('local')
    vi.mocked(runLocally).mockReturnValue(new Promise(() => {}))
    expect(await ask()).toEqual({ ok: true, status: 'running' })
    const [validationId, bytes] = vi.mocked(runLocally).mock.calls[0]
    const payload = JSON.parse(bytes)
    const run = runs.find((r) => r.stage === 'runtime')!
    expect(validationId).toBe(run.id)
    expect(payload).toMatchObject({ validationId: run.id, manifest: GOOD.manifest, studentBundle: GOOD.studentBundle, professorBundle: GOOD.professorBundle })
    expect(run).toMatchObject({ runnerMode: 'local', status: 'running', payloadSha256: sha256(bytes), callbackSha256: sha256(payload.nonce) })
    expect(JSON.stringify(run)).not.toContain(payload.nonce)
  })

  it('in cloud mode, queues one dispatch job carrying only the run’s id', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('cloud')
    expect(await ask()).toEqual({ ok: true, status: 'running' })
    const run = runs.find((r) => r.stage === 'runtime')!
    expect(enqueueJob).toHaveBeenCalledWith({
      type: 'studio_validator_runtime', institutionId: INSTITUTION, params: { validationId: run.id }, createdBy: PROFESSOR.userId, subjectKey: run.id,
    })
    // The nonce is created by the dispatcher, so nothing about it exists yet.
    expect(run).toMatchObject({ status: 'pending', runnerMode: null, callbackSha256: null })
    expect(runLocally).not.toHaveBeenCalled()
  })

  it('in cloud mode, a queue failure ends the run as error instead of leaving it pending', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('cloud')
    vi.mocked(enqueueJob).mockRejectedValue(new Error('down'))
    expect(await ask()).toEqual({ ok: true, status: 'error' })
    expect(runs.find((r) => r.stage === 'runtime')?.status).toBe('error')
  })

  it.each([
    ['busy', /already running for your school/],
    ['daily', /used today/],
    ['global_busy', /busy right now/],
  ] as const)('over a quota (%s), says so and starts nothing', async (outcome, message) => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('local')
    admitRefusal = outcome
    expect(await ask()).toEqual({ ok: false, error: expect.stringMatching(message) })
    expect(runs.filter((r) => r.stage === 'runtime')).toEqual([])
    expect(runLocally).not.toHaveBeenCalled()
  })

  it('a professor’s request uses the professor lane; the system entry point uses the system lane', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('local')
    vi.mocked(runLocally).mockReturnValue(new Promise(() => {}))
    await ask()
    expect(vi.mocked(db.admitRuntimeRun).mock.calls[0][0]).toMatchObject({ lane: 'professor', trigger: 'professor' })
    runs.find((r) => r.stage === 'runtime')!.status = 'error'
    runs.find((r) => r.stage === 'runtime')!.createdAt = new Date(Date.now() - 120_000).toISOString()
    await service.requestRuntimeValidationAsSystem(INSTALLATION, ADMIN)
    expect(vi.mocked(db.admitRuntimeRun).mock.calls[1][0]).toMatchObject({ lane: 'system', trigger: 'ruleset_change', requestedBy: ADMIN })
  })

  it('a version below the minimum ruleset can be recovered: asking again re-runs Stage 1 first', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    runs[0].rulesetVersion = STUDIO_VALIDATOR_RULESET - 1
    runs[0].createdAt = new Date(Date.now() - 120_000).toISOString()
    vi.mocked(db.loadMinAcceptedRuleset).mockResolvedValue(STUDIO_VALIDATOR_RULESET)
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'below_minimum_ruleset' })
    expect(await ask()).toEqual({ ok: true, status: 'error' })
    expect(runs.map((r) => [r.stage, r.status, r.rulesetVersion])).toEqual([
      ['static', 'passed', STUDIO_VALIDATOR_RULESET - 1],
      ['static', 'passed', STUDIO_VALIDATOR_RULESET],
      ['runtime', 'error', STUDIO_VALIDATOR_RULESET],
    ])
  })
})

describe('Stage 2: the runner’s report', () => {
  async function openRuntimeRun() {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('local')
    vi.mocked(runLocally).mockReturnValue(new Promise(() => {}))
    await service.requestRuntimeValidation({ sectionId: SECTION, installationId: INSTALLATION })
    const [validationId, bytes] = vi.mocked(runLocally).mock.calls[0]
    const nonce = JSON.parse(bytes).nonce as string
    const envelope = (report: unknown = goodReport(), binding: Record<string, unknown> = {}) => ({
      binding: { validationId, nonce, payloadSha256: sha256(bytes), runtimeVersion: 'v1', ...binding },
      report,
    })
    return { validationId, nonce, envelope }
  }
  const submit = (token: string, envelope: unknown) => service.submitRuntimeReport({ token, envelope })

  it('accepted when bound to this run, its nonce and its exact payload: the version passes', async () => {
    const { nonce, envelope } = await openRuntimeRun()
    expect(await submit(nonce, envelope())).toEqual({ ok: true, status: 'passed' })
    expect(await verdict()).toMatchObject({ status: 'passed' })
  })

  it('a bearer token that isn’t the envelope’s nonce is refused, and the run stays open', async () => {
    const { validationId, nonce, envelope } = await openRuntimeRun()
    expect(await submit(nonce.slice(0, -1) + (nonce.endsWith('x') ? 'y' : 'x'), envelope())).toEqual({ ok: false, reason: 'denied' })
    expect(runs.find((r) => r.id === validationId)?.status).toBe('running')
  })

  it.each([
    ['another nonce', () => ({ nonce: 'A'.repeat(43) })],
    ['another payload', () => ({ payloadSha256: 'f'.repeat(64) })],
  ])('a forged envelope (%s) ends the run as error, never a pass', async (_label, forged) => {
    const { validationId, envelope } = await openRuntimeRun()
    const bad = envelope(goodReport(), forged())
    expect(await submit(bad.binding.nonce, bad)).toEqual({ ok: false, reason: 'denied' })
    expect(runs.find((r) => r.id === validationId)?.status).toBe('error')
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'runtime_error' })
  })

  it('a report bound to another run is refused', async () => {
    const { nonce, envelope } = await openRuntimeRun()
    expect(await submit(nonce, envelope(goodReport(), { validationId: crypto.randomUUID() }))).toEqual({ ok: false, reason: 'not_found' })
  })

  it('refused when replayed: a run takes one report', async () => {
    const { nonce, envelope } = await openRuntimeRun()
    await submit(nonce, envelope())
    const failing = { ...goodReport(), checks: goodReport().checks.map((c) => ({ ...c, status: 'failed' })) }
    expect(await submit(nonce, envelope(failing))).toEqual({ ok: false, reason: 'denied' })
    expect(await verdict()).toMatchObject({ status: 'passed' })
  })

  it('refused after the window closes, and the run ends as error', async () => {
    const { validationId, nonce, envelope } = await openRuntimeRun()
    runs.find((r) => r.id === validationId)!.createdAt = new Date(Date.now() - 16 * 60_000).toISOString()
    expect(await submit(nonce, envelope())).toEqual({ ok: false, reason: 'denied' })
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'runtime_error' })
  })

  it('the HTTP path is closed unless the runner mode is local, even with a valid envelope', async () => {
    const { validationId, nonce, envelope } = await openRuntimeRun()
    vi.mocked(runnerMode).mockReturnValue('cloud')
    expect(await submit(nonce, envelope())).toEqual({ ok: false, reason: 'denied' })
    expect(runs.find((r) => r.id === validationId)?.status).toBe('running')
  })

  it('a binding that names another run is refused even with this run’s nonce and payload', async () => {
    const { validationId, envelope } = await openRuntimeRun()
    expect(await service.finishRuntimeRun(validationId, envelope(goodReport(), { validationId: crypto.randomUUID() }), 'local')).toEqual({ ok: false, reason: 'denied' })
    expect(runs.find((r) => r.id === validationId)?.status).toBe('error')
  })

  it('a locally dispatched run can’t be finished through the cloud path', async () => {
    const { validationId, envelope } = await openRuntimeRun()
    expect(await service.finishRuntimeRun(validationId, envelope(), 'cloud')).toEqual({ ok: false, reason: 'denied' })
    expect(runs.find((r) => r.id === validationId)?.status).toBe('running')
  })

  it('a static run’s ID can’t be used to file a runtime report', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('local')
    const nonce = 'n'.repeat(43)
    const envelope = { binding: { validationId: runs[0].id, nonce, payloadSha256: '0'.repeat(64), runtimeVersion: 'v1' }, report: goodReport() }
    expect(await submit(nonce, envelope)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('a report missing a check for one view is an error, never a pass', async () => {
    const { nonce, envelope } = await openRuntimeRun()
    const partial = { ...goodReport(), checks: goodReport().checks.filter((c) => !(c.id === 'runtime.accessibility' && c.view === 'professor')) }
    expect(await submit(nonce, envelope(partial))).toEqual({ ok: true, status: 'error' })
    expect(await verdict()).toEqual({ status: 'unavailable', reason: 'runtime_error' })
  })

  it('a report with fields the contract doesn’t have is refused as invalid', async () => {
    const { validationId, nonce, envelope } = await openRuntimeRun()
    expect(await submit(nonce, envelope({ ...goodReport(), verdict: 'passed' }))).toEqual({ ok: false, reason: 'invalid' })
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

describe('reviews are super-admin work, bound to what the reviewer saw', () => {
  const reviewOf = (validationId: string, decision: 'approved' | 'rejected' = 'approved') => ({
    validationId, checkId: 'edtech.purpose', artifactSha256: storedHash!, decision, reason: 'Checked by hand.',
  })
  async function flaggedRun() {
    vi.mocked(createPurposeClassifier).mockReturnValue(async () => ({ ok: false, reason: 'unavailable' }))
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    return runs[0].id
  }

  it('a non-super-admin can’t resolve a review', async () => {
    vi.mocked(verifySuperAdmin).mockResolvedValue({ error: 'Forbidden' } as never)
    expect(await service.resolveValidationReview(reviewOf(await flaggedRun()))).toEqual({ ok: false, error: expect.any(String) })
    expect(db.insertValidationReview).not.toHaveBeenCalled()
  })

  it('a super admin’s review is saved under their own ID, and logged', async () => {
    vi.mocked(db.insertValidationReview).mockResolvedValue({ ok: true, value: null })
    const review = reviewOf(await flaggedRun(), 'rejected')
    expect(await service.resolveValidationReview(review)).toEqual({ ok: true })
    expect(db.insertValidationReview).toHaveBeenCalledWith({
      validationId: review.validationId, checkId: review.checkId, decision: review.decision, reason: review.reason, reviewerId: ADMIN,
    })
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'studio.validation.review_rejected', userId: ADMIN }))
  })

  it('refused when the flagged run judged other content than the reviewer was shown', async () => {
    const id = await flaggedRun()
    runs[0].artifactSha256 = 'b'.repeat(64)
    expect(await service.resolveValidationReview(reviewOf(id))).toEqual({ ok: false, error: expect.stringMatching(/changed/) })
    expect(db.insertValidationReview).not.toHaveBeenCalled()
  })

  it('refused when the content changed after the reviewer loaded it', async () => {
    const id = await flaggedRun()
    expect(await service.resolveValidationReview({ ...reviewOf(id), artifactSha256: 'a'.repeat(64) })).toEqual({ ok: false, error: expect.stringMatching(/changed/) })
    expect(db.insertValidationReview).not.toHaveBeenCalled()
  })

  it('the professor’s dialog shows the reviewer’s decision and reason, and the stage follows it', async () => {
    const id = await flaggedRun()
    vi.mocked(db.listValidationReviewDetails).mockResolvedValue([{ validationId: id, checkId: 'edtech.purpose', decision: 'rejected', reason: 'Not a course tool.' }])
    const summary = await service.validationSummary(VERSION)
    expect(summary?.stages.static).toMatchObject({
      status: 'failed',
      findings: [expect.objectContaining({ checkId: 'edtech.purpose', review: { decision: 'rejected', reason: 'Not a course tool.' } })],
    })
  })
})

describe('revalidation after the minimum is raised', () => {
  const page = (rows: { visible: boolean }[]) => ({ rows: rows.map((r) => ({ installationId: INSTALLATION, versionId: VERSION, visible: r.visible })), installations: rows.length })
  const below = () => {
    runs[0].rulesetVersion = STUDIO_VALIDATOR_RULESET - 1
    vi.mocked(db.loadMinAcceptedRuleset).mockResolvedValue(STUDIO_VALIDATOR_RULESET)
  }

  it('re-runs Stage 1 as a ruleset change and reuses the earlier purpose answer instead of calling the classifier', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    below()
    vi.mocked(db.loadLatestPurposeOutcome).mockResolvedValue({ status: 'passed', message: '', metadata: { verdict: 'educational', confidence: 0.97, category: (GOOD.manifest as { purpose: { category: string } }).purpose.category }, aiModel: 'test-model' })
    vi.mocked(db.listInstitutionCurrentVersions).mockResolvedValue(page([{ visible: false }]))
    expect(await service.revalidateInstitutionPage(INSTITUTION, ADMIN, 0)).toEqual({ next: null, checked: 1, waiting: false })
    expect(runs[1]).toMatchObject({ stage: 'static', status: 'passed', rulesetVersion: STUDIO_VALIDATOR_RULESET })
    expect(vi.mocked(db.insertValidation).mock.calls[1][0]).toMatchObject({ trigger: 'ruleset_change', requestedBy: ADMIN })
    expect(createPurposeClassifier).toHaveBeenCalledTimes(1)
    // A hidden tool gets no browser checks from revalidation.
    expect(db.admitRuntimeRun).not.toHaveBeenCalled()
  })

  it('over the classifier quota, stops where it was without recording anything as needing review', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    below()
    vi.mocked(db.purposeAdmit).mockResolvedValue(false)
    vi.mocked(db.listInstitutionCurrentVersions).mockResolvedValue(page([{ visible: true }]))
    expect(await service.revalidateInstitutionPage(INSTITUTION, ADMIN, 25)).toEqual({ next: 25, checked: 0, waiting: true })
    expect(runs).toHaveLength(1)
  })

  it('takes one classifier slot per re-checked tool, not two', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    below()
    vi.mocked(db.purposeAdmit).mockClear()
    vi.mocked(db.listInstitutionCurrentVersions).mockResolvedValue(page([{ visible: false }]))
    await service.revalidateInstitutionPage(INSTITUTION, ADMIN, 0)
    expect(db.purposeAdmit).toHaveBeenCalledTimes(1)
  })

  it('asks for browser checks for visible tools in the system lane, and waits when that lane is full', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    vi.mocked(runnerMode).mockReturnValue('local')
    admitRefusal = 'busy'
    vi.mocked(db.listInstitutionCurrentVersions).mockResolvedValue(page([{ visible: true }]))
    expect(await service.revalidateInstitutionPage(INSTITUTION, ADMIN, 0)).toEqual({ next: 0, checked: 0, waiting: true })
    expect(vi.mocked(db.admitRuntimeRun).mock.calls[0][0]).toMatchObject({ lane: 'system' })
  })

  it('pages on while a page is full', async () => {
    vi.mocked(db.listInstitutionCurrentVersions).mockResolvedValue({ rows: [], installations: 25 })
    expect(await service.revalidateInstitutionPage(INSTITUTION, ADMIN, 0)).toEqual({ next: 25, checked: 0, waiting: false })
  })
})

describe('telling reviewers a check is waiting', () => {
  it('emails once, when the run closes as needs_review, naming the tool and school only', async () => {
    vi.mocked(createPurposeClassifier).mockReturnValue(async () => ({ ok: false, reason: 'unavailable' }))
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    await vi.waitFor(() => expect(sendStudioReviewWaiting).toHaveBeenCalledTimes(1))
    expect(sendStudioReviewWaiting).toHaveBeenCalledWith(['reviewer@scholera.test'], { pluginName: 'Exit ticket', institution: 'Test University' })
    // The same artifact again reuses the run: no second email.
    await service.runStaticValidation(VERSION, 'retry', PROFESSOR.userId)
    expect(sendStudioReviewWaiting).toHaveBeenCalledTimes(1)
  })

  it('a run someone else already closed emails no one, so one validation is one email', async () => {
    vi.mocked(createPurposeClassifier).mockReturnValue(async () => ({ ok: false, reason: 'unavailable' }))
    vi.mocked(db.finishValidation).mockResolvedValueOnce({ ok: true, value: false })
    // The decision to email is made before runStaticValidation returns; nothing is pending after it.
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    expect(db.listSuperAdminEmails).not.toHaveBeenCalled()
    expect(sendStudioReviewWaiting).not.toHaveBeenCalled()
  })

  it('a run that passes or fails emails no one', async () => {
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    useArtifact(STATIC_BAD.find((f) => f.name === 'eval')!.artifact)
    await service.runStaticValidation(VERSION, 'publish', PROFESSOR.userId)
    expect(sendStudioReviewWaiting).not.toHaveBeenCalled()
  })
})

describe('the super admin’s validator controls', () => {
  it('the panel and the review count are for super admins only', async () => {
    vi.mocked(verifySuperAdmin).mockResolvedValue({ error: 'Forbidden' } as never)
    expect(await service.getValidatorPanel()).toBeNull()
    expect(await service.countWaitingReviews()).toBeNull()
    expect(await service.getReviewQueue()).toBeNull()
    expect(db.countReviewQueue).not.toHaveBeenCalled()
  })

  it('the panel shows the code’s ruleset, the accepted minimum and the re-check progress', async () => {
    vi.mocked(db.revalidationProgress).mockResolvedValue({ active: 3, waiting: 1 })
    vi.mocked(db.countReviewQueue).mockResolvedValue(2)
    expect(await service.getValidatorPanel()).toEqual({ codeRuleset: STUDIO_VALIDATOR_RULESET, minAccepted: 1, revalidating: 3, waitingOnCapacity: 1, reviewsWaiting: 2 })
  })

  it('the review queue shows the source of the view that was flagged, none for the purpose check, and marks the reviewer’s own versions', async () => {
    const item = (checkId: string, views: string[], publishedBy: string | null) => ({
      validationId: crypto.randomUUID(), checkId, message: 'flagged', findings: views.map((view) => ({ view, detail: 'x' })), stage: 'static' as const, trigger: 'publish',
      createdAt: new Date().toISOString(), versionId: VERSION, version: '1.0.0', artifactSha256: storedHash!, manifest: GOOD.manifest,
      publishedBy, institutionId: INSTITUTION, projectId: 'p',
    })
    vi.mocked(db.listReviewQueue).mockResolvedValue([
      item('security.navigation', ['professor'], PROFESSOR.userId),
      item('security.navigation', ['professor', 'student'], ADMIN),
      item('edtech.purpose', [], PROFESSOR.userId),
    ])
    vi.mocked(db.loadProjectCourses).mockResolvedValue({ p: ['BIO 101'] })
    const queue = await service.getReviewQueue()
    expect(queue?.map((q) => [q.source?.view ?? null, q.source?.text, q.publishedByYou])).toEqual([
      ['professor', GOOD.source['views/professor.tsx'], false],
      ['student', GOOD.source['views/student.tsx'], true],
      [null, undefined, false],
    ])
    expect(queue?.[0]).toMatchObject({ institution: 'Test University', courses: ['BIO 101'] })
    // The purpose check never loads the tool's code.
    expect(db.loadVersionArtifact).toHaveBeenCalledTimes(2)
  })

  it('reports a partly failed queueing as a failure, so the super admin is offered a retry', async () => {
    vi.mocked(db.listInstitutionsWithInstallations).mockResolvedValue([INSTITUTION, crypto.randomUUID()])
    vi.mocked(enqueueJob).mockResolvedValueOnce({ jobId: 'j', alreadyActive: false, kicked: true }).mockRejectedValueOnce(new Error('down'))
    expect(await service.enqueueRevalidation(ADMIN, 2)).toBeNull()
  })

  it('queues one revalidation job per institution with tools, as the super admin, from the start', async () => {
    const other = crypto.randomUUID()
    vi.mocked(db.listInstitutionsWithInstallations).mockResolvedValue([INSTITUTION, other])
    expect(await service.enqueueRevalidation(ADMIN, 2)).toBe(2)
    expect(vi.mocked(enqueueJob).mock.calls.map((c) => c[0])).toEqual([INSTITUTION, other].map((institutionId) => ({
      type: 'studio_validator_revalidate', institutionId, params: { offset: 0, minRuleset: 2 }, createdBy: ADMIN, subjectKey: 'revalidate',
    })))
  })
})
