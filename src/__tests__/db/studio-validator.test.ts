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
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOD, STATIC_BAD, type FixtureArtifact } from '@/lib/studio/validator/fixtures'
import { RUNTIME_CHECK_IDS, STUDIO_VALIDATOR_RULESET, checksFor } from '@/lib/studio/validator/ruleset'
import type { PurposeClassifier } from '@/lib/studio/validator/purpose'
import type { RuntimeJob } from '@/lib/studio/validator/runtime-runner'
import { dbEnv } from './env'
import { FIXTURE } from './fixture'
import { grantStudio } from './studio-entitlement'

const session: { userId: string | null } = { userId: null }
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
vi.mock('@/lib/studio/validator/runtime-runner', () => ({
  runnerMode: () => 'local',
  runLocally: (job: RuntimeJob) => {
    harness.jobs.push(job)
    return new Promise(() => {})
  },
}))
vi.mock('@/lib/auth/super-admin-context', () => ({
  verifySuperAdmin: async () => (harness.superAdmin && session.userId === harness.superAdmin ? { userId: harness.superAdmin } : { error: 'Forbidden' }),
}))

const lifecycle = await import('@/lib/studio/lifecycle')
const visibility = await import('@/lib/studio/student-visibility')
const service = await import('@/lib/studio/validator/service')
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

/** Reports for a runtime run exactly as a runner does: bearer token, JSON, the route. */
const report = (job: RuntimeJob, body: unknown = goodReport(), token = job.token) =>
  POST(
    new Request('http://localhost:3000/api/studio/validator/runtime-report', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ validationId: job.validationId, report: body }),
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
    expect(runtime).toMatchObject({ id: job.validationId, status: 'pending' })
    expect(runtime.callback_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(runtime.callback_sha256).not.toContain(job.token)
    // A second request while it runs doesn't stack another run.
    session.userId = PROFESSOR
    expect(await service.requestRuntimeValidation({ sectionId: section, installationId: tool.installation })).toEqual({ ok: true, status: 'running' })
    expect((await runsOf(tool.version)).filter((r) => r.stage === 'runtime')).toHaveLength(1)
  })

  it('a report with the wrong token is refused and changes nothing', async () => {
    const res = await report(job, goodReport(), randomBytes(32).toString('base64url'))
    expect(res.status).toBe(403)
    expect((await runsOf(tool.version)).find((r) => r.id === job.validationId)?.status).toBe('pending')
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
    const review = { validationId: staticRun.id, checkId: 'edtech.purpose', decision: 'approved' as const, reason: 'Looks fine to me.' }
    expect(await service.resolveValidationReview(review)).toEqual({ ok: false, error: expect.any(String) })
    await expectRefused(
      `insert into public.studio_plugin_validation_reviews (validation_id, check_id, decision, reviewer_id, reason) values ($1, 'edtech.purpose', 'approved', $2, 'x')`,
      [staticRun.id, PROFESSOR],
      /super admin/i,
    )
  })

  it('a super admin’s approval clears the review', async (ctx) => {
    if (!harness.superAdmin) ctx.skip()
    harness.classify = async () => ({ ok: false, reason: 'unavailable' })
    const tool = await publish('approved')
    const [staticRun] = await runsOf(tool.version)
    session.userId = harness.superAdmin
    expect(
      await service.resolveValidationReview({ validationId: staticRun.id, checkId: 'edtech.purpose', decision: 'approved', reason: 'A reflection tool.' }),
    ).toEqual({ ok: true })
    expect(await service.currentVerdict(tool.version)).toEqual({ status: 'unavailable', reason: 'runtime_not_checked' })
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
