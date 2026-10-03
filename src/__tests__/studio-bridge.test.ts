/**
 * The Scholera Bridge: the streaming body cap, the envelope, the method registry,
 * dispatch(), context.get, the route handler's HTTP checks and rate limits, the host's
 * bridge client, and the preview bridge. Step 3 (records.ts) and the session are mocked;
 * db/studio-bridge-dispatch.test.ts drives the real Step 3 through dispatch().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import { parseManifest } from '@/lib/studio/manifest'
import { GOOD_MANIFEST } from '@/lib/studio/validator/fixtures'
import { decide } from '@/lib/studio/policy'
import type { StudioViewer } from '@/lib/studio/context'
import type { InstallationState, ViewerRole } from '@/lib/studio/policy'

vi.mock('@/lib/studio/context', () => ({ resolveViewer: vi.fn(), sessionUserId: vi.fn() }))
vi.mock('@/lib/studio/db', () => ({
  loadSectionCourse: vi.fn(),
  loadSectionSkills: vi.fn(),
  listSkillBindings: vi.fn(),
  listBindableSkills: vi.fn(),
  loadReleasedAssignments: vi.fn(),
  loadInstallationHandleSalt: vi.fn(),
  loadSectionRoster: vi.fn(),
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/studio/records', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/studio/records')>()
  return {
    RECORD_NOT_AVAILABLE: real.RECORD_NOT_AVAILABLE,
    RECORD_CONFLICT: real.RECORD_CONFLICT,
    RECORD_FULL: real.RECORD_FULL,
    RECORD_FULL_STUDENT: real.RECORD_FULL_STUDENT,
    listRecords: vi.fn(),
    getRecord: vi.fn(),
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
    deleteRecord: vi.fn(),
    batchRecords: vi.fn(),
  }
})

const { resolveViewer, sessionUserId } = await import('@/lib/studio/context')
const { loadSectionCourse, loadSectionSkills, listSkillBindings, listBindableSkills, loadReleasedAssignments, loadInstallationHandleSalt, loadSectionRoster } =
  await import('@/lib/studio/db')
const { logEvent } = await import('@/lib/supabase/event-logger')
const records = await import('@/lib/studio/records')
const { readBodyCapped } = await import('@/lib/studio/bridge/read-body')
const { parseBridgeEnvelope } = await import('@/lib/studio/bridge/envelope')
const { METHOD_CATALOG, allowedBridgeMethods } = await import('@/lib/studio/bridge/catalog')
const { SERVER_HANDLERS } = await import('@/lib/studio/bridge/registry')
const { dispatch } = await import('@/lib/studio/bridge/dispatch')
const { takeBridgeCall } = await import('@/lib/studio/bridge/rate-limit')
const { POST } = await import('@/app/api/studio/bridge/route')
const { createBridgeClient } = await import('@/lib/studio/runtime/bridge-client')
const { createPreviewBridge } = await import('@/lib/studio/runtime/preview-bridge')

const parsed = parseManifest({
  ...exitTicket,
  collections: { ...exitTicket.collections, answerKeys: { access: 'staffOnly', fields: { questionId: 'text', correct: 'text' } } },
})
if (!parsed.ok) throw new Error('fixture manifest is invalid')
const MANIFEST = parsed.manifest

const APP = 'http://localhost:3000'
const INSTALLATION = crypto.randomUUID()
const HOST = { locale: 'en-GB', timeZone: 'Europe/London' }
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

const VERSION = crypto.randomUUID()

function viewer(role: ViewerRole, state: InstallationState = 'active', manifest = MANIFEST): StudioViewer {
  return {
    userId: crypto.randomUUID(),
    role,
    installationId: INSTALLATION,
    installationState: state,
    sectionId: crypto.randomUUID(),
    institutionId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    versionId: VERSION,
    manifest,
    writable: state === 'active',
  } as StudioViewer
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadSectionCourse).mockResolvedValue({ code: 'CS101', title: 'Intro to Computing' })
})

// ── Body cap ──────────────────────────────────────────────────────────

function fakeRequest(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift()
      if (next) controller.enqueue(next)
      else controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  return { request: { headers: new Headers(headers), body } as unknown as Request, wasCancelled: () => cancelled }
}
const bytes = (n: number) => new Uint8Array(n).fill(120) // "x"

describe('readBodyCapped', () => {
  it('reads a body under the cap', async () => {
    const { request } = fakeRequest([new TextEncoder().encode('{"a":1}')])
    expect(await readBodyCapped(request, 64)).toEqual({ ok: true, text: '{"a":1}' })
  })

  it('refuses a declared length over the cap without reading', async () => {
    const { request } = fakeRequest([bytes(10)], { 'content-length': '100' })
    expect(await readBodyCapped(request, 64)).toEqual({ ok: false, reason: 'too-large' })
  })

  it('refuses a chunked body with no length once it passes the cap, and stops reading', async () => {
    const { request, wasCancelled } = fakeRequest([bytes(40), bytes(40), bytes(40)])
    expect(await readBodyCapped(request, 64)).toEqual({ ok: false, reason: 'too-large' })
    expect(wasCancelled()).toBe(true)
  })

  it('refuses a body larger than its own Content-Length claims', async () => {
    const { request } = fakeRequest([bytes(50), bytes(50)], { 'content-length': '10' })
    expect(await readBodyCapped(request, 64)).toEqual({ ok: false, reason: 'too-large' })
  })

  it.each([
    ['a non-numeric Content-Length', [bytes(1)], { 'content-length': 'ten' }],
    ['invalid UTF-8', [new Uint8Array([0xff, 0xfe])], {}],
  ])('refuses %s as unreadable', async (_label, chunks, headers) => {
    const { request } = fakeRequest(chunks, headers)
    expect(await readBodyCapped(request, 64)).toEqual({ ok: false, reason: 'unreadable' })
  })
})

// ── Envelope ──────────────────────────────────────────────────────────

const CALL = {
  v: 1,
  type: 'call',
  installationId: INSTALLATION,
  method: 'records.list',
  args: { collection: 'responses' },
  host: HOST,
  expectedVersionId: VERSION,
}

describe('bridge envelope', () => {
  it('accepts a call and a stop event', () => {
    expect(parseBridgeEnvelope(CALL)).toEqual(CALL)
    expect(parseBridgeEnvelope({ v: 1, type: 'event', installationId: INSTALLATION, reason: 'navigated' })).toMatchObject({ reason: 'navigated' })
  })

  it.each([
    ['a user ID', { ...CALL, userId: crypto.randomUUID() }],
    ['a role', { ...CALL, role: 'professor' }],
    ['a section ID', { ...CALL, sectionId: crypto.randomUUID() }],
    ['a version ID', { ...CALL, versionId: crypto.randomUUID() }],
    ['a frame ticket', { ...CALL, t: 'abc.def' }],
    ['another envelope version', { ...CALL, v: 2 }],
    ['an installation that isn’t a UUID', { ...CALL, installationId: 'x' }],
    ['a method that isn’t namespaced', { ...CALL, method: 'eval' }],
    ['no host settings', { ...CALL, host: undefined }],
    ['a host locale that isn’t one', { ...CALL, host: { ...HOST, locale: '<script>' } }],
    ['an event with data attached', { v: 1, type: 'event', installationId: INSTALLATION, reason: 'crashed', message: 'student text' }],
    ['an event reason that isn’t logged', { v: 1, type: 'event', installationId: INSTALLATION, reason: 'destroyed' }],
  ])('refuses %s', (_label, raw) => {
    expect(parseBridgeEnvelope(raw)).toBeNull()
  })
})

// ── Registry and dispatch ─────────────────────────────────────────────

describe('method catalog and server handlers', () => {
  it('lists every method once, with where it runs, its capability and its kind', () => {
    expect(
      Object.fromEntries(Object.entries(METHOD_CATALOG).map(([n, m]) => [n, [m.runs, m.capability, m.kind]])),
    ).toEqual({
      'context.get': ['server', 'context.get', 'read'],
      'course.skills': ['server', 'course.skills', 'read'],
      'course.roster': ['server', 'course.roster', 'read'],
      'course.assignments': ['server', 'course.assignments', 'read'],
      'records.list': ['server', null, 'read'],
      'records.get': ['server', null, 'read'],
      'records.create': ['server', null, 'write'],
      'records.update': ['server', null, 'write'],
      'records.delete': ['server', null, 'write'],
      'records.batch': ['server', null, 'write'],
      'ui.resize': ['host', 'ui.resize', 'read'],
      'ui.toast': ['host', 'ui.toast', 'read'],
    })
  })

  it('has a server handler for exactly the server methods, and none for host methods', () => {
    const server = Object.entries(METHOD_CATALOG).filter(([, m]) => m.runs === 'server').map(([n]) => n).sort()
    expect(Object.keys(SERVER_HANDLERS).sort()).toEqual(server)
  })

  it('allows a view only what its manifest declares', () => {
    const noContext = { ...MANIFEST, views: { ...MANIFEST.views, student: { ...MANIFEST.views.student, capabilities: [] } } }
    expect(allowedBridgeMethods(noContext, 'student')).not.toContain('context.get')
    expect(allowedBridgeMethods(MANIFEST, 'student')).toEqual(expect.arrayContaining(['context.get', 'ui.resize']))
    expect(allowedBridgeMethods(MANIFEST, 'student')).not.toContain('ui.toast')
    expect(allowedBridgeMethods({ ...MANIFEST, collections: {} }, 'professor')).toEqual(['context.get', 'course.skills', 'ui.resize', 'ui.toast'])
  })
})

describe('dispatch', () => {
  it('refuses a method that doesn’t exist, including prototype names', async () => {
    for (const method of ['course.weakSpots', 'records.drop', 'constructor.call']) {
      expect(await dispatch(viewer('professor'), { method, args: null, host: HOST })).toMatchObject({ ok: false, code: 'unsupported' })
    }
  })

  it('refuses a capability the view didn’t declare', async () => {
    const undeclared = { ...MANIFEST, views: { ...MANIFEST.views, student: { ...MANIFEST.views.student, capabilities: [] } } }
    const result = await dispatch(viewer('student', 'active', undeclared), { method: 'context.get', args: null, host: HOST })
    expect(result).toMatchObject({ ok: false, code: 'not_available' })
    expect(loadSectionCourse).not.toHaveBeenCalled()
  })

  it('refuses arguments that try to name the installation or anything else', async () => {
    const result = await dispatch(viewer('student'), {
      method: 'records.list',
      args: { collection: 'responses', installationId: crypto.randomUUID() },
      host: HOST,
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid' })
    expect(records.listRecords).not.toHaveBeenCalled()
  })

  it('routes records to Step 3 with the verified viewer’s installation', async () => {
    vi.mocked(records.listRecords).mockResolvedValue({ ok: true, value: [] })
    await dispatch(viewer('student'), { method: 'records.list', args: { collection: 'responses', limit: 5 }, host: HOST })
    expect(records.listRecords).toHaveBeenCalledWith({ collection: 'responses', limit: 5, installationId: INSTALLATION })
  })

  it.each([
    [{ ok: false, error: 'This isn’t available.' }, { ok: false, code: 'not_available', message: 'This isn’t available.' }],
    [{ ok: false, error: 'This record doesn’t match its collection.', issues: ['answer: Invalid input'] }, { ok: false, code: 'invalid', issues: ['answer: Invalid input'] }],
    [{ ok: false, error: 'Someone else changed this while you were editing. Reload and try again.' }, { ok: false, code: 'conflict' }],
    [{ ok: false, error: 'This tool has run out of storage space, so this wasn’t saved.' }, { ok: false, code: 'full', message: 'This tool has run out of storage space, so this wasn’t saved.' }],
    [{ ok: false, error: 'db exploded: relation studio_plugin_records' }, { ok: false, code: 'failed', message: 'Something went wrong. Try again.' }],
  ])('maps Step 3 result %j without inventing details', async (stepThree, bridge) => {
    vi.mocked(records.createRecord).mockResolvedValue(stepThree as never)
    const result = await dispatch(viewer('student'), { method: 'records.create', args: { collection: 'responses', data: {} }, host: HOST })
    expect(result).toMatchObject(bridge)
    expect(JSON.stringify(result)).not.toContain('studio_plugin')
  })
})

describe('host-only methods at the server', () => {
  it.each(['ui.resize', 'ui.toast'])('refuses %s even when sent straight to the server', async (method) => {
    expect(await dispatch(viewer('professor'), { method, args: { height: 300, message: 'x' }, host: HOST })).toMatchObject({
      ok: false,
      code: 'unsupported',
    })
  })
})

describe('course.skills', () => {
  const SKILLS = [
    { name: 'Recursion', info: 'Functions that call themselves', parent: null },
    { name: 'Base cases', info: null, parent: 'Recursion' },
  ]

  it('returns names, descriptions and parent names, with no identifier anywhere', async () => {
    vi.mocked(loadSectionSkills).mockResolvedValue(SKILLS)
    const result = await dispatch(viewer('professor'), { method: 'course.skills', args: null, host: HOST })
    expect(result).toEqual({ ok: true, data: SKILLS })
    expect(JSON.stringify(result)).not.toMatch(UUID)
  })

  it('needs the capability declared in the current view', async () => {
    const undeclared = { ...MANIFEST, views: { ...MANIFEST.views, professor: { ...MANIFEST.views.professor, capabilities: ['context.get' as const] } } }
    const result = await dispatch(viewer('professor', 'active', undeclared), { method: 'course.skills', args: null, host: HOST })
    expect(result).toMatchObject({ ok: false, code: 'not_available' })
    expect(loadSectionSkills).not.toHaveBeenCalled()
  })

  it('refuses arguments, and reports a failed lookup generically', async () => {
    expect(await dispatch(viewer('professor'), { method: 'course.skills', args: { sectionId: crypto.randomUUID() }, host: HOST })).toMatchObject({
      ok: false,
      code: 'invalid',
    })
    vi.mocked(loadSectionSkills).mockResolvedValue(null)
    expect(await dispatch(viewer('professor'), { method: 'course.skills', args: null, host: HOST })).toEqual({
      ok: false,
      code: 'failed',
      message: 'Something went wrong. Try again.',
    })
  })
})

describe('course.roster', () => {
  const withRoster = { ...MANIFEST, views: { ...MANIFEST.views, professor: { ...MANIFEST.views.professor, capabilities: ['course.roster' as const] } } }
  const STUDENTS = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]

  beforeEach(() => {
    vi.mocked(loadInstallationHandleSalt).mockResolvedValue('a'.repeat(64))
    vi.mocked(loadSectionRoster).mockResolvedValue(
      STUDENTS.map((id, i) => ({ id, firstName: `First${i}`, lastName: `Last${i}`, name: `Name${i}` })),
    )
  })

  it.each(['professor', 'ta', 'grader'] as const)('gives the %s handles only, sorted by handle: no IDs, no names', async (role) => {
    const result = await dispatch(viewer(role, 'active', withRoster), { method: 'course.roster', args: null, host: HOST })
    expect(result.ok).toBe(true)
    const { students } = (result as { data: { students: { handle: string }[] } }).data
    const handles = students.map((s) => s.handle)
    expect(handles).toHaveLength(3)
    expect(handles.every((h) => /^st_[0-9a-v]{20}$/.test(h))).toBe(true)
    expect(handles).toEqual([...handles].sort())
    expect(students.every((s) => Object.keys(s).join() === 'handle')).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(UUID)
    expect(JSON.stringify(result)).not.toMatch(/First|Last|Name/)
  })

  it('is refused to a student view, whatever the manifest says', async () => {
    const studentRoster = { ...withRoster, views: { ...withRoster.views, student: { ...withRoster.views.student, capabilities: ['course.roster' as const] } } }
    const result = await dispatch(viewer('student', 'active', studentRoster), { method: 'course.roster', args: null, host: HOST })
    expect(result).toMatchObject({ ok: false, code: 'not_available' })
    expect(loadSectionRoster).not.toHaveBeenCalled()
  })

  it('needs the capability declared, and fails closed when the roster can’t be read', async () => {
    expect(await dispatch(viewer('professor'), { method: 'course.roster', args: null, host: HOST })).toMatchObject({ ok: false, code: 'not_available' })
    vi.mocked(loadSectionRoster).mockResolvedValue(null)
    expect(await dispatch(viewer('professor', 'active', withRoster), { method: 'course.roster', args: null, host: HOST })).toMatchObject({
      ok: false,
      code: 'failed',
    })
  })
})

describe('course.assignments', () => {
  const withAssignments = {
    ...MANIFEST,
    views: { ...MANIFEST.views, student: { ...MANIFEST.views.student, capabilities: ['course.assignments' as const] } },
  }
  const ASSIGNMENTS = [
    { title: 'Problem set 1', dueAt: '2026-10-10T23:59:00Z', points: 10 },
    { title: 'Reading notes', dueAt: null, points: null },
  ]

  it('gives a student view titles, due dates and points, with no identifier anywhere', async () => {
    vi.mocked(loadReleasedAssignments).mockResolvedValue(ASSIGNMENTS)
    const v = viewer('student', 'active', withAssignments)
    const result = await dispatch(v, { method: 'course.assignments', args: null, host: HOST })
    expect(result).toEqual({ ok: true, data: { assignments: ASSIGNMENTS } })
    expect(loadReleasedAssignments).toHaveBeenCalledWith(v.sectionId)
    expect(JSON.stringify(result)).not.toMatch(UUID)
  })

  it('needs the capability declared in the view', async () => {
    expect(await dispatch(viewer('student'), { method: 'course.assignments', args: null, host: HOST })).toMatchObject({
      ok: false,
      code: 'not_available',
    })
    expect(loadReleasedAssignments).not.toHaveBeenCalled()
  })
})

describe('records.batch', () => {
  const record = { id: crypto.randomUUID(), data: {}, mine: true, createdAt: '', updatedAt: '' }

  it('routes to Step 3 with the verified installation, and reports each item in order by code only', async () => {
    vi.mocked(records.batchRecords).mockResolvedValue({
      ok: true,
      value: [
        { ok: true, value: record },
        { ok: false, error: records.RECORD_NOT_AVAILABLE },
        { ok: false, error: 'This record doesn’t match its collection.', issues: ['answer: Invalid input'] },
        { ok: false, error: records.RECORD_FULL_STUDENT },
        { ok: true, value: null },
      ],
    })
    const items = [{ op: 'create', data: {} }, { op: 'delete', recordId: crypto.randomUUID() }]
    const result = await dispatch(viewer('student'), { method: 'records.batch', args: { collection: 'responses', items }, host: HOST })
    expect(records.batchRecords).toHaveBeenCalledWith({ collection: 'responses', items, installationId: INSTALLATION })
    expect(result).toEqual({
      ok: true,
      data: {
        results: [
          { ok: true, record },
          { ok: false, code: 'not_available' },
          { ok: false, code: 'invalid' },
          { ok: false, code: 'full' },
          { ok: true, record: null },
        ],
      },
    })
  })

  it.each([
    ['no items', []],
    ['more than 50 items', Array.from({ length: 51 }, () => ({ op: 'create', data: {} }))],
    ['an item naming an owner', [{ op: 'create', data: {}, ownerId: crypto.randomUUID() }]],
    ['an item with a student ID instead of a handle', [{ op: 'create', data: {}, student: crypto.randomUUID() }]],
    ['an unknown op', [{ op: 'upsert', data: {} }]],
  ])('refuses %s before Step 3', async (_label, items) => {
    const result = await dispatch(viewer('professor'), { method: 'records.batch', args: { collection: 'responses', items }, host: HOST })
    expect(result).toMatchObject({ ok: false, code: 'invalid' })
    expect(records.batchRecords).not.toHaveBeenCalled()
  })
})

describe('context.get', () => {
  it('returns only safe context: no IDs, no names or emails', async () => {
    const v = viewer('professor', 'archived')
    const result = await dispatch(v, { method: 'context.get', args: null, host: HOST })
    expect(result).toEqual({
      ok: true,
      data: {
        plugin: { name: 'Exit ticket', version: '1.0.0' },
        view: 'professor',
        theme: 'light',
        locale: 'en-GB',
        timeZone: 'Europe/London',
        course: { code: 'CS101', title: 'Intro to Computing' },
        readOnly: true,
        can: expect.any(Object),
      },
    })
    expect(JSON.stringify(result)).not.toMatch(UUID)
  })

  it.each(['student', 'professor', 'ta', 'grader'] as const)('the %s’s capability booleans are the server’s own policy', async (role) => {
    const result = await dispatch(viewer(role), { method: 'context.get', args: {}, host: HOST })
    const can = (result as { ok: true; data: { can: Record<string, { read: boolean; write: boolean }> } }).data.can
    for (const [name, c] of Object.entries(MANIFEST.collections)) {
      expect(can[name], name).toEqual({
        read: decide(role, c.access, 'list', 'writable').allow,
        write: decide(role, c.access, 'create', 'writable').allow,
      })
    }
  })

  it('refuses arguments it doesn’t take', async () => {
    expect(await dispatch(viewer('student'), { method: 'context.get', args: { asUser: 'x' }, host: HOST })).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('a version 1 tool gets no skills field', async () => {
    const result = await dispatch(viewer('student'), { method: 'context.get', args: null, host: HOST })
    expect((result as { data: Record<string, unknown> }).data).not.toHaveProperty('skills')
    expect(listSkillBindings).not.toHaveBeenCalled()
  })

  it('a version 2 tool gets each slot’s linked skill by name, null when unlinked, and never an ID', async () => {
    const parsed = parseManifest(GOOD_MANIFEST)
    if (!parsed.ok) throw new Error('fixture')
    const skill = { id: crypto.randomUUID(), name: 'Photosynthesis' }
    const v = viewer('student', 'active', parsed.manifest as never)
    vi.mocked(listBindableSkills).mockResolvedValue([skill])
    vi.mocked(listSkillBindings).mockResolvedValue([{ slotKey: 'topic', skillId: skill.id }])
    const linked = await dispatch(v, { method: 'context.get', args: null, host: HOST })
    expect((linked as { data: { skills: unknown } }).data.skills).toEqual({ topic: 'Photosynthesis' })
    expect(JSON.stringify(linked)).not.toMatch(UUID)
    // Looked up for the server's viewer, never from anything the plugin sent.
    expect(listSkillBindings).toHaveBeenCalledWith(v.installationId)
    expect(listBindableSkills).toHaveBeenCalledWith(v.sectionId)

    vi.mocked(listSkillBindings).mockResolvedValue([])
    const unlinked = await dispatch(v, { method: 'context.get', args: null, host: HOST })
    expect((unlinked as { data: { skills: unknown } }).data.skills).toEqual({ topic: null })
  })
})

// ── Rate limits ───────────────────────────────────────────────────────

describe('bridge rate limits', () => {
  it('allows 120 calls per minute per user per installation', () => {
    const user = crypto.randomUUID()
    const results = Array.from({ length: 121 }, () => takeBridgeCall(user, INSTALLATION, 'read'))
    expect(results.filter(Boolean)).toHaveLength(120)
    expect(results.at(-1)).toBe(false)
  })

  it('allows 30 writes per minute, counted against the total too', () => {
    const user = crypto.randomUUID()
    const writes = Array.from({ length: 31 }, () => takeBridgeCall(user, INSTALLATION, 'write'))
    expect(writes.filter(Boolean)).toHaveLength(30)
    expect(takeBridgeCall(user, INSTALLATION, 'read')).toBe(true)
  })

  it('keeps users and installations apart', () => {
    const user = crypto.randomUUID()
    for (let i = 0; i < 120; i++) takeBridgeCall(user, INSTALLATION, 'read')
    expect(takeBridgeCall(user, INSTALLATION, 'read')).toBe(false)
    expect(takeBridgeCall(user, crypto.randomUUID(), 'read')).toBe(true)
    expect(takeBridgeCall(crypto.randomUUID(), INSTALLATION, 'read')).toBe(true)
  })

  it('caps one user at 300 calls a minute across installations, so rotating made-up IDs doesn’t help', () => {
    const user = crypto.randomUUID()
    const results = Array.from({ length: 301 }, () => takeBridgeCall(user, crypto.randomUUID(), 'read'))
    expect(results.filter(Boolean)).toHaveLength(300)
    expect(takeBridgeCall(user, INSTALLATION, 'read')).toBe(false)
  })

  it('lets legitimate calls to several installations through under the global cap', () => {
    const user = crypto.randomUUID()
    const installations = [crypto.randomUUID(), crypto.randomUUID()]
    for (const id of installations) {
      expect(Array.from({ length: 120 }, () => takeBridgeCall(user, id, 'read')).every(Boolean)).toBe(true)
    }
  })

  it('keeps one user’s global budget from touching another’s', () => {
    const busy = crypto.randomUUID()
    for (let i = 0; i < 300; i++) takeBridgeCall(busy, crypto.randomUUID(), 'read')
    expect(takeBridgeCall(busy, crypto.randomUUID(), 'read')).toBe(false)
    expect(takeBridgeCall(crypto.randomUUID(), crypto.randomUUID(), 'read')).toBe(true)
  })

  it('refills after the window', () => {
    vi.useFakeTimers()
    try {
      const user = crypto.randomUUID()
      for (let i = 0; i < 120; i++) takeBridgeCall(user, INSTALLATION, 'read')
      expect(takeBridgeCall(user, INSTALLATION, 'read')).toBe(false)
      vi.advanceTimersByTime(60_000)
      expect(takeBridgeCall(user, INSTALLATION, 'read')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── The route handler ─────────────────────────────────────────────────

describe('POST /api/studio/bridge', () => {
  let user: string

  beforeEach(() => {
    vi.stubEnv('STUDIO_RUNTIME_ORIGIN', 'http://127.0.0.1:3000')
    vi.stubEnv('SITE_URL', APP)
    user = crypto.randomUUID()
    vi.mocked(sessionUserId).mockResolvedValue(user)
    vi.mocked(resolveViewer).mockResolvedValue({ ...viewer('professor'), userId: user } as StudioViewer)
    vi.mocked(records.listRecords).mockResolvedValue({ ok: true, value: [] })
  })
  afterEach(() => vi.unstubAllEnvs())

  function post(body: unknown, headers: Record<string, string> = {}) {
    return POST(
      new Request(`${APP}/api/studio/bridge`, {
        method: 'POST',
        headers: { origin: APP, 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    )
  }

  it('answers a valid call with the dispatch result and safe headers', async () => {
    const res = await post(CALL)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, data: [] })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it.each([
    ['another origin', { origin: 'https://evil.example' }, 403],
    ['the runtime origin', { origin: 'http://127.0.0.1:3000' }, 403],
    ['no origin', { origin: '' }, 403],
    ['a non-JSON content type', { 'content-type': 'text/plain' }, 415],
  ])('refuses %s before reading the body', async (_label, headers, status) => {
    expect((await post(CALL, headers)).status).toBe(status)
    expect(sessionUserId).not.toHaveBeenCalled()
  })

  it('refuses an oversized body before parsing it', async () => {
    const res = await post(JSON.stringify({ ...CALL, args: { collection: 'responses', pad: 'x'.repeat(70 * 1024) } }))
    expect(res.status).toBe(413)
    expect(sessionUserId).not.toHaveBeenCalled()
  })

  it.each([
    ['broken JSON', '{"v":1,'],
    ['an envelope naming the user', { ...CALL, userId: crypto.randomUUID() }],
  ])('refuses %s with a generic 400', async (_label, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: { code: 'invalid', message: 'This request isn’t valid.' } })
  })

  it('needs a session: a frame ticket alone authenticates nothing', async () => {
    vi.mocked(sessionUserId).mockResolvedValue(null)
    const res = await post(CALL, { cookie: 't=some.ticket' })
    expect(res.status).toBe(401)
    expect(resolveViewer).not.toHaveBeenCalled()
  })

  it('answers stale, without dispatching, when the frame was built for another version', async () => {
    const res = await post({ ...CALL, method: 'records.create', args: { collection: 'responses', data: {} }, expectedVersionId: crypto.randomUUID() })
    expect(await res.json()).toEqual({ ok: false, error: { code: 'stale', message: expect.stringMatching(/newer version/) } })
    expect(records.createRecord).not.toHaveBeenCalled()
  })

  it('refuses a call that doesn’t say which version it was built for', async () => {
    const { expectedVersionId: _omit, ...withoutVersion } = CALL
    void _omit
    expect((await post(withoutVersion)).status).toBe(400)
  })

  it('spends the global budget on made-up installations before looking them up', async () => {
    vi.mocked(resolveViewer).mockResolvedValue(null)
    for (let i = 0; i < 300; i++) await post({ ...CALL, installationId: crypto.randomUUID() })
    const res = await post({ ...CALL, installationId: crypto.randomUUID() })
    expect(res.status).toBe(429)
    expect(resolveViewer).toHaveBeenCalledTimes(300)
  })

  it('answers "unavailable" when Step 3 refuses the installation, so the host stops the frame', async () => {
    vi.mocked(resolveViewer).mockResolvedValue(null)
    expect(await (await post(CALL)).json()).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'This tool isn’t available right now.' },
    })
    expect(records.listRecords).not.toHaveBeenCalled()
  })

  describe('status heartbeat', () => {
    const STATUS = { v: 1, type: 'status', installationId: INSTALLATION, expectedVersionId: VERSION }

    it.each([
      ['available', () => {}],
      ['readOnly', () => vi.mocked(resolveViewer).mockResolvedValue({ ...viewer('professor'), writable: false } as StudioViewer)],
      ['unavailable', () => vi.mocked(resolveViewer).mockResolvedValue(null)],
      ['stale', () => vi.mocked(resolveViewer).mockResolvedValue({ ...viewer('professor'), versionId: crypto.randomUUID() } as StudioViewer)],
    ])('answers %s and nothing more', async (status, arrange) => {
      arrange()
      const res = await post(STATUS)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, data: { status } })
      expect(records.listRecords).not.toHaveBeenCalled()
    })

    it('checks the installation through Step 3 like any call', async () => {
      await post(STATUS)
      expect(resolveViewer).toHaveBeenCalledWith(INSTALLATION)
    })

    it('needs a session and spends the rate budget', async () => {
      vi.mocked(sessionUserId).mockResolvedValue(null)
      expect((await post(STATUS)).status).toBe(401)
      vi.mocked(sessionUserId).mockResolvedValue(user)
      for (let i = 0; i < 120; i++) await post(STATUS)
      expect((await post(STATUS)).status).toBe(429)
    })

    it('refuses a status request carrying anything extra', async () => {
      expect((await post({ ...STATUS, method: 'records.list' })).status).toBe(400)
    })
  })

  it('rate-limits calls and writes, with Retry-After', async () => {
    for (let i = 0; i < 120; i++) await post(CALL)
    const limited = await post(CALL)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect((await limited.json()).error.code).toBe('rate_limited')
  })

  it('rate-limits writes separately', async () => {
    vi.mocked(records.createRecord).mockResolvedValue({ ok: true, value: { id: '', data: {}, mine: true, createdAt: '', updatedAt: '' } })
    const write = { ...CALL, method: 'records.create', args: { collection: 'responses', data: {} } }
    for (let i = 0; i < 30; i++) expect((await post(write)).status).toBe(200)
    expect((await post(write)).status).toBe(429)
    expect((await post(CALL)).status).toBe(200)
  })

  it('counts a whole batch as one write', async () => {
    vi.mocked(records.batchRecords).mockResolvedValue({ ok: true, value: [] })
    const items = Array.from({ length: 50 }, () => ({ op: 'create', data: {} }))
    const batch = { ...CALL, method: 'records.batch', args: { collection: 'responses', items } }
    for (let i = 0; i < 30; i++) expect((await post(batch)).status).toBe(200)
    expect((await post(batch)).status).toBe(429)
    expect(records.batchRecords).toHaveBeenCalledTimes(30)
  })

  it('logs a runtime stop with identifiers and the reason only', async () => {
    const res = await post({ v: 1, type: 'event', installationId: INSTALLATION, reason: 'navigated' })
    expect(await res.json()).toEqual({ ok: true, data: null })
    const event = vi.mocked(logEvent).mock.calls[0][0]
    expect(event).toMatchObject({ eventType: 'studio.runtime.stopped', eventCategory: 'studio', userId: user })
    expect(Object.keys(event.metadata ?? {}).sort()).toEqual(['installationId', 'reason', 'versionId'])
  })

  it('turns an unexpected error into a generic 500 with no detail', async () => {
    vi.mocked(resolveViewer).mockRejectedValue(new Error('connect ECONNREFUSED db.internal:5432'))
    const res = await post(CALL)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('ECONNREFUSED')
    expect(text).not.toContain('at ')
  })
})

// ── The host’s bridge client ──────────────────────────────────────────

describe('bridge client', () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

  it('posts only method and args from the plugin, with the installation and browser settings from the host', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { ok: true, data: { n: 1 } }))
    const client = createBridgeClient({ installationId: INSTALLATION, versionId: VERSION, fetchImpl })
    expect(await client.handleRequest('records.list', { collection: 'responses' })).toEqual({ ok: true, data: { n: 1 } })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/studio/bridge')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } })
    const body = JSON.parse(init.body as string)
    expect(Object.keys(body).sort()).toEqual(['args', 'expectedVersionId', 'host', 'installationId', 'method', 'type', 'v'])
    expect(body).toMatchObject({ installationId: INSTALLATION, expectedVersionId: VERSION })
  })

  it.each([
    [429, { ok: false, error: { code: 'rate_limited', message: 'Too many requests.' } }, 'rate_limited'],
    [413, null, 'invalid'],
    [401, null, 'not_available'],
    [500, { ok: false, error: { code: 'failed', message: 'x' } }, 'failed'],
  ])('maps HTTP %s to %s', async (status, body, code) => {
    const client = createBridgeClient({ installationId: INSTALLATION, versionId: VERSION, fetchImpl: vi.fn(async () => reply(status, body)) })
    expect(await client.handleRequest('records.list', {})).toMatchObject({ ok: false, code })
  })

  it('never reports an unavailable stop: that was the server’s own decision', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { ok: true, data: null }))
    createBridgeClient({ installationId: INSTALLATION, versionId: VERSION, fetchImpl }).reportStop('unavailable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('asks for status with the installation and its version, and nothing else', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { ok: true, data: { status: 'readOnly' } }))
    const client = createBridgeClient({ installationId: INSTALLATION, versionId: VERSION, fetchImpl })
    expect(await client.checkStatus()).toBe('readOnly')
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ v: 1, type: 'status', installationId: INSTALLATION, expectedVersionId: VERSION })
  })

  it.each([
    ['an unknown status', { ok: true, data: { status: 'everything-is-fine' } }],
    ['an error body', { ok: false, error: { code: 'rate_limited', message: 'x' } }],
  ])('treats %s as no news, by throwing', async (_label, body) => {
    const client = createBridgeClient({ installationId: INSTALLATION, versionId: VERSION, fetchImpl: vi.fn(async () => reply(200, body)) })
    await expect(client.checkStatus()).rejects.toThrow()
  })

  it('reports a network failure as failed, and never reports an intentional destroy', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network')
    })
    const client = createBridgeClient({ installationId: INSTALLATION, versionId: VERSION, fetchImpl })
    expect(await client.handleRequest('context.get', null)).toMatchObject({ ok: false, code: 'failed' })
    client.reportStop('destroyed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

// ── The preview bridge ────────────────────────────────────────────────

describe('preview bridge', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => fetchSpy.mockRestore())

  it('never touches the network, and never the real bridge', async () => {
    const preview = createPreviewBridge(MANIFEST, 'student')
    await preview.handleRequest('context.get', null)
    await preview.handleRequest('records.list', { collection: 'responses' })
    await preview.handleRequest('records.create', { collection: 'responses', data: { questionId: 'q', answer: 'a', confidence: 1 } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('applies the real policy to sample data: a previewing student sees only their own perStudent records', async () => {
    const preview = createPreviewBridge(MANIFEST, 'student')
    const mine = await preview.handleRequest('records.list', { collection: 'responses' })
    expect(mine).toMatchObject({ ok: true, data: [{ mine: true }] })
    expect(await preview.handleRequest('records.list', { collection: 'answerKeys' })).toMatchObject({ ok: false, code: 'not_available' })
    expect(await preview.handleRequest('records.create', { collection: 'questions', data: {} })).toMatchObject({ ok: false, code: 'not_available' })
  })

  it('validates writes like the server, and marks its context as a preview', async () => {
    const preview = createPreviewBridge(MANIFEST, 'student')
    expect(await preview.handleRequest('records.create', { collection: 'responses', data: { answer: 1 } })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await preview.handleRequest('context.get', null)).toMatchObject({ ok: true, data: { preview: true, view: 'student' } })
    expect(await preview.handleRequest('course.skills', null)).toMatchObject({ ok: false, code: 'unsupported' })
  })
})

// ── The preview bridge, Step 11: the synthetic class, staffPerStudent, batch, sample data ──

const { PREVIEW_ROSTER } = await import('@/lib/studio/runtime/preview-roster')

describe('preview bridge with the synthetic class', () => {
  const parsedClass = parseManifest({
    ...exitTicket,
    views: {
      student: { ...exitTicket.views.student, capabilities: ['context.get', 'course.assignments'] },
      professor: { ...exitTicket.views.professor, capabilities: ['context.get', 'course.roster', 'course.assignments'] },
    },
    collections: {
      ...exitTicket.collections,
      attendance: { access: 'staffPerStudent', fields: { date: 'text', status: 'text', note: 'text' } },
    },
  })
  if (!parsedClass.ok) throw new Error('class manifest is invalid')
  const CLASS = parsedClass.manifest
  const [FIRST, SECOND] = PREVIEW_ROSTER.map((s) => s.handle)
  const today = { date: '2026-10-03', status: 'present', note: '' }
  const listOf = async (preview: { handleRequest: (m: string, a: unknown) => Promise<unknown> }, collection: string) =>
    ((await preview.handleRequest('records.list', { collection })) as { data: Record<string, unknown>[] }).data

  it('gives a professor view the twelve synthetic handles, sorted by handle, and a student view none', async () => {
    const roster = await createPreviewBridge(CLASS, 'professor').handleRequest('course.roster', null)
    expect(roster).toEqual({ ok: true, data: { students: [...PREVIEW_ROSTER].map((s) => ({ handle: s.handle })).sort((a, b) => a.handle.localeCompare(b.handle)) } })
    expect(JSON.stringify(roster)).not.toContain(PREVIEW_ROSTER[0].name)
    expect(await createPreviewBridge(CLASS, 'student').handleRequest('course.roster', null)).toMatchObject({ ok: false, code: 'not_available' })
  })

  it('lists synthetic released assignments by due date, with no IDs', async () => {
    const result = (await createPreviewBridge(CLASS, 'student').handleRequest('course.assignments', null)) as { ok: true; data: { assignments: Record<string, unknown>[] } }
    expect(result.ok).toBe(true)
    for (const a of result.data.assignments) expect(Object.keys(a).sort()).toEqual(['dueAt', 'points', 'title'])
    const dated = result.data.assignments.map((a) => a.dueAt).filter((d): d is string => d !== null)
    expect(dated).toEqual([...dated].sort())
  })

  it('a professor records something about one student by handle; that student sees it as theirs, without a handle', async () => {
    const professor = createPreviewBridge(CLASS, 'professor', { sample: { attendance: [] } })
    expect(await professor.handleRequest('records.create', { collection: 'attendance', data: today })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await professor.handleRequest('records.create', { collection: 'attendance', data: today, student: `st_${'0'.repeat(20)}` })).toMatchObject({ ok: false, code: 'not_available' })
    const made = await professor.handleRequest('records.create', { collection: 'attendance', data: today, student: SECOND })
    expect(made).toMatchObject({ ok: true, data: { student: SECOND, mine: false, data: today } })
    // `student` is for staffPerStudent only.
    expect(await professor.handleRequest('records.create', { collection: 'questions', data: { prompt: 'p', skill: 's', open: true }, student: SECOND })).toMatchObject({ ok: false, code: 'invalid' })

    const student = createPreviewBridge(CLASS, 'student', { sample: { attendance: [{ student: 0, data: today }, { student: 1, data: { ...today, status: 'absent' } }] } })
    const own = await listOf(student, 'attendance')
    expect(own).toEqual([expect.objectContaining({ mine: true, data: today })])
    expect(own[0]).not.toHaveProperty('student')
    expect(await student.handleRequest('records.create', { collection: 'attendance', data: today })).toMatchObject({ ok: false, code: 'not_available' })
    expect(await student.handleRequest('records.create', { collection: 'responses', data: { questionId: 'q', answer: 'a', confidence: 1 }, student: FIRST })).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('staff see whose perStudent and staffPerStudent records are whose, as handles', async () => {
    const professor = createPreviewBridge(CLASS, 'professor', { sample: { responses: [{ student: 3, data: { questionId: 'q1', answer: 'Light', confidence: 4 } }] } })
    expect(await listOf(professor, 'responses')).toEqual([expect.objectContaining({ student: PREVIEW_ROSTER[3].handle, mine: false })])
  })

  it('runs a batch item by item, in order, reporting each refusal by code only', async () => {
    const professor = createPreviewBridge(CLASS, 'professor', { sample: { attendance: [] } })
    const result = await professor.handleRequest('records.batch', {
      collection: 'attendance',
      items: [
        { op: 'create', data: today, student: FIRST },
        { op: 'create', data: { status: 'present' }, student: SECOND },
        { op: 'delete', recordId: crypto.randomUUID() },
        { op: 'create', data: { ...today, status: 'late' }, student: SECOND },
      ],
    })
    expect(result).toMatchObject({
      ok: true,
      data: {
        results: [
          { ok: true, record: { student: FIRST } },
          { ok: false, code: 'invalid' },
          { ok: false, code: 'not_available' },
          { ok: true, record: { student: SECOND, data: { status: 'late' } } },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toContain('doesn’t match')
    expect(await listOf(professor, 'attendance')).toHaveLength(2)
  })

  it('shows the draft’s sample data and nothing else when there is some', async () => {
    const professor = createPreviewBridge(CLASS, 'professor', {
      sample: { questions: [{ data: { prompt: 'What limits photosynthesis?', skill: 'Light', open: true } }], unknownCollection: [{ data: {} }] },
    })
    expect(await listOf(professor, 'questions')).toEqual([expect.objectContaining({ mine: true, data: { prompt: 'What limits photosynthesis?', skill: 'Light', open: true } })])
    expect(await listOf(professor, 'attendance')).toEqual([])
  })

  it('without sample data, writes placeholders that fit each field, never “Sample text”', async () => {
    const records = await listOf(createPreviewBridge(CLASS, 'professor'), 'attendance')
    expect(records).toHaveLength(3)
    for (const r of records) {
      const data = r.data as Record<string, string>
      expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(['present', 'late', 'absent']).toContain(data.status)
      expect(JSON.stringify(data)).not.toMatch(/Sample text/)
    }
  })

  it('pages records.list with limit and offset, like the server', async () => {
    const professor = createPreviewBridge(CLASS, 'professor')
    const all = await listOf(professor, 'attendance')
    const page = ((await professor.handleRequest('records.list', { collection: 'attendance', limit: 1, offset: 1 })) as { data: unknown[] }).data
    expect(page).toEqual([all[1]])
    expect(await professor.handleRequest('records.list', { collection: 'attendance', extra: true })).toMatchObject({ ok: false, code: 'invalid' })
  })
})
