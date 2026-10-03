/**
 * The trusted record service, with its context and database layers mocked. What's under
 * test is the orchestration: which requests reach the database, with which scope and
 * stamps, and what gets audited. Database-level guarantees are in db/studio-storage.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import { parseManifest } from '@/lib/studio/manifest'
import { STUDIO_RECORD_BATCH_MAX, STUDIO_RECORD_PAGE_MAX } from '@/lib/studio/limits'
import { studentHandle } from '@/lib/studio/handles'
import type { StudioViewer } from '@/lib/studio/context'
import type { InstallationState, ViewerRole } from '@/lib/studio/policy'

vi.mock('@/lib/studio/context', () => ({ resolveViewer: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({
  listRecords: vi.fn(),
  getRecord: vi.fn(),
  insertRecord: vi.fn(),
  updateRecord: vi.fn(),
  deleteRecord: vi.fn(),
  loadInstallationHandleSalt: vi.fn(),
  loadSectionRoster: vi.fn(),
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))

const { resolveViewer } = await import('@/lib/studio/context')
const db = await import('@/lib/studio/db')
const { logEvent } = await import('@/lib/supabase/event-logger')
const records = await import('@/lib/studio/records')
const { RECORD_NOT_AVAILABLE, RECORD_FULL, RECORD_FULL_STUDENT } = records

const parsed = parseManifest({
  ...exitTicket,
  collections: {
    ...exitTicket.collections,
    answerKeys: { access: 'staffOnly', fields: { questionId: 'text', correct: 'text' } },
    attendance: { access: 'staffPerStudent', fields: { status: 'text' } },
  },
})
if (!parsed.ok) throw new Error('fixture manifest is invalid')
const manifest = parsed.manifest

const INSTALLATION = crypto.randomUUID()
const SECTION = crypto.randomUUID()
const INSTITUTION = crypto.randomUUID()
const VERSION = crypto.randomUUID()
const RECORD = crypto.randomUUID()
const USERS: Record<ViewerRole, string> = {
  student: crypto.randomUUID(),
  professor: crypto.randomUUID(),
  ta: crypto.randomUUID(),
  grader: crypto.randomUUID(),
}
const STAFF: ViewerRole[] = ['professor', 'ta', 'grader']
const SALT = 'f'.repeat(64)
// Two enrolled students: the viewing student and a classmate.
const CLASSMATE = crypto.randomUUID()
const handleOf = (studentId: string) => studentHandle(SALT, studentId)

function viewAs(role: ViewerRole, state: InstallationState = 'active') {
  const viewer = {
    userId: USERS[role],
    role,
    installationId: INSTALLATION,
    installationState: state,
    sectionId: SECTION,
    institutionId: INSTITUTION,
    versionId: VERSION,
    manifest,
    // context.ts also turns this off for an archived section, a lost entitlement and a
    // completed enrollment; studio-context.test.ts covers those. Here, archive stands in.
    writable: state === 'active',
  } as StudioViewer
  vi.mocked(resolveViewer).mockResolvedValue(viewer)
  return viewer
}

const SECRET = 'my private answer about recursion'
const ANSWER = { questionId: 'q1', answer: SECRET, confidence: 2 }
const QUESTION = { prompt: 'What was unclear?', skill: 'recursion', open: true }
const KEY = { questionId: 'q1', correct: 'base case' }

function row(ownerId: string | null, authorId: string, data: Record<string, unknown> = ANSWER) {
  return { id: RECORD, ownerId, authorId, data, createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' }
}

const target = (collection: string) => ({ installationId: INSTALLATION, collection })

/** Every write and read entry point, for "nothing reached the database" checks. */
const DB_CALLS = () => [db.listRecords, db.getRecord, db.insertRecord, db.updateRecord, db.deleteRecord].map((f) => vi.mocked(f).mock.calls.length)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.insertRecord).mockImplementation(async (stamps, data) => ({
    ok: true,
    value: row(stamps.ownerId, stamps.authorId, data),
  }))
  vi.mocked(db.updateRecord).mockResolvedValue({ ok: true, value: row(USERS.student, USERS.student) })
  vi.mocked(db.deleteRecord).mockResolvedValue({ ok: true, value: true })
  vi.mocked(db.listRecords).mockResolvedValue([])
  vi.mocked(db.getRecord).mockResolvedValue(null)
  vi.mocked(db.loadInstallationHandleSalt).mockResolvedValue(SALT)
  vi.mocked(db.loadSectionRoster).mockResolvedValue(
    [USERS.student, CLASSMATE].map((id) => ({ id, firstName: 'Ada', lastName: 'Lovelace', name: null })),
  )
})

