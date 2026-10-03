/**
 * Step 6 against a real database (`npm run test:db`): the pre-publish validator's tables
 * and the whole path from publishing to showing students a tool.
 *
 *   publish → Stage 1 runs and records every static check
 *   → the professor asks for the browser checks → a runtime run with a callback token
 *   → the runner reports through the real route, once → the verdict passes
 *   → each skill slot is bound → the tool can be shown.
 *
 * Mocked, and only these:
 *   - the session cookie, to act as a chosen fixture user;
 *   - logEvent and revalidatePath;
 *   - the purpose check's model (a fixed classifier), so no model is called;
 *   - the runner: the job is captured instead of launching a browser, and the test
 *     reports as the runner would. The runner itself is tested in e2e/studio-validator;
 *   - verifySuperAdmin, which reads the session through a client this test doesn't build.
 * The validator service, lifecycle, visibility, skill bindings, the report route and db.ts
 * are real.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOD, STATIC_BAD, type FixtureArtifact } from '@/lib/studio/validator/fixtures'
import { RUNTIME_CHECK_IDS, STUDIO_VALIDATOR_RULESET, checksFor } from '@/lib/studio/validator/ruleset'
import type { PurposeClassifier } from '@/lib/studio/validator/purpose'
import { dbEnv } from './env'
import { FIXTURE } from './fixture'
import { grantStudio } from './studio-entitlement'

const session: { userId: string | null } = { userId: null }
/** What the local runner was handed: the run, the exact payload bytes, and the nonce inside them. */
interface RuntimeJob {
  validationId: string
  bytes: string
  nonce: string
}
const harness = vi.hoisted(() => ({
  jobs: [] as RuntimeJob[],
  classify: null as PurposeClassifier | null,
  superAdmin: null as string | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null } }) },
  }),
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/studio/validator/purpose-ai', () => ({ createPurposeClassifier: () => harness.classify }))
vi.mock('@/lib/studio/validator/runtime-runner', async (importActual) => ({
  runnerMode: () => 'local',
  buildPayload: (await importActual<typeof import('@/lib/studio/validator/runtime-runner')>()).buildPayload,
  runLocally: (validationId: string, bytes: string) => {
    harness.jobs.push({ validationId, bytes, nonce: JSON.parse(bytes).nonce })
    return new Promise(() => {})
  },
}))
vi.mock('@/lib/auth/super-admin-context', () => ({
  verifySuperAdmin: async () => (harness.superAdmin && session.userId === harness.superAdmin ? { userId: harness.superAdmin } : { error: 'Forbidden' }),
}))

const lifecycle = await import('@/lib/studio/lifecycle')
const visibility = await import('@/lib/studio/student-visibility')
const service = await import('@/lib/studio/validator/service')
const studioDb = await import('@/lib/studio/db')
const { PURPOSE_RUBRIC_VERSION } = await import('@/lib/studio/validator/purpose')
const { bindSkillSlot } = await import('@/lib/studio/skill-bindings')
const { POST } = await import('@/app/api/studio/validator/runtime-report/route')

const A = FIXTURE.a
const PROFESSOR = A.users.professor.id
const OTHER_INSTITUTION = FIXTURE.b.institution
const run = `t${randomBytes(4).toString('hex')}`

let db: Client
let restoreEntitlement: (() => Promise<void>) | undefined
let section = ''
let otherSection = ''
const projects: string[] = []

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(text, params)).rows as T[]
}

const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error)
  return r.value
}

const educational: PurposeClassifier = async (input) => ({
  ok: true,
  model: 'test-model',
  result: { verdict: 'educational', category: input.category, confidence: 0.97, reasons: [] },
})

/** A new project with one published version of `artifact`, installed and hidden. */
async function publish(tag: string, artifact: FixtureArtifact = GOOD) {
  session.userId = PROFESSOR
  const slug = `val-${tag}-${run}`
  const project = ok(await lifecycle.createProject({ sectionId: section, slug, name: `Validator ${tag}` }))
  projects.push(project)
  const version = ok(
    await lifecycle.publishVersion({
      sectionId: section,
      projectId: project,
      manifest: { ...artifact.manifest, id: slug },
      source: artifact.source,
      studentBundle: artifact.studentBundle,
      professorBundle: artifact.professorBundle,
    }),
  )
  const installation = ok(await lifecycle.installPlugin({ sectionId: section, versionId: version }))
  return { project, version, installation }
}

const runsOf = (version: string) =>
  sql<{ id: string; stage: string; status: string; artifact_sha256: string; callback_sha256: string | null; ai_model: string | null }>(
    'select id, stage, status, artifact_sha256, callback_sha256, ai_model from public.studio_plugin_validations where version_id = $1 order by created_at',
    [version],
  )

const goodReport = () => ({
  runner: { name: 'db-test-runner', version: '1.0.0' },
  browser: 'chromium (db test)',
  checks: RUNTIME_CHECK_IDS.flatMap((id) => (['student', 'professor'] as const).map((view) => ({ id, view, status: 'passed', findings: [] }))),
})

/** Reports for a runtime run exactly as the local runner does: the nonce as bearer token,
 * and the envelope binding the report to the run, the nonce and the payload's hash. */
const report = (job: RuntimeJob, body: unknown = goodReport(), token = job.nonce, binding: Record<string, unknown> = {}) =>
  POST(
    new Request('http://localhost:3000/api/studio/validator/runtime-report', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        binding: { validationId: job.validationId, nonce: job.nonce, payloadSha256: createHash('sha256').update(job.bytes).digest('hex'), runtimeVersion: 'v1', ...binding },
        report: body,
      }),
    }),
  )

