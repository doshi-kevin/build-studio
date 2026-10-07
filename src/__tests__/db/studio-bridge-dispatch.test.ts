/**
 * The Scholera Bridge's dispatch() against a real database: resolveViewer, the method
 * registry, Step 3's records.ts and the Step 2 guards, end to end (`npm run test:db`).
 *
 * Mocked, and only these: the session cookie (to act as a chosen fixture user),
 * publication.ts (students are exercised as if the installation were shown to them;
 * showing and hiding are tested in studio-publication.test.ts), and logEvent. Setup
 * goes through lifecycle.ts.
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

const lifecycle = await import('@/lib/studio/lifecycle')
const { resolveViewer } = await import('@/lib/studio/context')
const { dispatch } = await import('@/lib/studio/bridge/dispatch')
const { POST } = await import('@/app/api/studio/bridge/route')
const { rosterNamesAction } = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/roster-actions')

const A = FIXTURE.a
const PROFESSOR = A.users.professor.id
const TA = A.users.ta.id
const STUDENT_A = A.users.student.id
const STUDENT_B = FIXTURE.outsider.id
const HOST = { locale: 'en-US', timeZone: 'America/New_York' }
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

const run = `t${randomBytes(4).toString('hex')}`
const SLUG = `bd-${run}`

let db: Client
let restoreEntitlement: (() => Promise<void>) | undefined
let section = ''
let projectId = ''
let installation = ''

const manifest = (version: string, studentCapabilities: string[] = exitTicket.views.student.capabilities, slug = SLUG) => ({
  ...exitTicket,
  id: slug,
  version,
  views: { ...exitTicket.views, student: { ...exitTicket.views.student, capabilities: studentCapabilities } },
  collections: {
    ...exitTicket.collections,
    answerKeys: { access: 'staffOnly', fields: { questionId: 'text', correct: 'text' } },
  },
})

const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error)
  return r.value
}

/** dispatch() as the given user, exactly as the route calls it. */
async function call(userId: string, method: string, args: unknown) {
  session.userId = userId
  const viewer = await resolveViewer(installation)
  if (!viewer) return { ok: false as const, code: 'not_available' as const }
  return dispatch(viewer, { method, args, host: HOST })
}

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(text, params)).rows as T[]
}

beforeAll(async () => {
  const env = dbEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey
  db = new Client({ connectionString: env.pgUrl })
  await db.connect()
  restoreEntitlement = await grantStudio(db, A.institution)
  ;[{ id: section }] = await sql<{ id: string }>(
    `insert into public.course_sections (institution_id, course_id, section_code, semester, year, professor_id)
     values ($1, $2, $3, 'Fall', 2026, $4) returning id`,
    [A.institution, A.course, `BD-${run}`, PROFESSOR],
  )
  for (const student of [STUDENT_A, STUDENT_B]) {
    await sql(`insert into public.enrollments (section_id, student_id, status) values ($1, $2, 'enrolled')`, [section, student])
  }
  await sql(
    `insert into public.section_staff (section_id, staff_id, role, status, ends_at) values ($1, $2, 'ta', 'active', '2099-01-01')`,
    [section, TA],
  )

  session.userId = PROFESSOR
  projectId = ok(await lifecycle.createProject({ sectionId: section, slug: SLUG, name: 'Exit ticket' }))
  const v1 = ok(
    await lifecycle.publishVersion({
      sectionId: section, projectId, manifest: manifest('1.0.0'), source: {}, studentBundle: 's()', professorBundle: 'p()',
    }),
  )
  installation = ok(await lifecycle.installPlugin({ sectionId: section, versionId: v1 }))
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
  if (section) {
    await sql('delete from public.skills where section_id = $1 and parent_id is not null', [section])
    await sql('delete from public.skills where section_id = $1', [section])
    await sql('delete from public.section_staff where section_id = $1', [section])
    await sql('delete from public.enrollments where section_id = $1', [section])
    await sql('delete from public.course_sections where id = $1', [section])
  }
  await db.end()
})

const answer = { questionId: 'q1', answer: 'mine', confidence: 2 }

