/**
 * The trusted record service, with its context and database layers mocked. What's under
 * test is the orchestration: which requests reach the database, with which scope and
 * stamps, and what gets audited. Database-level guarantees are in db/studio-storage.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import { parseManifest } from '@/lib/studio/manifest'
import { STUDIO_RECORD_PAGE_MAX } from '@/lib/studio/limits'
import type { StudioViewer } from '@/lib/studio/context'
import type { InstallationState, ViewerRole } from '@/lib/studio/policy'

vi.mock('@/lib/studio/context', () => ({ resolveViewer: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({
  listRecords: vi.fn(),
  getRecord: vi.fn(),
  insertRecord: vi.fn(),
  updateRecord: vi.fn(),
  deleteRecord: vi.fn(),
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))

const { resolveViewer } = await import('@/lib/studio/context')
const db = await import('@/lib/studio/db')
const { logEvent } = await import('@/lib/supabase/event-logger')
const records = await import('@/lib/studio/records')
const { RECORD_NOT_AVAILABLE } = records

const parsed = parseManifest({
  ...exitTicket,
  collections: {
    ...exitTicket.collections,
    answerKeys: { access: 'staffOnly', fields: { questionId: 'text', correct: 'text' } },
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