async function askForBrowserChecks(installation: string): Promise<RuntimeJob> {
  session.userId = PROFESSOR
  const before = harness.jobs.length
  expect(await service.requestRuntimeValidation({ sectionId: section, installationId: installation })).toEqual({ ok: true, status: 'running' })
  expect(harness.jobs).toHaveLength(before + 1)
  return harness.jobs[before]
}

const expectRefused = async (text: string, params: unknown[], pattern: RegExp) => {
  await expect(sql(text, params)).rejects.toThrow(pattern)
}

beforeAll(async () => {
  const env = dbEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey
  process.env.STUDIO_STUDENT_ACCESS = 'on'
  db = new Client({ connectionString: env.pgUrl })
  await db.connect()
  restoreEntitlement = await grantStudio(db, A.institution)
  for (const code of ['VAL', 'VAL2']) {
    const [{ id }] = await sql<{ id: string }>(
      `insert into public.course_sections (institution_id, course_id, section_code, semester, year, professor_id)
       values ($1, $2, $3, 'Fall', 2026, $4) returning id`,
      [A.institution, A.course, `${code}-${run}`, PROFESSOR],
    )
    if (code === 'VAL') section = id
    else otherSection = id
  }
  harness.superAdmin = (await sql<{ id: string }>(`select id from public.profiles where role = 'super_admin' limit 1`))[0]?.id ?? null
})

beforeEach(() => {
  harness.classify = educational
})

afterAll(async () => {
  delete process.env.STUDIO_STUDENT_ACCESS
  if (!db) return
  await sql('update public.studio_validator_settings set min_accepted_ruleset = 1 where id')
  await restoreEntitlement?.()
  for (const project of projects) {
    await sql('delete from public.studio_plugin_installations where project_id = $1', [project])
    await sql('delete from public.studio_plugin_versions where project_id = $1', [project])
    await sql('delete from public.studio_plugin_projects where id = $1', [project])
  }
  for (const s of [section, otherSection].filter(Boolean)) {
    await sql('delete from public.skills where section_id = $1', [s])
    await sql('delete from public.course_sections where id = $1', [s])
  }
  await db.end()
})

describe('from publishing to showing students', () => {
  let tool: Awaited<ReturnType<typeof publish>>
  let job: RuntimeJob

  it('publishing stores the artifact hash and runs Stage 1, recording every static check', async () => {
    tool = await publish('flow')
    const [stored] = await sql<{ h: string }>('select artifact_sha256 as h from public.studio_plugin_versions where id = $1', [tool.version])
    const runs = await runsOf(tool.version)
    expect(runs).toEqual([expect.objectContaining({ stage: 'static', status: 'passed', artifact_sha256: stored.h, ai_model: 'test-model' })])
    const checks = await sql<{ check_id: string }>('select check_id from public.studio_plugin_validation_checks where validation_id = $1', [runs[0].id])
    expect(checks.map((c) => c.check_id).sort()).toEqual(checksFor('static').map((c) => c.id).sort())
    expect(await service.currentVerdict(tool.version)).toEqual({ status: 'unavailable', reason: 'runtime_not_checked' })
  })

  it('the tool can’t be shown before the browser checks', async () => {
    session.userId = PROFESSOR
    const result = await visibility.showToStudents({ sectionId: section, installationId: tool.installation, acknowledgeWarnings: true })
    expect(result).toMatchObject({ ok: false, blockers: expect.arrayContaining([expect.objectContaining({ code: 'validator_unavailable' })]) })
  })

  it('asking for the browser checks opens one runtime run, keyed to the artifact, holding only the token’s hash', async () => {
    job = await askForBrowserChecks(tool.installation)
    const runtime = (await runsOf(tool.version)).find((r) => r.stage === 'runtime')!
    expect(runtime).toMatchObject({ id: job.validationId, status: 'running' })
    expect(runtime.callback_sha256).toBe(createHash('sha256').update(job.nonce).digest('hex'))
    const [dispatch] = await sql<{ runner_mode: string; payload_sha256: string }>('select runner_mode, payload_sha256 from public.studio_plugin_validations where id = $1', [job.validationId])
    expect(dispatch).toEqual({ runner_mode: 'local', payload_sha256: createHash('sha256').update(job.bytes).digest('hex') })
    // A second request while it runs doesn't stack another run.
    session.userId = PROFESSOR
    expect(await service.requestRuntimeValidation({ sectionId: section, installationId: tool.installation })).toEqual({ ok: true, status: 'running' })
    expect((await runsOf(tool.version)).filter((r) => r.stage === 'runtime')).toHaveLength(1)
  })

  it('a report with the wrong token is refused and changes nothing', async () => {
    const res = await report(job, goodReport(), randomBytes(32).toString('base64url'))
    expect(res.status).toBe(403)
    expect((await runsOf(tool.version)).find((r) => r.id === job.validationId)?.status).toBe('running')
  })

  it('the runner’s report, with its token, passes the version', async () => {
    const res = await report(job)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'passed' })
    expect(await service.currentVerdict(tool.version)).toMatchObject({ status: 'passed', rulesetVersion: STUDIO_VALIDATOR_RULESET })
  })

  it('the same report can’t be replayed, even to change the result', async () => {
    const failing = { ...goodReport(), checks: goodReport().checks.map((c) => ({ ...c, status: 'failed' })) }
    expect((await report(job, failing)).status).toBe(403)
    expect(await service.currentVerdict(tool.version)).toMatchObject({ status: 'passed' })
  })

  it('a passed tool with an unbound skill slot still can’t be shown; binding it clears the way', async () => {
    session.userId = PROFESSOR
    const blocked = await visibility.showToStudents({ sectionId: section, installationId: tool.installation, acknowledgeWarnings: true })
    expect(blocked).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'skill_binding_missing' })] })

    const [{ id: skill }] = await sql<{ id: string }>(
      `insert into public.skills (institution_id, section_id, name) values ($1, $2, 'Photosynthesis') returning id`,
      [A.institution, section],
    )
    expect(await bindSkillSlot({ sectionId: section, installationId: tool.installation, slotKey: 'topic', skillId: skill })).toEqual({ ok: true })
    expect(await visibility.showToStudents({ sectionId: section, installationId: tool.installation, acknowledgeWarnings: true })).toEqual({
      ok: true,
      value: { changed: true },
    })
  })

  it('deleting a linked skill removes the link and blocks showing again', async () => {
    session.userId = PROFESSOR
    ok(await visibility.hideFromStudents({ sectionId: section, installationId: tool.installation }))
    const [{ skill_id: skill }] = await sql<{ skill_id: string }>(
      'select skill_id from public.studio_plugin_skill_bindings where installation_id = $1',
      [tool.installation],
    )
    await sql('delete from public.skills where id = $1', [skill])
    expect(await sql('select 1 from public.studio_plugin_skill_bindings where installation_id = $1', [tool.installation])).toHaveLength(0)
    const blocked = await visibility.showToStudents({ sectionId: section, installationId: tool.installation, acknowledgeWarnings: true })
    expect(blocked).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'skill_binding_missing' })] })
  })

  it('raising the minimum ruleset withdraws the verdict until the version is checked again', async () => {
    await sql('update public.studio_validator_settings set min_accepted_ruleset = $1 where id', [STUDIO_VALIDATOR_RULESET + 1])
    expect(await service.currentVerdict(tool.version)).toEqual({ status: 'unavailable', reason: 'below_minimum_ruleset' })
    await sql('update public.studio_validator_settings set min_accepted_ruleset = 1 where id')
    expect(await service.currentVerdict(tool.version)).toMatchObject({ status: 'passed' })
  })

  it('a version’s content can’t be changed underneath its stored hash', async () => {
    // The verdict also recomputes the hash on every read (artifact_mismatch, tested in
    // studio-validator-service.test.ts); here the table refuses the change outright.
    await expect(
      sql('update public.studio_plugin_versions set student_bundle = student_bundle || $2 where id = $1', [tool.version, ' // tampered']),
    ).rejects.toThrow()
    expect(await service.currentVerdict(tool.version)).toMatchObject({ status: 'passed' })
  })
})

