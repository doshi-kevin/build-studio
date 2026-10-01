/**
 * The Studio trusted server path, end to end: the real context.ts, policy.ts,
 * record-schema.ts, records.ts, lifecycle.ts and db.ts, against a real database through
 * the service-role client (`npm run test:db`). This is the acceptance test for Step 3.
 *
 * Mocked, and only these:
 *   - the session cookie, so each step can act as a chosen fixture user;
 *   - publication.ts, so students are exercised as if the installation were shown to
 *     them (showing and hiding are tested in studio-publication.test.ts);
 *   - logEvent, so audit calls can be inspected (it writes to `events` otherwise).
 *
 * Everything else is real: verifySectionAccess, enrollment checks, every query in
 * db.ts, and every database guard. Setup uses SQL only for what Studio doesn't own (a
 * second section, its enrollments and staff), plus read-back checks on stored rows.
 * All Studio rows are created through lifecycle.ts and records.ts. Steps build on each
 * other, so they run in order.
 */
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import { dbEnv } from './env'
import { FIXTURE } from './fixture'
import { grantStudio } from './studio-entitlement'

const session: { userId: string | null } = { userId: null }

// Publishing runs Stage 1 of the validator. No model calls from tests: the purpose
// check sees the AI as unavailable (and sends the tool to review).
vi.mock('@/lib/studio/validator/purpose-ai', () => ({ createPurposeClassifier: () => async () => ({ ok: false, reason: 'unavailable' }) }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null } }) },
  }),
}))
vi.mock('@/lib/studio/publication', () => ({ isPublishedToStudents: () => true }))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))

const { logEvent } = await import('@/lib/supabase/event-logger')
const lifecycle = await import('@/lib/studio/lifecycle')
const records = await import('@/lib/studio/records')
const { RECORD_NOT_AVAILABLE } = records

const A = FIXTURE.a
const PROFESSOR = A.users.professor.id
const TA = A.users.ta.id
const GRADER = A.users.grader.id
const STUDENT_A = A.users.student.id
// Same institution, student profile, enrolled in nothing in the shared fixture.
const STUDENT_B = FIXTURE.outsider.id

const run = `t${randomBytes(4).toString('hex')}`
const SLUG = `sp-${run}`
const SECRET = `private answer ${run}`

let db: Client
let restoreEntitlement: (() => Promise<void>) | undefined
let sectionA2 = ''
let projectId = ''
let v1 = ''
let v2 = ''
let inA = '' // installation in the fixture's section A
let inA2 = '' // installation in this test's own section A2
let recordA = ''
let recordB = ''

const as = (userId: string) => {
  session.userId = userId
}

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(text, params)).rows as T[]
}

function manifest(version: string, extra: Record<string, unknown> = {}) {
  return {
    ...exitTicket,
    id: SLUG,
    version,
    collections: {
      ...exitTicket.collections,
      answerKeys: { access: 'staffOnly', fields: { questionId: 'text', correct: 'text' } },
      ...extra,
    },
  }
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string; issues?: string[] }): T {
  if (!result.ok) throw new Error(`expected success, got: ${result.error} ${result.issues?.join('; ') ?? ''}`)
  return result.value
}

const recordCount = async (installationId: string) =>
  Number((await sql<{ n: string }>('select count(*) as n from public.studio_plugin_records where installation_id = $1', [installationId]))[0].n)

const currentVersion = async (installationId: string) =>
  (await sql<{ v: string }>('select current_version_id as v from public.studio_plugin_installations where id = $1', [installationId]))[0].v

const answer = { questionId: 'q1', answer: SECRET, confidence: 2 }

beforeAll(async () => {
  const env = dbEnv()
  // createAdminClient reads these when called. The test DB gate in env.ts guarantees they're local.
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey
  db = new Client({ connectionString: env.pgUrl })
  await db.connect()
  restoreEntitlement = await grantStudio(db, A.institution)

  // A second section of the same course, with both students enrolled and the fixture TA
  // and grader as its staff. Every row here is removed in afterAll.
  ;[{ id: sectionA2 }] = await sql<{ id: string }>(
    `insert into public.course_sections (institution_id, course_id, section_code, semester, year, professor_id)
     values ($1, $2, $3, 'Fall', 2026, $4) returning id`,
    [A.institution, A.course, `SP-${run}`, PROFESSOR],
  )
  for (const student of [STUDENT_A, STUDENT_B]) {
    await sql(`insert into public.enrollments (section_id, student_id, status) values ($1, $2, 'enrolled')`, [sectionA2, student])
  }
  for (const [staffId, role] of [[TA, 'ta'], [GRADER, 'grader']]) {
    await sql(
      `insert into public.section_staff (section_id, staff_id, role, status, ends_at) values ($1, $2, $3, 'active', '2099-01-01')`,
      [sectionA2, staffId, role],
    )
  }
})