describe('Step 3 through dispatch()', () => {
  let recordA = ''
  let recordB = ''

  it('keeps each student to their own perStudent records', async () => {
    const a = await call(STUDENT_A, 'records.create', { collection: 'responses', data: answer })
    const b = await call(STUDENT_B, 'records.create', { collection: 'responses', data: { ...answer, answer: 'theirs' } })
    recordA = (a as { ok: true; data: { id: string } }).data.id
    recordB = (b as { ok: true; data: { id: string } }).data.id

    const list = await call(STUDENT_A, 'records.list', { collection: 'responses' })
    expect(list).toMatchObject({ ok: true, data: [{ id: recordA, mine: true }] })
    expect(await call(STUDENT_A, 'records.get', { collection: 'responses', recordId: recordB })).toMatchObject({ ok: false, code: 'not_available' })
    expect(await call(STUDENT_A, 'records.delete', { collection: 'responses', recordId: recordB })).toMatchObject({ ok: false, code: 'not_available' })
  })

  it('keeps staffOnly from students, and gives it to staff', async () => {
    expect(await call(PROFESSOR, 'records.create', { collection: 'answerKeys', data: { questionId: 'q1', correct: 'x' } })).toMatchObject({ ok: true })
    expect(await call(STUDENT_A, 'records.list', { collection: 'answerKeys' })).toMatchObject({ ok: false, code: 'not_available' })
    expect(await call(TA, 'records.list', { collection: 'answerKeys' })).toMatchObject({ ok: true, data: [expect.any(Object)] })
  })

  it('won’t let a caller choose the installation, owner, author or version, and stamps the real ones', async () => {
    for (const extra of ['installationId', 'ownerId', 'authorId', 'versionId']) {
      const forged = await call(STUDENT_A, 'records.create', { collection: 'responses', data: answer, [extra]: crypto.randomUUID() })
      expect(forged, extra).toMatchObject({ ok: false, code: 'invalid' })
    }
    const [row] = await sql('select installation_id, owner_id, author_id, section_id from public.studio_plugin_records where id = $1', [recordA])
    expect(row).toEqual({ installation_id: installation, owner_id: STUDENT_A, author_id: STUDENT_A, section_id: section })
  })

  it('answers context.get from the database with no IDs, and refuses methods that don’t exist', async () => {
    const context = await call(PROFESSOR, 'context.get', null)
    expect(context).toMatchObject({ ok: true, data: { view: 'professor', course: { code: 'CA101', title: 'Course A' }, readOnly: false } })
    expect(JSON.stringify(context)).not.toMatch(UUID)
    expect(await call(PROFESSOR, 'course.weakSpots', null)).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('refuses a capability the current version stops declaring', async () => {
    expect(await call(STUDENT_A, 'context.get', null)).toMatchObject({ ok: true })
    session.userId = PROFESSOR
    const v2 = ok(
      await lifecycle.publishVersion({
        sectionId: section, projectId, manifest: manifest('1.1.0', ['ui.resize']), source: {}, studentBundle: 's2()', professorBundle: 'p2()',
      }),
    )
    ok(await lifecycle.approveAndActivateVersion({ sectionId: section, installationId: installation, versionId: v2 }))
    expect(await call(STUDENT_A, 'context.get', null)).toMatchObject({ ok: false, code: 'not_available' })
  })

  it('keeps an archived installation readable and refuses writes', async () => {
    session.userId = PROFESSOR
    ok(await lifecycle.archiveInstallation({ sectionId: section, installationId: installation }))
    expect(await call(STUDENT_A, 'records.list', { collection: 'responses' })).toMatchObject({ ok: true, data: [{ id: recordA }] })
    expect(await call(STUDENT_A, 'records.create', { collection: 'responses', data: answer })).toMatchObject({ ok: false, code: 'not_available' })
    expect(await call(PROFESSOR, 'context.get', null)).toMatchObject({ ok: true, data: { readOnly: true } })
  })
})

// A second plugin in the same section, so these tests don't depend on the flow above
// (which ends by archiving its installation).
describe('course.skills and stale frames', () => {
  const slug = `bs-${run}`
  let project = ''
  let install = ''
  let v1 = ''
  let v2 = ''

  const publish = (version: string, code: string) =>
    lifecycle.publishVersion({
      sectionId: section, projectId: project, manifest: manifest(version, undefined, slug), source: {}, studentBundle: code, professorBundle: code,
    })

  /** The bridge route end to end, exactly as the host calls it. */
  async function bridge(userId: string, expectedVersionId: string, method: string, args: unknown) {
    session.userId = userId
    const res = await POST(
      new Request('http://localhost:3000/api/studio/bridge', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, type: 'call', installationId: install, expectedVersionId, method, args, host: HOST }),
      }),
    )
    return res.json()
  }

  beforeAll(async () => {
    process.env.STUDIO_RUNTIME_ORIGIN = 'http://127.0.0.1:3000'
    process.env.SITE_URL = 'http://localhost:3000'
    session.userId = PROFESSOR
    project = ok(await lifecycle.createProject({ sectionId: section, slug, name: 'Skills check' }))
    v1 = ok(await publish('1.0.0', 'one()'))
    v2 = ok(await publish('1.1.0', 'two()'))
    install = ok(await lifecycle.installPlugin({ sectionId: section, versionId: v1 }))

    const insert = async (name: string, extra: Record<string, unknown> = {}) => {
      const cols = ['institution_id', 'section_id', 'name', ...Object.keys(extra)]
      const values = [A.institution, section, name, ...Object.values(extra)]
      const [row] = await sql<{ id: string }>(
        `insert into public.skills (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
        values,
      )
      return row.id
    }
    const recursion = await insert('Recursion', { info: 'Functions that call themselves', position: 1 })
    await insert('Base cases', { parent_id: recursion, position: 2 })
    const dropped = await insert('Dropped topic', { excluded: true, position: 3 })
    await insert('Orphaned subtopic', { parent_id: dropped, position: 4 })
    await insert('Suggested topic', { suppressed: true, position: 5 })
  })

  afterAll(async () => {
    delete process.env.STUDIO_RUNTIME_ORIGIN
    delete process.env.SITE_URL
    if (!project) return
    await sql('delete from public.studio_plugin_records where installation_id in (select id from public.studio_plugin_installations where project_id = $1)', [project])
    await sql('delete from public.studio_plugin_installations where project_id = $1', [project])
    await sql('delete from public.studio_plugin_versions where project_id = $1', [project])
    await sql('delete from public.studio_plugin_projects where id = $1', [project])
  })

  it('course.skills returns visible skills only, parent names only when the parent is visible, and no IDs', async () => {
    const result = await bridge(PROFESSOR, v1, 'course.skills', null)
    expect(result).toEqual({
      ok: true,
      data: [
        { name: 'Recursion', info: 'Functions that call themselves', parent: null },
        { name: 'Base cases', info: null, parent: 'Recursion' },
        { name: 'Orphaned subtopic', info: null, parent: null },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(UUID)
  })

  it('course.skills is refused for a view that doesn’t declare it', async () => {
    // The fixture's student view declares context.get and ui.resize, not course.skills.
    expect(await bridge(STUDENT_A, v1, 'course.skills', null)).toMatchObject({ ok: false, error: { code: 'not_available' } })
  })

  it('an upgrade makes the open frame stale: it can no longer read or write', async () => {
    expect(await bridge(STUDENT_A, v1, 'records.create', { collection: 'responses', data: answer })).toMatchObject({ ok: true })
    session.userId = PROFESSOR
    ok(await lifecycle.approveAndActivateVersion({ sectionId: section, installationId: install, versionId: v2 }))

    const count = async () =>
      Number((await sql<{ n: string }>('select count(*) as n from public.studio_plugin_records where installation_id = $1', [install]))[0].n)
    const before = await count()
    expect(await bridge(STUDENT_A, v1, 'records.create', { collection: 'responses', data: answer })).toMatchObject({ ok: false, error: { code: 'stale' } })
    expect(await bridge(STUDENT_A, v1, 'records.list', { collection: 'responses' })).toMatchObject({ ok: false, error: { code: 'stale' } })
    expect(await count()).toBe(before)
  })

  it('a fresh frame for the current version works', async () => {
    expect(await bridge(STUDENT_A, v2, 'records.list', { collection: 'responses' })).toMatchObject({ ok: true, data: [expect.any(Object)] })
  })

  it('a rollback makes the newer frame stale too', async () => {
    session.userId = PROFESSOR
    ok(await lifecycle.rollbackVersion({ sectionId: section, installationId: install, versionId: v1 }))
    expect(await bridge(STUDENT_A, v2, 'records.list', { collection: 'responses' })).toMatchObject({ ok: false, error: { code: 'stale' } })
    expect(await bridge(STUDENT_A, v1, 'records.list', { collection: 'responses' })).toMatchObject({ ok: true })
  })
})

// Step 11: a third plugin, an attendance tracker. Staff mark each student by handle; each
// student reads only their own marks.
describe('course.roster, staffPerStudent, records.batch and course.assignments', () => {
  const slug = `ba-${run}`
  let project = ''
  let install = ''
  // A second attendance tool in the same section: its handles must name no one in the first.
  let otherProject = ''
  let otherInstall = ''
  const attendance = (s = slug) => ({
    ...manifest('1.0.0', ['context.get', 'course.assignments'], s),
    views: {
      student: { entry: 'views/student.tsx', capabilities: ['context.get', 'course.assignments'] },
      professor: { entry: 'views/professor.tsx', capabilities: ['context.get', 'course.roster', 'course.assignments'] },
    },
    collections: { ...exitTicket.collections, attendance: { access: 'staffPerStudent', fields: { status: 'text' } } },
  })

  async function as(userId: string, method: string, args: unknown, on = install) {
    session.userId = userId
    const viewer = await resolveViewer(on)
    if (!viewer) return { ok: false as const, code: 'not_available' as const }
    return dispatch(viewer, { method, args, host: HOST })
  }
  const dataOf = <T,>(r: unknown) => (r as { ok: true; data: T }).data
  let handles: string[] = []
  const handleOf = async (studentId: string) => {
    const [row] = await sql<{ id: string }>(
      `select id from public.studio_plugin_records where installation_id = $1 and owner_id = $2 and collection = 'attendance' limit 1`,
      [install, studentId],
    )
    const list = dataOf<{ id: string; student?: string }[]>(await as(PROFESSOR, 'records.list', { collection: 'attendance' }))
    return list.find((r) => r.id === row.id)?.student
  }

  beforeAll(async () => {
    session.userId = PROFESSOR
    project = ok(await lifecycle.createProject({ sectionId: section, slug, name: 'Attendance' }))
    const v1 = ok(await lifecycle.publishVersion({ sectionId: section, projectId: project, manifest: attendance(), source: {}, studentBundle: 's()', professorBundle: 'p()' }))
    install = ok(await lifecycle.installPlugin({ sectionId: section, versionId: v1 }))
    otherProject = ok(await lifecycle.createProject({ sectionId: section, slug: `${slug}-2`, name: 'Attendance 2' }))
    const otherV1 = ok(await lifecycle.publishVersion({ sectionId: section, projectId: otherProject, manifest: attendance(`${slug}-2`), source: {}, studentBundle: 's()', professorBundle: 'p()' }))
    otherInstall = ok(await lifecycle.installPlugin({ sectionId: section, versionId: otherV1 }))
    const add = (title: string, status: string, due: string | null, graded = true) =>
      sql(
        `insert into public.assignments (section_id, institution_id, created_by, title, status, due_at, points, is_graded)
         values ($1, $2, $3, $4, $5, $6, 20, $7)`,
        [section, A.institution, PROFESSOR, title, status, due, graded],
      )
    await add('Lab 2', 'published', '2026-11-02T17:00:00Z')
    await add('Lab 1', 'closed', '2026-10-20T17:00:00Z')
    await add('Reading log', 'published', null, false)
    await add('Final project (draft)', 'draft', '2026-12-01T17:00:00Z')
  })

  afterAll(async () => {
    if (!project) return
    await sql('delete from public.assignments where section_id = $1', [section])
    for (const p of [project, otherProject].filter(Boolean)) {
      await sql('delete from public.studio_plugin_records where installation_id in (select id from public.studio_plugin_installations where project_id = $1)', [p])
      await sql('delete from public.studio_plugin_installations where project_id = $1', [p])
      await sql('delete from public.studio_plugin_versions where project_id = $1', [p])
      await sql('delete from public.studio_plugin_projects where id = $1', [p])
    }
  })

  it('course.roster gives staff one handle per enrolled student, sorted, with no IDs or names', async () => {
    const roster = await as(TA, 'course.roster', null)
    handles = dataOf<{ students: { handle: string }[] }>(roster).students.map((s) => s.handle)
    expect(handles).toHaveLength(2)
    expect(handles).toEqual([...handles].sort())
    expect(handles.every((h) => /^st_[0-9a-v]{20}$/.test(h))).toBe(true)
    expect(JSON.stringify(roster)).not.toMatch(UUID)
    expect(await as(STUDENT_A, 'course.roster', null)).toMatchObject({ ok: false, code: 'not_available' })
  })

  it('a professor marks a student by handle; the record is the student’s, written by the professor', async () => {
    const result = await as(PROFESSOR, 'records.create', { collection: 'attendance', data: { status: 'present' }, student: handles[0] })
    expect(result).toMatchObject({ ok: true, data: { student: handles[0], mine: false } })
    const [row] = await sql<{ owner_id: string; author_id: string }>('select owner_id, author_id from public.studio_plugin_records where id = $1', [
      dataOf<{ id: string }>(result).id,
    ])
    expect(row.author_id).toBe(PROFESSOR)
    expect([STUDENT_A, STUDENT_B]).toContain(row.owner_id)
  })

  it('a handle from nowhere, a student ID, or a student writing are all refused', async () => {
    expect(await as(PROFESSOR, 'records.create', { collection: 'attendance', data: { status: 'present' }, student: 'st_00000000000000000000' })).toMatchObject({
      ok: false,
      code: 'not_available',
    })
    expect(await as(PROFESSOR, 'records.create', { collection: 'attendance', data: { status: 'present' }, student: STUDENT_A })).toMatchObject({
      ok: false,
      code: 'invalid',
    })
    expect(await as(STUDENT_A, 'records.create', { collection: 'attendance', data: { status: 'present' } })).toMatchObject({ ok: false, code: 'not_available' })
  })

  it('a handle from another tool’s installation in the same section names no one there', async () => {
    const theirs = dataOf<{ students: { handle: string }[] }>(await as(TA, 'course.roster', null, otherInstall)).students.map((s) => s.handle)
    expect(theirs).toHaveLength(2)
    expect(theirs.filter((h) => handles.includes(h))).toEqual([])
    expect(await as(PROFESSOR, 'records.create', { collection: 'attendance', data: { status: 'present' }, student: handles[0] }, otherInstall)).toMatchObject({
      ok: false,
      code: 'not_available',
    })
    expect(await sql('select id from public.studio_plugin_records where installation_id = $1', [otherInstall])).toEqual([])
  })

  it('records.batch marks the class in one call, item by item', async () => {
    const result = await as(TA, 'records.batch', {
      collection: 'attendance',
      items: [
        { op: 'create', data: { status: 'late' }, student: handles[1] },
        { op: 'create', data: { status: 'late' }, student: 'st_00000000000000000000' },
        { op: 'create', data: { status: 4 }, student: handles[1] },
      ],
    })
    const { results } = dataOf<{ results: { ok: boolean; code?: string; record?: { student?: string } }[] }>(result)
    expect(results).toMatchObject([{ ok: true, record: { student: handles[1] } }, { ok: false, code: 'not_available' }, { ok: false, code: 'invalid' }])
  })

  it('each student reads only their own marks, with no handle; staff see every handle', async () => {
    const mineA = dataOf<Record<string, unknown>[]>(await as(STUDENT_A, 'records.list', { collection: 'attendance' }))
    const mineB = dataOf<Record<string, unknown>[]>(await as(STUDENT_B, 'records.list', { collection: 'attendance' }))
    expect(mineA).toHaveLength(1)
    expect(mineB).toHaveLength(1)
    expect([...mineA, ...mineB].every((r) => r.mine === true && !('student' in r))).toBe(true)
    expect(new Set([await handleOf(STUDENT_A), await handleOf(STUDENT_B)])).toEqual(new Set(handles))
  })

  it('rosterNamesAction gives staff a name for every handle, and a student nothing', async () => {
    session.userId = PROFESSOR
    const names = await rosterNamesAction({ installationId: install })
    expect('names' in names && Object.keys(names.names).sort()).toEqual(handles)
    expect('names' in names && Object.values(names.names).every((n) => typeof n === 'string' && n.length > 0)).toBe(true)
    session.userId = STUDENT_A
    expect(await rosterNamesAction({ installationId: install })).toEqual({ error: expect.any(String) })
  })

  it('course.assignments lists released assignments by due date, undated last, with no IDs', async () => {
    const result = await as(STUDENT_A, 'course.assignments', null)
    expect(result).toEqual({
      ok: true,
      data: {
        assignments: [
          { title: 'Lab 1', dueAt: expect.stringMatching(/^2026-10-20/), points: 20 },
          { title: 'Lab 2', dueAt: expect.stringMatching(/^2026-11-02/), points: 20 },
          { title: 'Reading log', dueAt: null, points: null },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toMatch(UUID)
  })

  it('a student who drops leaves the roster, and a cached handle for them writes nothing', async () => {
    const stale = await handleOf(STUDENT_B)
    expect(handles).toContain(stale)
    const marks = async () => (await sql('select id from public.studio_plugin_records where installation_id = $1', [install])).length
    await sql(`update public.enrollments set status = 'dropped' where section_id = $1 and student_id = $2`, [section, STUDENT_B])
    try {
      const roster = dataOf<{ students: { handle: string }[] }>(await as(TA, 'course.roster', null)).students.map((s) => s.handle)
      expect(roster).toEqual(handles.filter((h) => h !== stale))
      const before = await marks()
      expect(await as(PROFESSOR, 'records.create', { collection: 'attendance', data: { status: 'absent' }, student: stale })).toMatchObject({
        ok: false,
        code: 'not_available',
      })
      expect(await marks()).toBe(before)
    } finally {
      await sql(`update public.enrollments set status = 'enrolled' where section_id = $1 and student_id = $2`, [section, STUDENT_B])
    }
  })
})