describe('Stage 1 outcomes in the database', () => {
  it('a tool with a security finding fails Stage 1, and the browser checks are refused', async () => {
    const tool = await publish('nav', STATIC_BAD.find((f) => f.name === 'self-navigation')!.artifact)
    expect((await runsOf(tool.version)).map((r) => [r.stage, r.status])).toEqual([['static', 'failed']])
    session.userId = PROFESSOR
    expect(await service.requestRuntimeValidation({ sectionId: section, installationId: tool.installation })).toEqual({
      ok: false,
      error: expect.stringMatching(/automatic checks have to pass/),
    })
  })

  it('an AI outage leaves the purpose check for review; the professor can’t resolve it', async () => {
    harness.classify = async () => ({ ok: false, reason: 'unavailable' })
    const tool = await publish('review')
    const [staticRun] = await runsOf(tool.version)
    expect(staticRun.status).toBe('needs_review')
    expect(await service.currentVerdict(tool.version)).toMatchObject({ status: 'needs_review', checkIds: ['edtech.purpose'] })

    session.userId = PROFESSOR
    const review = { validationId: staticRun.id, checkId: 'edtech.purpose', artifactSha256: staticRun.artifact_sha256, decision: 'approved' as const, reason: 'Looks fine to me.' }
    expect(await service.resolveValidationReview(review)).toEqual({ ok: false, error: expect.any(String) })
    await expectRefused(
      `insert into public.studio_plugin_validation_reviews (validation_id, check_id, decision, reviewer_id, reason) values ($1, 'edtech.purpose', 'approved', $2, 'x')`,
      [staticRun.id, PROFESSOR],
      /super admin/i,
    )
  })

  it('the review queue lists a flagged check with its school, course and stated purpose, for super admins only', async (ctx) => {
    if (!harness.superAdmin) ctx.skip()
    harness.classify = async () => ({ ok: false, reason: 'unavailable' })
    const tool = await publish('queue')
    const [staticRun] = await runsOf(tool.version)
    session.userId = PROFESSOR
    expect(await service.getReviewQueue()).toBeNull()
    session.userId = harness.superAdmin
    const queue = await service.getReviewQueue()
    const item = queue?.find((i) => i.validationId === staticRun.id)
    const [course] = await sql<{ code: string; title: string }>('select c.code, c.title from public.course_sections s join public.courses c on c.id = s.course_id where s.id = $1', [section])
    expect(item).toMatchObject({ checkId: 'edtech.purpose', artifactSha256: staticRun.artifact_sha256, courses: [`${course.code}: ${course.title}`], publishedByYou: false })
    expect(item?.purpose.length).toBeGreaterThan(0)
    expect(await service.countWaitingReviews()).toBeGreaterThan(0)
  })

  it('a super admin’s approval clears the review', async (ctx) => {
    if (!harness.superAdmin) ctx.skip()
    harness.classify = async () => ({ ok: false, reason: 'unavailable' })
    const tool = await publish('approved')
    const [staticRun] = await runsOf(tool.version)
    session.userId = harness.superAdmin
    expect(
      await service.resolveValidationReview({ validationId: staticRun.id, checkId: 'edtech.purpose', artifactSha256: staticRun.artifact_sha256, decision: 'approved', reason: 'A reflection tool.' }),
    ).toEqual({ ok: true })
    expect(await service.currentVerdict(tool.version)).toEqual({ status: 'unavailable', reason: 'runtime_not_checked' })
    // A decided check leaves the queue.
    expect((await service.getReviewQueue())?.some((i) => i.validationId === staticRun.id)).toBe(false)
    // A check that passed can't be "reviewed".
    await expectRefused(
      `insert into public.studio_plugin_validation_reviews (validation_id, check_id, decision, reviewer_id, reason) values ($1, 'code.navigation', 'rejected', $2, 'x')`,
      [staticRun.id, harness.superAdmin],
      /waiting for review/,
    )
  })

  it('a super admin can’t review a version they published themselves', async (ctx) => {
    if (!harness.superAdmin) ctx.skip()
    harness.classify = async () => ({ ok: false, reason: 'unavailable' })
    const tool = await publish('self-review')
    // The same project, a newer version, published by the super admin directly.
    const [{ id: version }] = await sql<{ id: string }>(
      `insert into public.studio_plugin_versions
         (project_id, institution_id, version, manifest, bridge_version, source, student_bundle, professor_bundle, bundle_sha256, artifact_sha256, published_by)
       select project_id, institution_id, '1.0.1', jsonb_set(manifest, '{version}', '"1.0.1"'), bridge_version, source,
              student_bundle, professor_bundle, bundle_sha256, artifact_sha256, $2
         from public.studio_plugin_versions where id = $1
       returning id`,
      [tool.version, harness.superAdmin],
    )
    const [{ id: run }] = await sql<{ id: string }>(
      `insert into public.studio_plugin_validations (version_id, institution_id, stage, status, artifact_sha256, validator_version, ruleset_version, runtime_version, trigger)
       select id, institution_id, 'static', 'running', artifact_sha256, 'test', 1, 'v1', 'test' from public.studio_plugin_versions where id = $1
       returning id`,
      [version],
    )
    await sql(
      `insert into public.studio_plugin_validation_checks (validation_id, check_id, rule_refs, stage, status, severity, message)
       values ($1, 'edtech.purpose', '{9.6}', 'static', 'needs_review', 'policy', 'x')`,
      [run],
    )
    await sql(`update public.studio_plugin_validations set status = 'needs_review' where id = $1`, [run])
    await expectRefused(
      `insert into public.studio_plugin_validation_reviews (validation_id, check_id, decision, reviewer_id, reason) values ($1, 'edtech.purpose', 'approved', $2, 'x')`,
      [run, harness.superAdmin],
      /publisher/,
    )
  })

  it('the sizes function reports byte sizes without returning content', async () => {
    const tool = await publish('sizes')
    const [sizes] = await sql<Record<string, string>>('select * from public.studio_version_sizes($1)', [tool.version])
    expect(Object.keys(sizes).sort()).toEqual(['professor_bytes', 'source_bytes', 'source_files', 'student_bytes'])
    expect(Number(sizes.student_bytes)).toBe(new TextEncoder().encode(GOOD.studentBundle).length)
    expect(Number(sizes.source_files)).toBe(Object.keys(GOOD.source).length)
  })
})