afterAll(async () => {
  if (!db) return
  await restoreEntitlement?.()
  if (projectId) {
    await sql('delete from public.studio_plugin_records where installation_id in (select id from public.studio_plugin_installations where project_id = $1)', [projectId])
    await sql('delete from public.studio_plugin_installations where project_id = $1', [projectId])
    await sql('delete from public.studio_plugin_versions where project_id = $1', [projectId])
    await sql('delete from public.studio_plugin_projects where id = $1', [projectId])
  }
  if (sectionA2) {
    await sql('delete from public.section_staff where section_id = $1', [sectionA2])
    await sql('delete from public.enrollments where section_id = $1', [sectionA2])
    await sql('delete from public.course_sections where id = $1', [sectionA2])
  }
  await db.end()
})

describe('Studio trusted server path', () => {
  it('1. publishes one version and installs it in two sections, all through lifecycle.ts', async () => {
    as(PROFESSOR)
    projectId = ok(await lifecycle.createProject({ sectionId: sectionA2, slug: SLUG, name: 'Exit ticket' }))
    v1 = ok(
      await lifecycle.publishVersion({
        sectionId: sectionA2,
        projectId,
        manifest: manifest('1.0.0'),
        source: { 'views/student.tsx': '' },
        studentBundle: 'student()',
        professorBundle: 'professor()',
      }),
    )
    inA2 = ok(await lifecycle.installPlugin({ sectionId: sectionA2, versionId: v1 }))
    inA = ok(await lifecycle.installPlugin({ sectionId: A.section, versionId: v1 }))

    expect(inA).not.toBe(inA2)
    expect([await currentVersion(inA), await currentVersion(inA2)]).toEqual([v1, v1])
  })

  it('2. a student reads only their own perStudent records', async () => {
    as(STUDENT_A)
    recordA = ok(await records.createRecord({ installationId: inA2, collection: 'responses', data: answer })).id
    as(STUDENT_B)
    recordB = ok(
      await records.createRecord({ installationId: inA2, collection: 'responses', data: { ...answer, answer: 'B’s answer' } }),
    ).id

    as(STUDENT_A)
    const mine = ok(await records.listRecords({ installationId: inA2, collection: 'responses' }))
    expect(mine.map((r) => [r.id, r.mine])).toEqual([[recordA, true]])
  })

  it('3. a student can’t read, change or delete another student’s record', async () => {
    as(STUDENT_A)
    const target = { installationId: inA2, collection: 'responses', recordId: recordB }
    expect(await records.getRecord(target)).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
    expect(await records.updateRecord({ ...target, data: answer })).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
    expect(await records.deleteRecord(target)).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })

    const [row] = await sql<{ data: { answer: string } }>('select data from public.studio_plugin_records where id = $1', [recordB])
    expect(row.data.answer).toBe('B’s answer')
  })

  it('4. a student never reaches staffOnly, even when records exist', async () => {
    as(PROFESSOR)
    const key = ok(await records.createRecord({ installationId: inA2, collection: 'answerKeys', data: { questionId: 'q1', correct: 'base case' } }))

    as(STUDENT_A)
    expect(await records.listRecords({ installationId: inA2, collection: 'answerKeys' })).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
    expect(await records.getRecord({ installationId: inA2, collection: 'answerKeys', recordId: key.id })).toEqual({
      ok: false,
      error: RECORD_NOT_AVAILABLE,
    })
  })

  it('5. staff read every record in their installation, and nothing from the other one', async () => {
    as(STUDENT_A)
    ok(await records.createRecord({ installationId: inA, collection: 'responses', data: answer }))

    for (const staff of [PROFESSOR, TA, GRADER]) {
      as(staff)
      const inSectionA2 = ok(await records.listRecords({ installationId: inA2, collection: 'responses' }))
      expect(inSectionA2.map((r) => r.id).sort()).toEqual([recordA, recordB].sort())
      const inSectionA = ok(await records.listRecords({ installationId: inA, collection: 'responses' }))
      expect(inSectionA).toHaveLength(1)
    }
  })

  it('6. a grader reads shared and staffOnly but writes neither', async () => {
    as(GRADER)
    expect(ok(await records.listRecords({ installationId: inA2, collection: 'answerKeys' }))).toHaveLength(1)
    const before = await recordCount(inA2)
    expect(
      await records.createRecord({ installationId: inA2, collection: 'questions', data: { prompt: 'x', skill: 'y', open: true } }),
    ).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
    expect(
      await records.createRecord({ installationId: inA2, collection: 'answerKeys', data: { questionId: 'q2', correct: 'z' } }),
    ).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
    expect(await recordCount(inA2)).toBe(before)
  })

  it('7. writes are validated against the manifest, and nothing is stored when they fail', async () => {
    as(STUDENT_A)
    const before = await recordCount(inA2)
    const result = await records.createRecord({
      installationId: inA2,
      collection: 'responses',
      data: { ...answer, confidence: 'very', extra: true },
    })
    expect(result).toMatchObject({ ok: false, issues: ['extra: not a field of responses'] })
    expect(await recordCount(inA2)).toBe(before)
  })

  it('8. stamps come from the session and the installation, and a request can’t set them', async () => {
    const [row] = await sql(
      `select institution_id, section_id, installation_id, version_id, owner_id, author_id, collection
         from public.studio_plugin_records where id = $1`,
      [recordA],
    )
    expect(row).toEqual({
      institution_id: A.institution,
      section_id: sectionA2,
      installation_id: inA2,
      version_id: v1,
      owner_id: STUDENT_A,
      author_id: STUDENT_A,
      collection: 'responses',
    })

    as(STUDENT_A)
    const before = await recordCount(inA2)
    for (const field of ['ownerId', 'authorId', 'versionId', 'sectionId']) {
      const forged = { installationId: inA2, collection: 'responses', data: answer, [field]: STUDENT_B }
      expect(await records.createRecord(forged as never)).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
    }
    expect(await recordCount(inA2)).toBe(before)
  })

  it('10. upgrading changes the active version and leaves old records where they are', async () => {
    as(PROFESSOR)
    v2 = ok(
      await lifecycle.publishVersion({
        sectionId: sectionA2,
        projectId,
        manifest: manifest('1.1.0', { hints: { access: 'shared', fields: { text: 'text' } } }),
        source: { 'views/student.tsx': '' },
        studentBundle: 'student2()',
        professorBundle: 'professor2()',
      }),
    )
    ok(await lifecycle.approveAndActivateVersion({ sectionId: sectionA2, installationId: inA2, versionId: v2 }))
    ok(await lifecycle.approveAndActivateVersion({ sectionId: A.section, installationId: inA, versionId: v2 }))
    expect(await currentVersion(inA2)).toBe(v2)

    const hint = ok(await records.createRecord({ installationId: inA2, collection: 'hints', data: { text: 'Start small' } }))
    const stamps = await sql<{ id: string; version_id: string }>(
      'select id, version_id from public.studio_plugin_records where id = any($1)',
      [[recordA, hint.id]],
    )
    expect(Object.fromEntries(stamps.map((s) => [s.id, s.version_id]))).toEqual({ [recordA]: v1, [hint.id]: v2 })

    as(STUDENT_A)
    expect(ok(await records.listRecords({ installationId: inA2, collection: 'responses' })).map((r) => r.id)).toEqual([recordA])
  })

  it('11. rolling back one installation leaves the other on its version', async () => {
    as(PROFESSOR)
    ok(await lifecycle.rollbackVersion({ sectionId: A.section, installationId: inA, versionId: v1 }))
    expect([await currentVersion(inA), await currentVersion(inA2)]).toEqual([v1, v2])
  })

  // Scenario 9 runs last: archiving ends the installation's writable life.
  it('9. an archived installation stays readable and accepts no writes', async () => {
    as(PROFESSOR)
    ok(await lifecycle.archiveInstallation({ sectionId: sectionA2, installationId: inA2 }))
    const before = await recordCount(inA2)

    expect(ok(await records.listRecords({ installationId: inA2, collection: 'questions' }))).toEqual([])
    expect(ok(await records.listRecords({ installationId: inA2, collection: 'responses' }))).toHaveLength(2)
    expect(
      await records.createRecord({ installationId: inA2, collection: 'questions', data: { prompt: 'x', skill: 'y', open: true } }),
    ).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
    expect((await lifecycle.approveAndActivateVersion({ sectionId: sectionA2, installationId: inA2, versionId: v1 })).ok).toBe(false)

    as(STUDENT_A)
    expect(ok(await records.listRecords({ installationId: inA2, collection: 'responses' })).map((r) => r.id)).toEqual([recordA])
    expect(await records.updateRecord({ installationId: inA2, collection: 'responses', recordId: recordA, data: answer })).toEqual({
      ok: false,
      error: RECORD_NOT_AVAILABLE,
    })
    expect(await records.deleteRecord({ installationId: inA2, collection: 'responses', recordId: recordA })).toEqual({
      ok: false,
      error: RECORD_NOT_AVAILABLE,
    })
    expect(await recordCount(inA2)).toBe(before)
  })

  it('12. every lifecycle step went through lifecycle.ts, and record audits carry no contents', () => {
    const events = vi.mocked(logEvent).mock.calls.map(([e]) => e)
    expect(events.filter((e) => e.eventType.startsWith('studio.') && !e.eventType.startsWith('studio.record.')).map((e) => e.eventType)).toEqual([
      'studio.project.created',
      'studio.version.published',
      'studio.plugin.installed',
      'studio.plugin.installed',
      'studio.version.published',
      'studio.version.activated',
      'studio.version.activated',
      'studio.version.rolled_back',
      'studio.installation.archived',
    ])
    const recordEvents = events.filter((e) => e.eventType.startsWith('studio.record.'))
    // Two student answers, the answer key, the section-A answer and the hint. Every refused write logged nothing.
    expect(recordEvents.length).toBe(5)
    for (const e of recordEvents) {
      expect(Object.keys(e.metadata ?? {}).sort()).toEqual(['collection', 'installationId', 'recordId', 'versionId'])
      expect(JSON.stringify(e)).not.toContain(SECRET)
    }
  })
})