describe('stamps come from the trusted context, never the request', () => {
  it('a student’s perStudent record is owned and authored by them, under the current version', async () => {
    viewAs('student')
    const result = await records.createRecord({ ...target('responses'), data: ANSWER })

    expect(result).toMatchObject({ ok: true, value: { mine: true, data: ANSWER } })
    expect(db.insertRecord).toHaveBeenCalledWith(
      {
        institutionId: INSTITUTION,
        sectionId: SECTION,
        installationId: INSTALLATION,
        versionId: VERSION,
        collection: 'responses',
        ownerId: USERS.student,
        authorId: USERS.student,
      },
      ANSWER,
    )
  })

  it('a shared record written by a TA has no owner', async () => {
    viewAs('ta')
    await records.createRecord({ ...target('questions'), data: QUESTION })
    expect(vi.mocked(db.insertRecord).mock.calls[0][0]).toMatchObject({ ownerId: null, authorId: USERS.ta })
  })

  it.each(['userId', 'ownerId', 'authorId', 'versionId', 'institutionId', 'sectionId', 'role'])(
    'refuses a request that names %s, before resolving anything',
    async (field) => {
      viewAs('student')
      const result = await records.createRecord({ ...target('responses'), data: ANSWER, [field]: USERS.professor } as never)
      expect(result).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
      expect(resolveViewer).not.toHaveBeenCalled()
      expect(DB_CALLS()).toEqual([0, 0, 0, 0, 0])
    },
  )

  it('an update is re-stamped with the current version, whatever version wrote the record', async () => {
    viewAs('student')
    await records.updateRecord({ ...target('responses'), recordId: RECORD, data: ANSWER })
    expect(vi.mocked(db.updateRecord).mock.calls[0][2]).toMatchObject({ versionId: VERSION })
  })
})

describe('students', () => {
  it('list and get their own perStudent records only, filtered in the query', async () => {
    viewAs('student')
    await records.listRecords(target('responses'))
    await records.getRecord({ ...target('responses'), recordId: RECORD })

    const scope = { installationId: INSTALLATION, collection: 'responses', owner: { only: USERS.student } }
    expect(db.listRecords).toHaveBeenCalledWith(scope, { limit: STUDIO_RECORD_PAGE_MAX, offset: 0 })
    expect(db.getRecord).toHaveBeenCalledWith(scope, RECORD)
  })

  it('get "not available" for another student’s record, the same as for a missing one', async () => {
    viewAs('student')
    // The owner filter makes the database return nothing for someone else's record.
    vi.mocked(db.getRecord).mockResolvedValue(null)
    expect(await records.getRecord({ ...target('responses'), recordId: RECORD })).toEqual({
      ok: false,
      error: RECORD_NOT_AVAILABLE,
    })
  })

  it('can update and delete only within the same owner filter', async () => {
    viewAs('student')
    await records.updateRecord({ ...target('responses'), recordId: RECORD, data: ANSWER })
    await records.deleteRecord({ ...target('responses'), recordId: RECORD })
    const scope = { installationId: INSTALLATION, collection: 'responses', owner: { only: USERS.student } }
    expect(vi.mocked(db.updateRecord).mock.calls[0][0]).toEqual(scope)
    expect(vi.mocked(db.deleteRecord).mock.calls[0][0]).toEqual(scope)
  })

  it('never reach staffOnly data: every operation is refused before the database', async () => {
    viewAs('student')
    const results = [
      await records.listRecords(target('answerKeys')),
      await records.getRecord({ ...target('answerKeys'), recordId: RECORD }),
      await records.createRecord({ ...target('answerKeys'), data: KEY }),
      await records.updateRecord({ ...target('answerKeys'), recordId: RECORD, data: KEY }),
      await records.deleteRecord({ ...target('answerKeys'), recordId: RECORD }),
    ]
    expect(results.every((r) => !r.ok && r.error === RECORD_NOT_AVAILABLE)).toBe(true)
    expect(DB_CALLS()).toEqual([0, 0, 0, 0, 0])
  })

  it('read shared records but can’t write them', async () => {
    viewAs('student')
    expect((await records.listRecords(target('questions'))).ok).toBe(true)
    expect(await records.createRecord({ ...target('questions'), data: QUESTION })).toEqual({
      ok: false,
      error: RECORD_NOT_AVAILABLE,
    })
    expect(db.insertRecord).not.toHaveBeenCalled()
  })
})