describe('what the validator tables refuse', () => {
  let version = ''
  let institution = ''
  let hash = ''
  let finished = ''

  beforeAll(async () => {
    const tool = await publish('guards')
    version = tool.version
    ;[{ institution_id: institution, artifact_sha256: hash }] = await sql<{ institution_id: string; artifact_sha256: string }>(
      'select institution_id, artifact_sha256 from public.studio_plugin_versions where id = $1',
      [version],
    )
    finished = (await runsOf(version))[0].id
  })

  const insertRun = (status: string, inst = institution) =>
    sql<{ id: string }>(
      `insert into public.studio_plugin_validations (version_id, institution_id, stage, status, artifact_sha256, validator_version, ruleset_version, runtime_version, trigger)
       values ($1, $2, 'runtime', $3, $4, 'test', 1, 'v1', 'test') returning id`,
      [version, inst, status, hash],
    )

  it('a run in another institution than its version', async () => {
    await expectRefused(
      `insert into public.studio_plugin_validations (version_id, institution_id, stage, status, artifact_sha256, validator_version, ruleset_version, runtime_version, trigger)
       values ($1, $2, 'static', 'running', $3, 'test', 1, 'v1', 'test')`,
      [version, OTHER_INSTITUTION, hash],
      /institution|tenant/i,
    )
  })

  it('a run that starts already decided', async () => {
    await expect(insertRun('passed')).rejects.toThrow()
  })

  it('a second active run for the same version, stage, ruleset and artifact', async () => {
    const [first] = await insertRun('pending')
    await expect(insertRun('pending')).rejects.toThrow(/duplicate|unique/i)
    await sql(`update public.studio_plugin_validations set status = 'error' where id = $1`, [first.id])
  })

  it('changing a finished run', async () => {
    await expect(sql(`update public.studio_plugin_validations set status = 'failed' where id = $1`, [finished])).rejects.toThrow()
    await expect(sql(`update public.studio_plugin_validations set artifact_sha256 = $2 where id = $1`, [finished, 'f'.repeat(64)])).rejects.toThrow()
  })

  it('adding or changing check results once a run is finished', async () => {
    await expectRefused(
      `insert into public.studio_plugin_validation_checks (validation_id, check_id, rule_refs, stage, status, severity, message)
       values ($1, 'extra.check', '{1.1}', 'static', 'passed', 'quality', 'x')`,
      [finished],
      /open|finished|closed/i,
    )
    await expect(
      sql(`update public.studio_plugin_validation_checks set status = 'passed' where validation_id = $1`, [finished]),
    ).rejects.toThrow()
  })

  it('an open run’s identity, or a step back to pending', async () => {
    const [open] = await insertRun('pending')
    await expectRefused(`update public.studio_plugin_validations set artifact_sha256 = $2 where id = $1`, [open.id, 'f'.repeat(64)], /identity/)
    await expectRefused(`update public.studio_plugin_validations set ruleset_version = 2 where id = $1`, [open.id], /identity/)
    await sql(`update public.studio_plugin_validations set status = 'running' where id = $1`, [open.id])
    await expectRefused(`update public.studio_plugin_validations set status = 'pending' where id = $1`, [open.id], /back to pending/)
    await sql(`update public.studio_plugin_validations set status = 'error' where id = $1`, [open.id])
  })

  it('a check of the other stage in an open run', async () => {
    const [open] = await insertRun('running')
    await expectRefused(
      `insert into public.studio_plugin_validation_checks (validation_id, check_id, rule_refs, stage, status, severity, message)
       values ($1, 'code.navigation', '{1.2}', 'static', 'passed', 'security', 'x')`,
      [open.id],
      /same stage/,
    )
    await sql(`update public.studio_plugin_validations set status = 'error' where id = $1`, [open.id])
  })

  it('deleting a run, a check or a review directly', async () => {
    await expectRefused('delete from public.studio_plugin_validations where id = $1', [finished], /can't be deleted/)
    await expectRefused('delete from public.studio_plugin_validation_checks where validation_id = $1', [finished], /can't be deleted/)
    expect(await sql('select 1 from public.studio_plugin_validations where id = $1', [finished])).toHaveLength(1)
  })

  it('a skill binding to a skill of another section', async () => {
    const [{ id: installation }] = await sql<{ id: string }>('select id from public.studio_plugin_installations where current_version_id = $1', [version])
    const [{ id: foreign }] = await sql<{ id: string }>(
      `insert into public.skills (institution_id, section_id, name) values ($1, $2, 'Elsewhere') returning id`,
      [A.institution, otherSection],
    )
    await expectRefused(
      `insert into public.studio_plugin_skill_bindings (installation_id, slot_key, skill_id, institution_id, bound_by) values ($1, 'topic', $2, $3, $4)`,
      [installation, foreign, A.institution, PROFESSOR],
      /own section/,
    )
    session.userId = PROFESSOR
    expect(await bindSkillSlot({ sectionId: section, installationId: installation, slotKey: 'topic', skillId: foreign })).toEqual({
      ok: false,
      error: expect.any(String),
    })
  })

  it('a binding in another institution, by someone of another institution, or re-pointed to a foreign skill', async () => {
    const [{ id: installation }] = await sql<{ id: string }>('select id from public.studio_plugin_installations where current_version_id = $1', [version])
    const [{ id: own }] = await sql<{ id: string }>(
      `insert into public.skills (institution_id, section_id, name) values ($1, $2, 'Own') returning id`,
      [A.institution, section],
    )
    const insert = `insert into public.studio_plugin_skill_bindings (installation_id, slot_key, skill_id, institution_id, bound_by) values ($1, 'topic', $2, $3, $4)`
    await expectRefused(insert, [installation, own, OTHER_INSTITUTION, PROFESSOR], /institution/)
    await expectRefused(insert, [installation, own, A.institution, FIXTURE.b.users.professor.id], /whoever binds/)
    await sql(insert, [installation, own, A.institution, PROFESSOR])
    const [{ id: foreign }] = await sql<{ id: string }>(
      `insert into public.skills (institution_id, section_id, name) values ($1, $2, 'Foreign') returning id`,
      [A.institution, otherSection],
    )
    await expectRefused(
      `update public.studio_plugin_skill_bindings set skill_id = $2 where installation_id = $1 and slot_key = 'topic'`,
      [installation, foreign],
      /own section/,
    )
  })
})

describe('the gate’s check and its write are one decision', () => {
  let tool: Awaited<ReturnType<typeof publish>>
  const current = async () =>
    (await sql<{ v: string; s: string }>('select current_version_id as v, student_visibility as s from public.studio_plugin_installations where id = $1', [tool.installation]))[0]

  beforeAll(async () => {
    tool = await publish('race')
  })

  it('showing refuses if another version became active after the check', async () => {
    await expectRefused(
      `select public.studio_set_student_visibility($1, $2, 'visible', $3, $4)`,
      [tool.installation, section, PROFESSOR, randomUUID()],
      /changed while it was being checked/,
    )
    expect((await current()).s).toBe('hidden')
  })

  it('activation refuses if the tool was shown after the check', async () => {
    const { v } = await current()
    await sql(`select public.studio_set_student_visibility($1, $2, 'visible', $3, $4)`, [tool.installation, section, PROFESSOR, v])
    // The check saw a hidden tool, so it skipped the validator: the database refuses.
    await expectRefused(
      `select public.studio_activate_version($1, $2, $3, false, 'hidden')`,
      [tool.installation, v, PROFESSOR],
      /changed while it was being checked/,
    )
    await sql(`select public.studio_set_student_visibility($1, $2, 'hidden', $3, null)`, [tool.installation, section, PROFESSOR])
  })

  it('hiding needs no expected version', async () => {
    const { v } = await current()
    await sql(`select public.studio_set_student_visibility($1, $2, 'visible', $3, $4)`, [tool.installation, section, PROFESSOR, v])
    expect((await sql<{ c: boolean }>(`select public.studio_set_student_visibility($1, $2, 'hidden', $3, null) as c`, [tool.installation, section, PROFESSOR]))[0].c).toBe(true)
  })
})

describe('Stage 2 admission, dispatch and the ruleset control (Step 10)', () => {
  const caps = (over: Partial<Record<'global_concurrent' | 'institution_concurrent' | 'institution_daily' | 'system_concurrent', number>> = {}) =>
    JSON.stringify({ global_concurrent: 1000, institution_concurrent: 2, institution_daily: 30, system_concurrent: 1, ...over })
  const ADMIT = `select public.studio_runtime_admit($1, $2, $3, 'test', $4, 'v1', $5, $6, $7, $8, $9::jsonb) as r`
  const tools: { version: string; hash: string }[] = []

  /** Admits a runtime run for tools[i] through `client` (the shared one unless racing). */
  const admit = async (i: number, lane: 'professor' | 'system', capsJson = caps(), client: Client = db) => {
    const trigger = lane === 'system' ? 'ruleset_change' : 'professor'
    const { rows } = await client.query(ADMIT, [tools[i].version, A.institution, tools[i].hash, STUDIO_VALIDATOR_RULESET, trigger, PROFESSOR, 'c'.repeat(64), lane, capsJson])
    return rows[0].r as { outcome: string; id?: string }
  }
  const closeRuntime = (status = 'error') =>
    sql(`update public.studio_plugin_validations set status = $2, finished_at = now() where institution_id = $1 and stage = 'runtime' and status in ('pending', 'running')`, [A.institution, status])

  beforeAll(async () => {
    harness.classify = educational
    for (const tag of ['q0', 'q1', 'q2', 'q3']) {
      const tool = await publish(tag)
      const [{ h }] = await sql<{ h: string }>('select artifact_sha256 as h from public.studio_plugin_versions where id = $1', [tool.version])
      tools.push({ version: tool.version, hash: h })
    }
  })
  beforeEach(async () => {
    await closeRuntime()
  })

  it('two concurrent requests for the last professor slot: exactly one gets it', async () => {
    expect((await admit(0, 'professor')).outcome).toBe('admitted')
    const env = dbEnv()
    const racers = [new Client({ connectionString: env.pgUrl }), new Client({ connectionString: env.pgUrl })]
    await Promise.all(racers.map((c) => c.connect()))
    try {
      const outcomes = await Promise.all([admit(1, 'professor', caps(), racers[0]), admit(2, 'professor', caps(), racers[1])])
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(['admitted', 'busy'])
    } finally {
      await Promise.all(racers.map((c) => c.end()))
    }
  })

  it('a revalidation run leaves the professors’ slots alone, and takes only its own one', async () => {
    expect((await admit(0, 'system')).outcome).toBe('admitted')
    expect((await admit(1, 'system')).outcome).toBe('busy')
    expect((await admit(2, 'professor')).outcome).toBe('admitted')
    expect((await admit(3, 'professor')).outcome).toBe('admitted')
  })

  it('the daily cap counts runs that reached a verdict, not runner errors', async () => {
    // Today's earlier runs in this suite may have reached a verdict: count from what's there.
    const [{ n }] = await sql<{ n: number }>(
      `select count(*)::int as n from public.studio_plugin_validations where institution_id = $1 and stage = 'runtime' and trigger <> 'ruleset_change' and status in ('passed', 'failed', 'needs_review') and created_at > now() - interval '24 hours'`,
      [A.institution],
    )
    const daily = caps({ institution_daily: n + 1 })
    expect((await admit(0, 'professor', daily)).outcome).toBe('admitted')
    await closeRuntime('error')
    expect((await admit(1, 'professor', daily)).outcome).toBe('admitted')
    await closeRuntime('failed')
    expect((await admit(2, 'professor', daily)).outcome).toBe('daily')
    // Revalidation is outside the daily cap.
    expect((await admit(2, 'system', daily)).outcome).toBe('admitted')
  })

  it('the daily cap counts a dispatched run a plugin made fail, but not the platform’s own errors', async () => {
    const [{ n }] = await sql<{ n: number }>(
      `select count(*)::int as n from public.studio_plugin_validations where institution_id = $1 and stage = 'runtime' and trigger <> 'ruleset_change' and created_at > now() - interval '24 hours'
         and (status in ('passed', 'failed', 'needs_review') or (status = 'error' and runner_mode is not null and coalesce(error ->> 'code', '') not in ('runner_unavailable', 'runner_image_mismatch', 'callback_expired')))`,
      [A.institution],
    )
    const daily = caps({ institution_daily: n + 1 })
    const dispatchAndFail = async (i: number, code: string) => {
      const { id } = await admit(i, 'professor', daily)
      await sql(`select public.studio_validation_dispatch($1, 'cloud', $2, 'executions/e', 'img@sha256:x', null)`, [id, 'a'.repeat(64)])
      await sql(`update public.studio_plugin_validations set status = 'error', error = $2, finished_at = now() where id = $1`, [id, JSON.stringify({ code, message: 'x' })])
    }
    await dispatchAndFail(0, 'runner_image_mismatch')
    expect((await admit(1, 'professor', daily)).outcome).toBe('admitted')
    await closeRuntime()
    await dispatchAndFail(2, 'runner_failed')
    expect((await admit(3, 'professor', daily)).outcome).toBe('daily')
  })

  it('the global cap holds across institutions', async () => {
    const [{ n }] = await sql<{ n: number }>(`select count(*)::int as n from public.studio_plugin_validations where stage = 'runtime' and status in ('pending', 'running')`)
    expect((await admit(0, 'professor', caps({ global_concurrent: n + 1 }))).outcome).toBe('admitted')
    expect((await admit(1, 'professor', caps({ global_concurrent: n + 1 }))).outcome).toBe('global_busy')
  })

  it('a second request for the same artifact reads as already running', async () => {
    expect((await admit(0, 'professor')).outcome).toBe('admitted')
    expect((await admit(0, 'professor')).outcome).toBe('exists')
  })

  it('only revalidation uses the system lane', async () => {
    await expectRefused(ADMIT, [tools[0].version, A.institution, tools[0].hash, STUDIO_VALIDATOR_RULESET, 'professor', PROFESSOR, null, 'system', caps()], /system lane/)
  })

  it('dispatch is recorded once, and neither it nor the nonce hash can change after', async () => {
    const { id } = await admit(0, 'professor')
    const dispatch = (exec: string) =>
      sql<{ d: boolean }>(`select public.studio_validation_dispatch($1, 'cloud', $2, $3, $4, null) as d`, [id, 'a'.repeat(64), exec, 'img@sha256:' + 'b'.repeat(64)])
    expect((await dispatch('executions/one'))[0].d).toBe(true)
    expect((await dispatch('executions/two'))[0].d).toBe(false)
    await expectRefused(`update public.studio_plugin_validations set payload_sha256 = $2 where id = $1`, [id, 'e'.repeat(64)], /dispatch can.t change/)
    await expectRefused(`update public.studio_plugin_validations set runner_image = 'other' where id = $1`, [id], /dispatch can.t change/)
    await expectRefused(`update public.studio_plugin_validations set callback_sha256 = $2 where id = $1`, [id, 'd'.repeat(64)], /identity can.t change/)
  })

  it('the collector lists only dispatched cloud runs, oldest first', async () => {
    const { id } = await admit(0, 'professor')
    expect((await studioDb.listDispatchedCloudRuns(50)).some((r) => r.id === id)).toBe(false)
    await sql(`select public.studio_validation_dispatch($1, 'cloud', $2, 'executions/e', 'img@sha256:x', null)`, [id, 'a'.repeat(64)])
    expect((await studioDb.listDispatchedCloudRuns(50)).find((r) => r.id === id)).toMatchObject({ executionName: 'executions/e', runnerImage: 'img@sha256:x' })
  })

  it('revalidation reads the version’s earlier purpose answer, and finds the course’s installation of a project', async () => {
    const outcome = await studioDb.loadLatestPurposeOutcome(tools[0].version, PURPOSE_RUBRIC_VERSION)
    expect(outcome).toMatchObject({ status: 'passed', metadata: { verdict: 'educational' }, aiModel: 'test-model' })
    const [{ project_id: project }] = await sql<{ project_id: string }>('select project_id from public.studio_plugin_versions where id = $1', [tools[0].version])
    const found = await studioDb.findActiveInstallation(section, project)
    expect(found).toMatchObject({ sectionId: section, projectId: project, status: 'active' })
    expect(await studioDb.findActiveInstallation(otherSection, project)).toBeNull()
    const page = await studioDb.listInstitutionCurrentVersions(A.institution, 1000, 0)
    expect(page?.rows.some((r) => r.installationId === (found as { id: string }).id)).toBe(true)
  })

  it('the revalidation upkeep continues a job that stopped on capacity, once, as its super admin', async (ctx) => {
    if (!harness.superAdmin) ctx.skip()
    const { continueRevalidations } = await import('@/lib/studio/validator/pipelines')
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const TYPE = 'studio_validator_revalidate'
    await sql('delete from public.background_jobs where type = $1 and institution_id = $2', [TYPE, A.institution])
    try {
      await sql(
        `insert into public.background_jobs (type, params, status, institution_id, subject_key, created_by, result, completed_at)
         values ($1, '{}', 'done', $2, 'revalidate', $3, '{"next": 25, "minRuleset": 2, "checked": 3, "waiting": true}', now())`,
        [TYPE, A.institution, harness.superAdmin],
      )
      expect(await studioDb.revalidationProgress(TYPE)).toMatchObject({ active: expect.any(Number), waiting: expect.any(Number) })
      const before = await studioDb.revalidationProgress(TYPE)
      expect(before!.waiting).toBeGreaterThanOrEqual(1)
      expect(await continueRevalidations(createAdminClient())).toBeGreaterThanOrEqual(1)
      const queued = await sql<{ params: { offset: number; minRuleset: number }; created_by: string; status: string }>(
        `select params, created_by, status from public.background_jobs where type = $1 and institution_id = $2 and status = 'pending'`,
        [TYPE, A.institution],
      )
      expect(queued).toEqual([{ params: { offset: 25, minRuleset: 2 }, created_by: harness.superAdmin, status: 'pending' }])
      // The newest job is now the queued one: a second upkeep adds nothing for this school.
      await continueRevalidations(createAdminClient())
      expect((await sql(`select 1 from public.background_jobs where type = $1 and institution_id = $2 and status = 'pending'`, [TYPE, A.institution])).length).toBe(1)
    } finally {
      await sql('delete from public.background_jobs where type = $1 and institution_id = $2', [TYPE, A.institution])
    }
  })

  it('a run is never created already dispatched', async () => {
    await expectRefused(
      `insert into public.studio_plugin_validations (version_id, institution_id, stage, status, artifact_sha256, validator_version, ruleset_version, runtime_version, trigger, runner_mode)
       values ($1, $2, 'runtime', 'pending', $3, 'test', $4, 'v1', 'professor', 'cloud')`,
      [tools[0].version, A.institution, tools[0].hash, STUDIO_VALIDATOR_RULESET],
      /dispatched after it is created/,
    )
  })

  it('a run with no nonce hash can’t be dispatched without one', async () => {
    const { rows } = await db.query(ADMIT, [tools[1].version, A.institution, tools[1].hash, STUDIO_VALIDATOR_RULESET, 'professor', PROFESSOR, null, 'professor', caps()])
    const id = (rows[0].r as { id: string }).id
    expect((await sql<{ d: boolean }>(`select public.studio_validation_dispatch($1, 'cloud', $2, 'e', 'i', null) as d`, [id, 'a'.repeat(64)]))[0].d).toBe(false)
  })

  it('the purpose classifier’s daily cap counts the institution’s recorded calls', async () => {
    const [{ n }] = await sql<{ n: number }>(
      `select count(*)::int as n from public.ai_usage_events where institution_id = $1 and feature = 'studio_purpose_check' and created_at > now() - interval '24 hours'`,
      [A.institution],
    )
    await sql(
      `insert into public.ai_usage_events (institution_id, feature, model, input_tokens, output_tokens) values ($1, 'studio_purpose_check', 'test-model', 1, 1)`,
      [A.institution],
    )
    expect((await sql<{ ok: boolean }>('select public.studio_purpose_admit($1, $2) as ok', [A.institution, n + 1]))[0].ok).toBe(true)
    expect((await sql<{ ok: boolean }>('select public.studio_purpose_admit($1, $2) as ok', [A.institution, n]))[0].ok).toBe(false)
    await sql(`delete from public.ai_usage_events where institution_id = $1 and feature = 'studio_purpose_check' and model = 'test-model'`, [A.institution])
  })

  describe('the minimum accepted ruleset', () => {
    /** Calls the control as `userId` would through their own client: the authenticated role and their JWT claims. */
    const setAs = async (userId: string, ruleset: number, max = STUDIO_VALIDATOR_RULESET) => {
      await db.query('begin')
      try {
        await db.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' }), userId])
        await db.query('set local role authenticated')
        const { rows } = await db.query('select public.studio_set_min_accepted_ruleset($1, $2) as r', [ruleset, max])
        await db.query('commit')
        return rows[0].r as { ok: boolean; reason?: string }
      } catch (error) {
        await db.query('rollback')
        throw error
      }
    }

    it('a professor can’t change it', async () => {
      await expect(setAs(PROFESSOR, STUDIO_VALIDATOR_RULESET)).rejects.toThrow(/super admin/)
    })

    it('a super admin raises it, up to the code’s ruleset, never lowers it, and is recorded', async (ctx) => {
      if (!harness.superAdmin) ctx.skip()
      await sql('update public.studio_validator_settings set min_accepted_ruleset = 1, updated_by = null where id')
      expect(await setAs(harness.superAdmin!, STUDIO_VALIDATOR_RULESET + 1)).toMatchObject({ ok: false, reason: 'out_of_range' })
      expect(await setAs(harness.superAdmin!, STUDIO_VALIDATOR_RULESET)).toMatchObject({ ok: true })
      expect(await sql('select min_accepted_ruleset, updated_by from public.studio_validator_settings')).toEqual([
        { min_accepted_ruleset: STUDIO_VALIDATOR_RULESET, updated_by: harness.superAdmin },
      ])
      if (STUDIO_VALIDATOR_RULESET > 1) expect(await setAs(harness.superAdmin!, 1)).toMatchObject({ ok: false, reason: 'lower' })
      // One step at a time, whatever maximum the caller names.
      expect(await setAs(harness.superAdmin!, STUDIO_VALIDATOR_RULESET + 2, STUDIO_VALIDATOR_RULESET + 5)).toMatchObject({ ok: false, reason: 'out_of_range' })
      await sql('update public.studio_validator_settings set min_accepted_ruleset = 1, updated_by = null where id')
    })

    it('only signed-in users may call the control; the queue functions are service-role only', async () => {
      const grants = await sql<{ f: string; anon: boolean; authed: boolean }>(
        `select p.proname as f, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authed
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in ('studio_set_min_accepted_ruleset', 'studio_runtime_admit', 'studio_validation_dispatch', 'studio_purpose_admit', 'studio_review_queue')
          order by 1`,
      )
      expect(grants).toEqual([
        { f: 'studio_purpose_admit', anon: false, authed: false },
        { f: 'studio_review_queue', anon: false, authed: false },
        { f: 'studio_runtime_admit', anon: false, authed: false },
        { f: 'studio_set_min_accepted_ruleset', anon: false, authed: true },
        { f: 'studio_validation_dispatch', anon: false, authed: false },
      ])
    })
  })
})