describe('staff', () => {
  it.each(STAFF)('%s reads every perStudent record in the installation', async (role) => {
    viewAs(role)
    await records.listRecords(target('responses'))
    expect(vi.mocked(db.listRecords).mock.calls[0][0]).toEqual({
      installationId: INSTALLATION,
      collection: 'responses',
      owner: 'any',
    })
  })

  it.each(STAFF)('%s can’t write a student’s perStudent record', async (role) => {
    viewAs(role)
    const result = await records.createRecord({ ...target('responses'), data: ANSWER })
    expect(result).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
    expect(db.insertRecord).not.toHaveBeenCalled()
  })

  it.each(['questions', 'answerKeys'])('a grader reads %s but can’t create, update or delete', async (collection) => {
    viewAs('grader')
    const data = collection === 'questions' ? QUESTION : KEY
    expect((await records.listRecords(target(collection))).ok).toBe(true)
    await records.createRecord({ ...target(collection), data })
    await records.updateRecord({ ...target(collection), recordId: RECORD, data })
    await records.deleteRecord({ ...target(collection), recordId: RECORD })
    expect(DB_CALLS().slice(2)).toEqual([0, 0, 0])
  })
})

const PRESENT = { status: 'present' }

describe('staffPerStudent: staff write about one student, who reads only their own', () => {
  it.each(['professor', 'ta'] as const)('a %s’s record is owned by the student its handle names and authored by them', async (role) => {
    viewAs(role)
    const result = await records.createRecord({ ...target('attendance'), data: PRESENT, student: handleOf(CLASSMATE) })

    expect(vi.mocked(db.insertRecord).mock.calls[0][0]).toMatchObject({ ownerId: CLASSMATE, authorId: USERS[role] })
    expect(result).toMatchObject({ ok: true, value: { student: handleOf(CLASSMATE), mine: false } })
    expect(db.loadSectionRoster).toHaveBeenCalledWith(SECTION)
  })

  it('a handle that names no one in this section gets the same answer as any refusal, and writes nothing', async () => {
    viewAs('professor')
    const otherInstallation = studentHandle('0'.repeat(64), CLASSMATE)
    for (const handle of [otherInstallation, handleOf(crypto.randomUUID()), 'st_00000000000000000000']) {
      expect(await records.createRecord({ ...target('attendance'), data: PRESENT, student: handle })).toEqual({
        ok: false,
        error: RECORD_NOT_AVAILABLE,
      })
    }
    expect(db.insertRecord).not.toHaveBeenCalled()
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('a create without a student is invalid', async () => {
    viewAs('professor')
    const result = await records.createRecord({ ...target('attendance'), data: PRESENT })
    expect(result).toMatchObject({ ok: false, issues: [expect.stringMatching(/^student: /)] })
    expect(db.insertRecord).not.toHaveBeenCalled()
  })

  it.each([
    ['professor', 'questions', QUESTION],
    ['student', 'responses', ANSWER],
  ] as const)('a %s naming a student on %s is invalid', async (role, collection, data) => {
    viewAs(role)
    const result = await records.createRecord({ ...target(collection), data, student: handleOf(CLASSMATE) })
    expect(result).toMatchObject({ ok: false, issues: [expect.stringMatching(/^student: /)] })
    expect(db.insertRecord).not.toHaveBeenCalled()
  })

  it('a student ID in place of a handle is refused before anything is resolved', async () => {
    viewAs('professor')
    expect(await records.createRecord({ ...target('attendance'), data: PRESENT, student: CLASSMATE })).toEqual({
      ok: false,
      error: RECORD_NOT_AVAILABLE,
    })
    expect(resolveViewer).not.toHaveBeenCalled()
  })

  it('a student reads only their own, gets no handle, and can’t write', async () => {
    viewAs('student')
    vi.mocked(db.listRecords).mockResolvedValue([row(USERS.student, USERS.professor, PRESENT)])
    const list = await records.listRecords(target('attendance'))
    expect(vi.mocked(db.listRecords).mock.calls[0][0]).toEqual({ installationId: INSTALLATION, collection: 'attendance', owner: { only: USERS.student } })
    expect(list).toMatchObject({ ok: true, value: [{ mine: true }] })
    expect(list.ok && 'student' in list.value[0]).toBe(false)

    const writes = [
      await records.createRecord({ ...target('attendance'), data: PRESENT }),
      await records.createRecord({ ...target('attendance'), data: PRESENT, student: handleOf(USERS.student) }),
      await records.updateRecord({ ...target('attendance'), recordId: RECORD, data: PRESENT }),
      await records.deleteRecord({ ...target('attendance'), recordId: RECORD }),
    ]
    expect(writes.every((r) => !r.ok && r.error === RECORD_NOT_AVAILABLE)).toBe(true)
    expect(DB_CALLS().slice(2)).toEqual([0, 0, 0])
    expect(db.loadInstallationHandleSalt).not.toHaveBeenCalled()
  })

  it('a grader reads every student’s but writes none', async () => {
    viewAs('grader')
    expect((await records.listRecords(target('attendance'))).ok).toBe(true)
    expect(await records.createRecord({ ...target('attendance'), data: PRESENT, student: handleOf(CLASSMATE) })).toEqual({
      ok: false,
      error: RECORD_NOT_AVAILABLE,
    })
    expect(db.insertRecord).not.toHaveBeenCalled()
  })

  it.each(['responses', 'attendance'])('staff reading %s see each record’s student handle, never an ID', async (collection) => {
    viewAs('professor')
    vi.mocked(db.listRecords).mockResolvedValue([row(USERS.student, USERS.student), row(CLASSMATE, USERS.professor, PRESENT)])
    const list = await records.listRecords(target(collection))
    expect(list).toMatchObject({ ok: true, value: [{ student: handleOf(USERS.student) }, { student: handleOf(CLASSMATE) }] })
    expect(JSON.stringify(list)).not.toContain(USERS.student)
    expect(JSON.stringify(list)).not.toContain(CLASSMATE)
  })

  it('staff reading a shared collection get no handle, and the salt isn’t read', async () => {
    viewAs('professor')
    vi.mocked(db.listRecords).mockResolvedValue([row(null, USERS.professor, QUESTION)])
    const list = await records.listRecords(target('questions'))
    expect(list.ok && 'student' in list.value[0]).toBe(false)
    expect(db.loadInstallationHandleSalt).not.toHaveBeenCalled()
  })

  it('fails closed when the salt or the roster can’t be read', async () => {
    viewAs('professor')
    vi.mocked(db.loadSectionRoster).mockResolvedValue(null)
    expect(await records.createRecord({ ...target('attendance'), data: PRESENT, student: handleOf(CLASSMATE) })).toMatchObject({ ok: false })
    vi.mocked(db.loadInstallationHandleSalt).mockResolvedValue(null)
    expect((await records.listRecords(target('responses'))).ok).toBe(false)
    expect(db.insertRecord).not.toHaveBeenCalled()
  })
})

describe('records.batch', () => {
  const create = (student: string) => ({ op: 'create' as const, data: PRESENT, student })

  it('runs each item like its single method, in order, with partial failure, resolving the viewer and roster once', async () => {
    viewAs('professor')
    vi.mocked(db.deleteRecord).mockResolvedValueOnce({ ok: true, value: false })
    const result = await records.batchRecords({
      ...target('attendance'),
      items: [
        create(handleOf(USERS.student)),
        create(handleOf(crypto.randomUUID())),
        { op: 'create', data: { status: 3 }, student: handleOf(CLASSMATE) },
        create(handleOf(CLASSMATE)),
        { op: 'update', recordId: RECORD, data: PRESENT },
        { op: 'delete', recordId: RECORD },
      ],
    })

    expect(result.ok).toBe(true)
    const items = result.ok ? result.value : []
    expect(items.map((r) => (r.ok ? 'ok' : r.issues ? 'invalid' : r.error))).toEqual([
      'ok', RECORD_NOT_AVAILABLE, 'invalid', 'ok', 'ok', RECORD_NOT_AVAILABLE,
    ])
    expect(vi.mocked(db.insertRecord).mock.calls.map(([stamps]) => stamps.ownerId)).toEqual([USERS.student, CLASSMATE])
    expect(resolveViewer).toHaveBeenCalledTimes(1)
    expect(db.loadSectionRoster).toHaveBeenCalledTimes(1)
    expect(db.loadInstallationHandleSalt).toHaveBeenCalledTimes(1)
    // Each applied write is audited on its own; refusals aren't.
    expect(vi.mocked(logEvent).mock.calls.map(([e]) => e.eventType)).toEqual([
      'studio.record.create', 'studio.record.create', 'studio.record.update',
    ])
  })

  it('applies the policy to every item: a student’s batch on a staff collection writes nothing', async () => {
    viewAs('student')
    const result = await records.batchRecords({ ...target('attendance'), items: [{ op: 'create', data: PRESENT }, { op: 'delete', recordId: RECORD }] })
    expect(result).toEqual({ ok: true, value: [{ ok: false, error: RECORD_NOT_AVAILABLE }, { ok: false, error: RECORD_NOT_AVAILABLE }] })
    expect(DB_CALLS().slice(2)).toEqual([0, 0, 0])
  })

  it('a student’s batch of their own perStudent work is stamped like single creates', async () => {
    viewAs('student')
    await records.batchRecords({ ...target('responses'), items: [{ op: 'create', data: ANSWER }, { op: 'create', data: ANSWER }] })
    expect(vi.mocked(db.insertRecord).mock.calls.map(([s]) => [s.ownerId, s.authorId])).toEqual([
      [USERS.student, USERS.student],
      [USERS.student, USERS.student],
    ])
  })

  it.each([
    ['no items', []],
    ['too many items', Array.from({ length: STUDIO_RECORD_BATCH_MAX + 1 }, () => ({ op: 'create', data: ANSWER }))],
    ['an item naming an owner', [{ op: 'create', data: ANSWER, ownerId: USERS.professor }]],
  ])('refuses %s before resolving anything', async (_label, items) => {
    viewAs('student')
    expect(await records.batchRecords({ ...target('responses'), items } as never)).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
    expect(resolveViewer).not.toHaveBeenCalled()
  })

  it('refuses the whole batch when there is no viewer', async () => {
    vi.mocked(resolveViewer).mockResolvedValue(null)
    expect(await records.batchRecords({ ...target('responses'), items: [{ op: 'create', data: ANSWER }] })).toEqual({
      ok: false,
      error: RECORD_NOT_AVAILABLE,
    })
  })
})

describe('storage quota (the usage trigger refuses the write)', () => {
  const full = { ok: false as const, error: { code: '54000', message: 'Studio storage quota reached', full: 'installation' as const } }

  it('a create the quota refuses says so, and is logged with identifiers only', async () => {
    viewAs('student')
    vi.mocked(db.insertRecord).mockResolvedValue(full)
    expect(await records.createRecord({ ...target('responses'), data: ANSWER })).toEqual({ ok: false, error: RECORD_FULL })
    expect(logEvent).toHaveBeenCalledTimes(1)
    const event = vi.mocked(logEvent).mock.calls[0][0]
    expect(event.eventType).toBe('studio.record.quota_refused')
    expect(event.metadata).toEqual({ installationId: INSTALLATION, versionId: VERSION, collection: 'responses', operation: 'create', limit: 'installation' })
    expect(JSON.stringify(event)).not.toContain(SECRET)
  })

  it('a student who used their own allowance is told it’s theirs, not the class’s', async () => {
    viewAs('student')
    vi.mocked(db.insertRecord).mockResolvedValue({ ok: false, error: { ...full.error, full: 'student' } })
    expect(await records.createRecord({ ...target('responses'), data: ANSWER })).toEqual({ ok: false, error: RECORD_FULL_STUDENT })
  })

  it('an update the quota refuses says so too', async () => {
    viewAs('student')
    vi.mocked(db.updateRecord).mockResolvedValue(full)
    expect(await records.updateRecord({ ...target('responses'), recordId: RECORD, data: ANSWER })).toEqual({
      ok: false,
      error: RECORD_FULL,
    })
  })

  it('any other database failure stays a generic failure, not a quota message', async () => {
    viewAs('student')
    vi.mocked(db.insertRecord).mockResolvedValue({ ok: false, error: { code: '23514', message: 'check_violation' } })
    const result = await records.createRecord({ ...target('responses'), data: ANSWER })
    expect(result.ok).toBe(false)
    expect(result).not.toEqual({ ok: false, error: RECORD_FULL })
    expect(logEvent).not.toHaveBeenCalled()
  })
})

describe('archived installations are read-only for everyone', () => {
  it.each([
    ['student', 'responses', ANSWER],
    ['professor', 'questions', QUESTION],
    ['ta', 'answerKeys', KEY],
  ] as const)('%s can read %s but not write it', async (role, collection, data) => {
    viewAs(role, 'archived')
    expect((await records.listRecords(target(collection))).ok).toBe(true)
    expect((await records.getRecord({ ...target(collection), recordId: RECORD })).ok).toBe(false) // mock returns null
    expect(db.getRecord).toHaveBeenCalled()

    const writes = [
      await records.createRecord({ ...target(collection), data }),
      await records.updateRecord({ ...target(collection), recordId: RECORD, data }),
      await records.deleteRecord({ ...target(collection), recordId: RECORD }),
    ]
    expect(writes.every((r) => !r.ok && r.error === RECORD_NOT_AVAILABLE)).toBe(true)
    expect(DB_CALLS().slice(2)).toEqual([0, 0, 0])
    expect(logEvent).not.toHaveBeenCalled()
  })
})

describe('refusals look the same whatever the reason', () => {
  it('no viewer, unknown collection, a prototype name, staffOnly for a student, and a missing record all say the same thing', async () => {
    vi.mocked(resolveViewer).mockResolvedValue(null)
    const noViewer = await records.listRecords(target('responses'))

    viewAs('student')
    const unknown = await records.listRecords(target('grades'))
    const prototypeName = await records.listRecords(target('constructor'))
    const forbidden = await records.listRecords(target('answerKeys'))
    const missing = await records.getRecord({ ...target('responses'), recordId: RECORD })
    const badId = await records.getRecord({ ...target('responses'), recordId: 'not-a-uuid' })

    for (const r of [noViewer, unknown, prototypeName, forbidden, missing, badId]) {
      expect(r).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
    }
  })
})

describe('validation and limits', () => {
  it('returns field issues and writes nothing when data doesn’t match the collection', async () => {
    viewAs('student')
    const result = await records.createRecord({ ...target('responses'), data: { ...ANSWER, confidence: 'high' } })
    expect(result).toMatchObject({ ok: false, issues: [expect.stringMatching(/^confidence: /)] })
    expect(db.insertRecord).not.toHaveBeenCalled()
  })

  it('refuses a page larger than the limit', async () => {
    viewAs('professor')
    expect((await records.listRecords({ ...target('responses'), limit: STUDIO_RECORD_PAGE_MAX + 1 })).ok).toBe(false)
    expect(db.listRecords).not.toHaveBeenCalled()
  })

  it('reports a conflict only for a record the viewer can still see', async () => {
    viewAs('student')
    vi.mocked(db.updateRecord).mockResolvedValue({ ok: true, value: null })
    vi.mocked(db.getRecord).mockResolvedValueOnce(row(USERS.student, USERS.student))
    const stale = await records.updateRecord({
      ...target('responses'),
      recordId: RECORD,
      data: ANSWER,
      expectedUpdatedAt: '2026-09-29T00:00:00Z',
    })
    expect(stale).toEqual({ ok: false, error: expect.stringMatching(/Someone else changed this/) })

    const hidden = await records.updateRecord({
      ...target('responses'),
      recordId: RECORD,
      data: ANSWER,
      expectedUpdatedAt: '2026-09-29T00:00:00Z',
    })
    expect(hidden).toEqual({ ok: false, error: RECORD_NOT_AVAILABLE })
  })
})

describe('audit (rule 3.5)', () => {
  it('logs every write once, with identifiers only and never the record’s contents', async () => {
    viewAs('student')
    await records.createRecord({ ...target('responses'), data: ANSWER })
    await records.updateRecord({ ...target('responses'), recordId: RECORD, data: ANSWER })
    await records.deleteRecord({ ...target('responses'), recordId: RECORD })

    const events = vi.mocked(logEvent).mock.calls.map(([e]) => e)
    expect(events.map((e) => e.eventType)).toEqual(['studio.record.create', 'studio.record.update', 'studio.record.delete'])
    for (const e of events) {
      expect(e).toMatchObject({ userId: USERS.student, eventCategory: 'studio', sectionId: SECTION })
      expect(e.metadata).toEqual({ installationId: INSTALLATION, versionId: VERSION, collection: 'responses', recordId: RECORD })
      expect(JSON.stringify(e)).not.toContain(SECRET)
    }
  })

  it('logs nothing for reads, refusals or deletes that matched no record', async () => {
    viewAs('student')
    await records.listRecords(target('responses'))
    await records.createRecord({ ...target('answerKeys'), data: KEY })
    vi.mocked(db.deleteRecord).mockResolvedValue({ ok: true, value: false })
    expect(await records.deleteRecord({ ...target('responses'), recordId: RECORD })).toEqual({
      ok: false,
      error: RECORD_NOT_AVAILABLE,
    })
    expect(logEvent).not.toHaveBeenCalled()
  })
})
