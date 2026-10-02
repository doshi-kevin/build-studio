/**
 * Step 5B against a real database (`npm run test:db`): student visibility, the storage
 * quota counters, the publication service, and student access through the real Bridge
 * route, status heartbeat and frame route.
 *
 * Mocked, and only these:
 *   - the session cookie, to act as a chosen fixture user;
 *   - logEvent, so audit calls can be inspected;
 *   - revalidatePath, which needs a Next.js request;
 *   - the pre-publish verdict on showing, so tests about visibility don't depend on the
 *     validator. Every test sees the real answer (these trivial bundles never pass)
 *     unless it explicitly makes one check pass in order to show a plugin;
 *   - the purpose check's model, which is reported unavailable.
 * publication.ts, access.ts, context.ts and db.ts are real. The release gate is opened
 * for this file (STUDIO_STUDENT_ACCESS=on) and closed where a test says so.
 */
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import { STUDIO_VALIDATOR_RULESET } from '@/lib/studio/validator/ruleset'
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
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/studio/prepublish', () => ({ prePublishVerdict: vi.fn() }))

const lifecycle = await import('@/lib/studio/lifecycle')
const visibility = await import('@/lib/studio/student-visibility')
const { RECORD_FULL } = await import('@/lib/studio/records')
const { POST } = await import('@/app/api/studio/bridge/route')
const { issueFrameUrl } = await import('@/lib/studio/runtime/frame-ticket')
const { frameResponse } = await import('@/lib/studio/runtime/frame')
const { studentToolTabs, studentPastTools, professorToolTabs } = await import('@/lib/studio/navigation')
const { resolveViewer, candidateVersion } = await import('@/lib/studio/context')
const publicationActions = await import('@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/actions')
const { logEvent } = await import('@/lib/supabase/event-logger')
const { prePublishVerdict } = await import('@/lib/studio/prepublish')
const realValidator = await vi.importActual<typeof import('@/lib/studio/prepublish')>('@/lib/studio/prepublish')

const A = FIXTURE.a
const PROFESSOR = A.users.professor.id
const TA = A.users.ta.id
const STUDENT = A.users.student.id
/** Enrolled in this file's section, later marked completed. */
const FINISHED = FIXTURE.outsider.id
/** A student of the other institution, enrolled in nothing here. */
const STRANGER = FIXTURE.b.users.student.id
const OTHER_PROFESSOR = FIXTURE.b.users.professor.id
const HOST = { locale: 'en-US', timeZone: 'America/New_York' }
const APP = 'http://localhost:3000'
const RUNTIME = 'http://127.0.0.1:3000'
const ON_PGLITE = process.env.STUDIO_DB_STAND_IN === 'pglite'

const run = `t${randomBytes(4).toString('hex')}`

let db: Client
let restoreEntitlement: (() => Promise<void>) | undefined
let savedPlatform: unknown
let section = ''
const projects: string[] = []
/** The installation limits, read from the studio_plugin_limits settings row. */
let STUDIO_INSTALLATION_MAX_RECORDS = 0
let STUDIO_INSTALLATION_MAX_BYTES = 0

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(text, params)).rows as T[]
}

const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error)
  return r.value
}

interface Plugin {
  installation: string
  version: string
  project: string
  slug: string
}

/** A plugin of its own, installed in this file's section, hidden. */
async function install(tag: string): Promise<Plugin> {
  session.userId = PROFESSOR
  const slug = `pb-${tag}-${run}`
  const project = ok(await lifecycle.createProject({ sectionId: section, slug, name: `Plugin ${tag}` }))
  projects.push(project)
  const version = ok(
    await lifecycle.publishVersion({
      sectionId: section,
      projectId: project,
      manifest: { ...exitTicket, id: slug, version: '1.0.0' },
      source: {},
      studentBundle: `student_${tag}()`,
      professorBundle: `professor_${tag}()`,
    }),
  )
  const installation = ok(await lifecycle.installPlugin({ sectionId: section, versionId: version }))
  return { installation, version, project, slug }
}

/** Shows a plugin through the real service, with the one missing piece (the validator)
 * made to pass for this call only. */
async function show(installation: string) {
  session.userId = PROFESSOR
  vi.mocked(prePublishVerdict).mockResolvedValueOnce({ status: 'passed' })
  return visibility.showToStudents({ sectionId: section, installationId: installation, acknowledgeWarnings: true })
}

/** Records passing Stage 1 and Stage 2 runs for a version's stored artifact hash, as the
 * validator would after both stages pass. For tests about what happens once a version is
 * cleared; the validator pipeline itself is tested in db/studio-validator.test.ts. */
async function clearedByValidator(versionId: string) {
  for (const stage of ['static', 'runtime']) {
    const [{ id }] = await sql<{ id: string }>(
      `insert into public.studio_plugin_validations
         (version_id, institution_id, stage, status, artifact_sha256, validator_version, ruleset_version, runtime_version, trigger)
       select v.id, v.institution_id, $2, 'running', v.artifact_sha256, 'test', $3, 'v1', 'test'
       from public.studio_plugin_versions v where v.id = $1
       returning id`,
      [versionId, stage, STUDIO_VALIDATOR_RULESET],
    )
    await sql(`update public.studio_plugin_validations set status = 'passed', finished_at = now() where id = $1`, [id])
  }
}

async function hide(installation: string, as = PROFESSOR) {
  session.userId = as
  return visibility.hideFromStudents({ sectionId: section, installationId: installation })
}

async function post(userId: string, body: Record<string, unknown>) {
  session.userId = userId
  const res = await POST(
    new Request(`${APP}/api/studio/bridge`, {
      method: 'POST',
      headers: { origin: APP, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ...body }),
    }),
  )
  return res.json()
}

/** One Bridge call, exactly as the host sends it. */
const call = (userId: string, p: Plugin, method: string, args: unknown, expectedVersionId = p.version) =>
  post(userId, { type: 'call', installationId: p.installation, expectedVersionId, method, args, host: HOST })

/** The host's status heartbeat. */
const status = async (userId: string, p: Plugin, expectedVersionId = p.version) =>
  (await post(userId, { type: 'status', installationId: p.installation, expectedVersionId })).data?.status

const visibilityOf = async (installation: string) =>
  (await sql<{ v: string }>('select student_visibility as v from public.studio_plugin_installations where id = $1', [installation]))[0].v

const recordCount = async (installation: string) =>
  Number((await sql<{ n: string }>('select count(*) as n from public.studio_plugin_records where installation_id = $1', [installation]))[0].n)

const answer = { questionId: 'q1', answer: 'mine', confidence: 2 }

async function withKillSwitch(test: () => Promise<void>) {
  await sql(`update public.platform_settings set settings = jsonb_set(settings, '{studio}', '{"disabled": true}') where id = true`)
  try {
    await test()
  } finally {
    await sql(`update public.platform_settings set settings = settings - 'studio' where id = true`)
  }
}

async function withoutEntitlement(test: () => Promise<void>) {
  await sql(
    `update public.institutions set settings = jsonb_set(settings, '{entitlements}', '{"granted": [], "revoked": ["studio"], "pendingRevocation": {}, "version": 2}') where id = $1`,
    [A.institution],
  )
  try {
    await test()
  } finally {
    // Back to granted. afterAll still restores the settings saved before this file ran.
    await grantStudio(db, A.institution)
  }
}

async function withGateClosed(test: () => Promise<void>) {
  process.env.STUDIO_STUDENT_ACCESS = 'off'
  try {
    await test()
  } finally {
    process.env.STUDIO_STUDENT_ACCESS = 'on'
  }
}

beforeAll(async () => {
  const env = dbEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey
  process.env.STUDIO_STUDENT_ACCESS = 'on'
  process.env.STUDIO_RUNTIME_ORIGIN = RUNTIME
  process.env.SITE_URL = APP
  process.env.STUDIO_FRAME_TICKET_SECRET = 'a-db-test-only-frame-ticket-secret-of-48-chars!!'
  db = new Client({ connectionString: env.pgUrl })
  await db.connect()
  restoreEntitlement = await grantStudio(db, A.institution)
  const [limits] = await sql<{ r: string; b: string }>(
    'select installation_max_records as r, installation_max_bytes as b from public.studio_plugin_limits where id',
  )
  STUDIO_INSTALLATION_MAX_RECORDS = Number(limits.r)
  STUDIO_INSTALLATION_MAX_BYTES = Number(limits.b)
  ;[{ settings: savedPlatform }] = await sql<{ settings: unknown }>('select settings from public.platform_settings where id = true')

  ;[{ id: section }] = await sql<{ id: string }>(
    `insert into public.course_sections (institution_id, course_id, section_code, semester, year, professor_id)
     values ($1, $2, $3, 'Fall', 2026, $4) returning id`,
    [A.institution, A.course, `PB-${run}`, PROFESSOR],
  )
  for (const student of [STUDENT, FINISHED]) {
    await sql(`insert into public.enrollments (section_id, student_id, status) values ($1, $2, 'enrolled')`, [section, student])
  }
  await sql(
    `insert into public.section_staff (section_id, staff_id, role, status, ends_at) values ($1, $2, 'ta', 'active', '2099-01-01')`,
    [section, TA],
  )
})

beforeEach(() => {
  vi.mocked(prePublishVerdict).mockImplementation(realValidator.prePublishVerdict)
})

afterAll(async () => {
  for (const key of ['STUDIO_STUDENT_ACCESS', 'STUDIO_RUNTIME_ORIGIN', 'SITE_URL', 'STUDIO_FRAME_TICKET_SECRET']) delete process.env[key]
  if (!db) return
  await restoreEntitlement?.()
  await sql('update public.platform_settings set settings = $1::jsonb where id = true', [JSON.stringify(savedPlatform ?? {})])
  for (const project of projects) {
    await sql('delete from public.studio_plugin_records where installation_id in (select id from public.studio_plugin_installations where project_id = $1)', [project])
    await sql('delete from public.studio_plugin_installations where project_id = $1', [project])
    await sql('delete from public.studio_plugin_versions where project_id = $1', [project])
    await sql('delete from public.studio_plugin_projects where id = $1', [project])
  }
  if (section) {
    await sql('delete from public.section_staff where section_id = $1', [section])
    await sql('delete from public.enrollments where section_id = $1', [section])
    await sql('delete from public.course_sections where id = $1', [section])
  }
  await db.end()
})

// ── The database on its own ───────────────────────────────────────────

describe('student visibility in the database', () => {
  let p: Plugin
  beforeAll(async () => {
    p = await install('db')
  })

  // Shows the version that is current right now, as the service does after its review.
  const setVisibility = (installation: string, sectionId: string, value: string, actor = PROFESSOR) =>
    sql<{ changed: boolean }>(
      `select public.studio_set_student_visibility($1, $2, $3, $4,
         (select current_version_id from public.studio_plugin_installations where id = $1)) as changed`,
      [installation, sectionId, value, actor],
    )

  it('a new installation starts hidden', async () => {
    expect(await visibilityOf(p.installation)).toBe('hidden')
  })

  it('an installation can’t be created visible', async () => {
    await expect(
      sql(
        `insert into public.studio_plugin_installations (institution_id, section_id, project_id, current_version_id, installed_by, student_visibility)
         values ($1, $2, $3, $4, $5, 'visible')`,
        [A.institution, section, p.project, p.version, PROFESSOR],
      ),
    ).rejects.toThrow()
  })

  it('client roles reach neither the usage table nor the visibility function', async () => {
    const [row] = await sql<Record<string, boolean>>(
      `select has_table_privilege('authenticated', 'public.studio_plugin_usage', 'select') as auth_usage,
              has_table_privilege('anon', 'public.studio_plugin_usage', 'select') as anon_usage,
              has_function_privilege('authenticated', 'public.studio_set_student_visibility(uuid, uuid, text, uuid, uuid)', 'execute') as auth_set,
              has_function_privilege('anon', 'public.studio_set_student_visibility(uuid, uuid, text, uuid, uuid)', 'execute') as anon_set,
              has_function_privilege('anon', 'public.set_studio_kill_switch(boolean)', 'execute') as anon_kill`,
    )
    expect(row).toEqual({ auth_usage: false, anon_usage: false, auth_set: false, anon_set: false, anon_kill: false })
  })

  it('shows, hides, and says when nothing changed', async () => {
    expect((await setVisibility(p.installation, section, 'visible'))[0].changed).toBe(true)
    expect((await setVisibility(p.installation, section, 'visible'))[0].changed).toBe(false)
    const [row] = await sql<{ by: string; at: string | null }>(
      'select visibility_changed_by as by, visibility_changed_at as at from public.studio_plugin_installations where id = $1',
      [p.installation],
    )
    expect(row.by).toBe(PROFESSOR)
    expect(row.at).not.toBeNull()
    expect((await setVisibility(p.installation, section, 'hidden'))[0].changed).toBe(true)
  })

  it.each([
    ['a value other than hidden or visible', () => setVisibility(p.installation, section, 'published')],
    ['an installation named with another section', () => setVisibility(p.installation, A.section, 'visible')],
    ['an actor from another institution', () => setVisibility(p.installation, section, 'visible', OTHER_PROFESSOR)],
  ])('refuses %s, and changes nothing', async (_label, act) => {
    await expect(act()).rejects.toThrow()
    expect(await visibilityOf(p.installation)).toBe('hidden')
  })

  it('a version needs code for both views', async () => {
    await expect(
      sql(
        `insert into public.studio_plugin_versions (project_id, institution_id, version, manifest, bridge_version, source, student_bundle, professor_bundle, bundle_sha256, published_by)
         select project_id, institution_id, '9.9.9', jsonb_set(manifest, '{version}', '"9.9.9"'), bridge_version, source, '', professor_bundle, bundle_sha256, published_by
           from public.studio_plugin_versions where id = $1`,
        [p.version],
      ),
    ).rejects.toThrow(/bundles_not_empty/)
  })

  it('an archived installation keeps its visibility, can be hidden, and can never be shown again', async () => {
    const q = await install('archive')
    await setVisibility(q.installation, section, 'visible')
    session.userId = PROFESSOR
    ok(await lifecycle.archiveInstallation({ sectionId: section, installationId: q.installation }))
    expect(await visibilityOf(q.installation)).toBe('visible')
    await setVisibility(q.installation, section, 'hidden')
    await expect(setVisibility(q.installation, section, 'visible')).rejects.toThrow(/archived installation/)
    // A direct update by the server meets the same guard.
    await expect(
      sql(`update public.studio_plugin_installations set student_visibility = 'visible' where id = $1`, [q.installation]),
    ).rejects.toThrow(/archived installation/)
    expect(await visibilityOf(q.installation)).toBe('hidden')
  })
})

describe('the kill switch function', () => {
  const asUser = (id: string) => sql(`select set_config('request.jwt.claim.sub', $1, false)`, [id])
  afterAll(async () => {
    await sql(`select set_config('request.jwt.claim.sub', '', false)`)
    await sql(`update public.platform_settings set settings = settings - 'studio' where id = true`)
  })

  it('refuses anyone but a super admin', async () => {
    await asUser(PROFESSOR)
    await expect(sql('select public.set_studio_kill_switch(true)')).rejects.toThrow(/permission_denied/)
    const [row] = await sql<{ s: unknown }>(`select settings -> 'studio' as s from public.platform_settings where id = true`)
    expect(row.s).toBeNull()
  })

  it('lets a super admin engage and release it', async (ctx) => {
    const [admin] = await sql<{ id: string }>(`select id from public.profiles where role = 'super_admin' limit 1`)
    if (!admin) return ctx.skip()
    await asUser(admin.id)
    await sql('select public.set_studio_kill_switch(true)')
    expect((await sql<{ d: boolean }>(`select (settings -> 'studio' ->> 'disabled')::boolean as d from public.platform_settings`))[0].d).toBe(true)
    await sql('select public.set_studio_kill_switch(false)')
    expect((await sql<{ d: boolean }>(`select (settings -> 'studio' ->> 'disabled')::boolean as d from public.platform_settings`))[0].d).toBe(false)
  })
})

// ── Storage quota ─────────────────────────────────────────────────────

describe('storage quota', () => {
  let q: Plugin
  beforeAll(async () => {
    q = await install('quota')
  })

  const usage = async () => {
    const [row] = await sql<{ n: string; b: string }>(
      'select record_count as n, record_bytes as b from public.studio_plugin_usage where installation_id = $1',
      [q.installation],
    )
    return { records: Number(row.n), bytes: Number(row.b) }
  }
  const actual = async () => {
    const [row] = await sql<{ n: string; b: string }>(
      'select count(*) as n, coalesce(sum(octet_length(data::text)), 0) as b from public.studio_plugin_records where installation_id = $1',
      [q.installation],
    )
    return { records: Number(row.n), bytes: Number(row.b) }
  }
  /** Puts the counters where a test needs them, as if that much were stored. */
  const setUsage = (records: number, bytes: number) =>
    sql('update public.studio_plugin_usage set record_count = $2, record_bytes = $3 where installation_id = $1', [q.installation, records, bytes])
  const recount = async () => {
    const now = await actual()
    await setUsage(now.records, now.bytes)
  }
  const insertQuestion = (prompt: string) =>
    sql<{ id: string }>(
      `insert into public.studio_plugin_records (institution_id, section_id, installation_id, version_id, collection, owner_id, author_id, data)
       values ($1, $2, $3, $4, 'questions', null, $5, $6::jsonb) returning id`,
      [A.institution, section, q.installation, q.version, PROFESSOR, JSON.stringify({ prompt, skill: 's', open: true })],
    )

  it('every new installation has its counters, at zero', async () => {
    expect(await usage()).toEqual({ records: 0, bytes: 0 })
  })

  it('counts every create, update and delete exactly, in the same transaction', async () => {
    const [a] = await insertQuestion('first')
    await insertQuestion('second')
    await sql(`update public.studio_plugin_records set data = $2::jsonb where id = $1`, [a.id, JSON.stringify({ prompt: 'a much longer first prompt', skill: 's', open: true })])
    expect(await usage()).toEqual(await actual())
    await sql('delete from public.studio_plugin_records where id = $1', [a.id])
    expect(await usage()).toEqual(await actual())
    expect((await usage()).records).toBe(1)
  })

  it('an update changes bytes by the difference, not by the whole record', async () => {
    const [row] = await insertQuestion('x')
    const before = await usage()
    const bigger = { prompt: 'x'.repeat(100), skill: 's', open: true }
    await sql(`update public.studio_plugin_records set data = $2::jsonb where id = $1`, [row.id, JSON.stringify(bigger)])
    const after = await usage()
    expect(after.records).toBe(before.records)
    expect(after.bytes - before.bytes).toBe(99)
  })

  it('refuses the write that would pass the record limit, with nothing stored', async () => {
    const now = await actual()
    await setUsage(STUDIO_INSTALLATION_MAX_RECORDS - 1, now.bytes)
    await insertQuestion('fits')
    await expect(insertQuestion('one too many')).rejects.toMatchObject({ code: '54000' })
    expect((await usage()).records).toBe(STUDIO_INSTALLATION_MAX_RECORDS)
    expect((await actual()).records).toBe(now.records + 1)
    await recount()
  })

  it('refuses the write that would pass the byte limit', async () => {
    const now = await actual()
    await setUsage(now.records, STUDIO_INSTALLATION_MAX_BYTES - 20)
    await expect(insertQuestion('this record is longer than twenty bytes')).rejects.toMatchObject({ code: '54000' })
    expect(await recordCount(q.installation)).toBe(now.records)
    await recount()
  })

  it('one statement that would pass the limit stores none of its rows', async () => {
    const now = await actual()
    await setUsage(STUDIO_INSTALLATION_MAX_RECORDS - 1, now.bytes)
    await expect(
      sql(
        `insert into public.studio_plugin_records (institution_id, section_id, installation_id, version_id, collection, owner_id, author_id, data)
         select $1, $2, $3, $4, 'questions', null, $5, jsonb_build_object('prompt', 'p' || g, 'skill', 's', 'open', true)
           from generate_series(1, 2) g`,
        [A.institution, section, q.installation, q.version, PROFESSOR],
      ),
    ).rejects.toMatchObject({ code: '54000' })
    expect(await recordCount(q.installation)).toBe(now.records)
    expect((await usage()).records).toBe(STUDIO_INSTALLATION_MAX_RECORDS - 1)
    await recount()
  })

  it('a write that shrinks always fits, even over the limit, and delete frees space', async () => {
    const [row] = await insertQuestion('y'.repeat(50))
    const now = await actual()
    await setUsage(now.records, STUDIO_INSTALLATION_MAX_BYTES + 100)
    await sql(`update public.studio_plugin_records set data = $2::jsonb where id = $1`, [row.id, JSON.stringify({ prompt: 'y', skill: 's', open: true })])
    await sql('delete from public.studio_plugin_records where id = $1', [row.id])
    expect((await usage()).records).toBe(now.records - 1)
    await recount()
  })

  it('a refused write leaves the counters as they were', async () => {
    await recount()
    const before = await usage()
    // Refused by the records guard: a collection the version never declared.
    await expect(
      sql(
        `insert into public.studio_plugin_records (institution_id, section_id, installation_id, version_id, collection, owner_id, author_id, data)
         values ($1, $2, $3, $4, 'undeclared', null, $5, '{}'::jsonb)`,
        [A.institution, section, q.installation, q.version, PROFESSOR],
      ),
    ).rejects.toThrow()
    expect(await usage()).toEqual(before)
    expect(await usage()).toEqual(await actual())
  })

  it('through the Bridge, a full installation answers `full` and is logged without contents', async () => {
    ok(await show(q.installation))
    const now = await actual()
    await setUsage(STUDIO_INSTALLATION_MAX_RECORDS, now.bytes)
    vi.mocked(logEvent).mockClear()
    expect(await call(STUDENT, q, 'records.create', { collection: 'responses', data: answer })).toEqual({
      ok: false,
      error: { code: 'full', message: RECORD_FULL },
    })
    expect(await recordCount(q.installation)).toBe(now.records)
    const events = vi.mocked(logEvent).mock.calls.map(([e]) => e)
    expect(events.map((e) => e.eventType)).toEqual(['studio.record.quota_refused'])
    expect(JSON.stringify(events)).not.toContain('mine')
    await recount()
  })

  // Two real connections, one holding the last slot in an open transaction. PGlite has a
  // single connection, so this runs only against real Postgres (npm run test:db).
  it.skipIf(ON_PGLITE)('two concurrent writers can’t both take the last slot', async () => {
    const env = dbEnv()
    const [first, second] = [new Client({ connectionString: env.pgUrl }), new Client({ connectionString: env.pgUrl })]
    await first.connect()
    await second.connect()
    const insert = (c: Client, prompt: string) =>
      c.query(
        `insert into public.studio_plugin_records (institution_id, section_id, installation_id, version_id, collection, owner_id, author_id, data)
         values ($1, $2, $3, $4, 'questions', null, $5, $6::jsonb)`,
        [A.institution, section, q.installation, q.version, PROFESSOR, JSON.stringify({ prompt, skill: 's', open: true })],
      )
    try {
      const now = await actual()
      await setUsage(STUDIO_INSTALLATION_MAX_RECORDS - 1, now.bytes)
      await first.query('begin')
      await insert(first, 'first')
      const racing = insert(second, 'second').then(
        () => 'stored',
        (e: { code?: string }) => e.code,
      )
      await first.query('commit')
      expect(await racing).toBe('54000')
      expect((await usage()).records).toBe(STUDIO_INSTALLATION_MAX_RECORDS)
    } finally {
      await first.end()
      await second.end()
      await recount()
    }
  })
})

// ── The publication service ───────────────────────────────────────────

describe('showing and hiding through the trusted service', () => {
  let p: Plugin
  beforeAll(async () => {
    p = await install('svc')
  })

  it('nothing the validator hasn’t cleared can be shown', async () => {
    session.userId = PROFESSOR
    const result = await visibility.showToStudents({ sectionId: section, installationId: p.installation, acknowledgeWarnings: true })
    // These test bundles aren't built from the plugin kit, so Stage 1 fails them.
    expect(result).toMatchObject({ ok: false, blockers: [{ code: 'validator_failed' }] })
    expect(await visibilityOf(p.installation)).toBe('hidden')
  })

  it('a TA can neither show nor hide', async () => {
    session.userId = TA
    vi.mocked(prePublishVerdict).mockResolvedValue({ status: 'passed' })
    expect(await visibility.showToStudents({ sectionId: section, installationId: p.installation })).toEqual({ ok: false, error: 'This isn’t available.' })
    expect(await hide(p.installation, TA)).toEqual({ ok: false, error: 'This isn’t available.' })
    expect(await visibilityOf(p.installation)).toBe('hidden')
  })

  it('with the release gate closed, nothing can be shown', async () => {
    await withGateClosed(async () => {
      expect(await show(p.installation)).toMatchObject({ ok: false, blockers: [{ code: 'release_gate' }] })
    })
    expect(await visibilityOf(p.installation)).toBe('hidden')
  })

  it('without the entitlement it can’t be shown, but it can still be hidden', async () => {
    ok(await show(p.installation))
    await withoutEntitlement(async () => {
      ok(await hide(p.installation))
      expect(await visibilityOf(p.installation)).toBe('hidden')
      expect(await show(p.installation)).toMatchObject({ ok: false, blockers: [{ code: 'not_entitled' }] })
    })
    expect(await visibilityOf(p.installation)).toBe('hidden')
  })

  it('with the kill switch engaged it can’t be shown, but it can still be hidden', async () => {
    ok(await show(p.installation))
    await withKillSwitch(async () => {
      ok(await hide(p.installation))
      expect(await show(p.installation)).toMatchObject({ ok: false, blockers: [{ code: 'kill_switch' }] })
    })
    expect(await visibilityOf(p.installation)).toBe('hidden')
  })

  it('once every check passes it is visible, recorded with who and when', async () => {
    expect(await show(p.installation)).toEqual({ ok: true, value: { changed: true } })
    const [row] = await sql<{ v: string; by: string }>(
      'select student_visibility as v, visibility_changed_by as by from public.studio_plugin_installations where id = $1',
      [p.installation],
    )
    expect(row).toEqual({ v: 'visible', by: PROFESSOR })
  })
})

// ── Student access ────────────────────────────────────────────────────

describe('student access', () => {
  let shown: Plugin
  let hidden: Plugin

  beforeAll(async () => {
    shown = await install('shown')
    hidden = await install('hidden')
    ok(await show(shown.installation))
  })

  it('a hidden installation answers a student exactly like one that doesn’t exist', async () => {
    const madeUp = { installation: crypto.randomUUID(), version: hidden.version, project: '', slug: '' }
    const toHidden = await call(STUDENT, hidden, 'records.list', { collection: 'responses' })
    const toNothing = await call(STUDENT, madeUp, 'records.list', { collection: 'responses' })
    expect(toHidden).toEqual({ ok: false, error: { code: 'unavailable', message: expect.any(String) } })
    expect(toNothing).toEqual(toHidden)
    expect(await status(STUDENT, hidden)).toBe('unavailable')
    expect(await status(STUDENT, madeUp)).toBe('unavailable')
  })

  it('a shown installation lets an enrolled student work, with their own records only', async () => {
    expect(await call(STUDENT, shown, 'records.create', { collection: 'responses', data: answer })).toMatchObject({ ok: true })
    expect(await call(STUDENT, shown, 'records.list', { collection: 'responses' })).toMatchObject({ ok: true, data: [{ mine: true }] })
    expect(await status(STUDENT, shown)).toBe('available')
  })

  it('a student who isn’t enrolled here gets the same unavailable', async () => {
    expect(await call(STRANGER, shown, 'records.list', { collection: 'responses' })).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('with the release gate closed a shown installation is unavailable to students, and the professor keeps working', async () => {
    await withGateClosed(async () => {
      expect(await status(STUDENT, shown)).toBe('unavailable')
      expect(await call(PROFESSOR, shown, 'records.list', { collection: 'responses' })).toMatchObject({ ok: true })
    })
  })

  it('the student only ever gets the student view, and the frame route serves only the student bundle', async () => {
    session.userId = STUDENT
    expect(await issueFrameUrl(shown.installation, 'professor')).toBeNull()
    const url = new URL((await issueFrameUrl(shown.installation, 'student'))!)
    const res = await frameResponse(url.host, shown.installation, 'student', url.searchParams.get('t'))
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain('student_shown()')
    expect(html).not.toContain('professor_shown()')
    // The same ticket can't be pointed at the professor view.
    expect((await frameResponse(url.host, shown.installation, 'professor', url.searchParams.get('t'))).status).toBe(404)
  })

  it('a completed student reads their history but can’t add to it', async () => {
    expect(await call(FINISHED, shown, 'records.create', { collection: 'responses', data: answer })).toMatchObject({ ok: true })
    await sql(`update public.enrollments set status = 'completed' where section_id = $1 and student_id = $2`, [section, FINISHED])
    try {
      expect(await call(FINISHED, shown, 'records.list', { collection: 'responses' })).toMatchObject({ ok: true, data: [{ mine: true }] })
      expect(await call(FINISHED, shown, 'records.create', { collection: 'responses', data: answer })).toMatchObject({
        ok: false,
        error: { code: 'not_available' },
      })
      expect(await status(FINISHED, shown)).toBe('readOnly')
    } finally {
      await sql(`update public.enrollments set status = 'enrolled' where section_id = $1 and student_id = $2`, [section, FINISHED])
    }
  })

  it('an archived section is read-only for everyone', async () => {
    await sql('update public.course_sections set archived_at = now() where id = $1', [section])
    try {
      expect(await call(STUDENT, shown, 'records.list', { collection: 'responses' })).toMatchObject({ ok: true })
      expect(await call(STUDENT, shown, 'records.create', { collection: 'responses', data: answer })).toMatchObject({ ok: false })
      expect(await call(PROFESSOR, shown, 'records.create', { collection: 'questions', data: { prompt: 'p', skill: 's', open: true } })).toMatchObject({
        ok: false,
      })
      expect(await status(STUDENT, shown)).toBe('readOnly')
    } finally {
      await sql('update public.course_sections set archived_at = null where id = $1', [section])
    }
  })

  it('hiding stops an open student frame at its next call and its next heartbeat', async () => {
    expect(await call(STUDENT, shown, 'records.list', { collection: 'responses' })).toMatchObject({ ok: true })
    ok(await hide(shown.installation))
    const before = await recordCount(shown.installation)
    expect(await call(STUDENT, shown, 'records.create', { collection: 'responses', data: answer })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    })
    expect(await status(STUDENT, shown)).toBe('unavailable')
    expect(await recordCount(shown.installation)).toBe(before)
    // The professor's own view is unaffected, and showing it again restores access.
    expect(await call(PROFESSOR, shown, 'records.list', { collection: 'responses' })).toMatchObject({ ok: true })
    ok(await show(shown.installation))
    expect(await status(STUDENT, shown)).toBe('available')
  })

  it('the kill switch stops every open frame, the professor’s too, and the frame route', async () => {
    session.userId = STUDENT
    const url = new URL((await issueFrameUrl(shown.installation, 'student'))!)
    await withKillSwitch(async () => {
      for (const user of [STUDENT, PROFESSOR]) {
        expect(await call(user, shown, 'records.list', { collection: 'responses' })).toMatchObject({ ok: false, error: { code: 'unavailable' } })
        expect(await status(user, shown)).toBe('unavailable')
      }
      expect((await frameResponse(url.host, shown.installation, 'student', url.searchParams.get('t'))).status).toBe(404)
      expect(await studentToolTabs(section)).toEqual([])
    })
    expect(await status(STUDENT, shown)).toBe('available')
  })

  it('losing the entitlement makes open frames read-only; history stays readable', async () => {
    await withoutEntitlement(async () => {
      expect(await call(STUDENT, shown, 'records.list', { collection: 'responses' })).toMatchObject({ ok: true })
      expect(await call(STUDENT, shown, 'records.create', { collection: 'responses', data: answer })).toMatchObject({
        ok: false,
        error: { code: 'not_available' },
      })
      expect(await status(STUDENT, shown)).toBe('readOnly')
      expect(await status(PROFESSOR, shown)).toBe('readOnly')
    })
    expect(await status(STUDENT, shown)).toBe('available')
  })

  it('course tabs: students get shown installations only; professors get every active one, marked', async () => {
    const studentTabs = (await studentToolTabs(section)).map((t) => t.installationId)
    expect(studentTabs).toContain(shown.installation)
    expect(studentTabs).not.toContain(hidden.installation)
    const professorTabs = await professorToolTabs(section)
    expect(professorTabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ installationId: shown.installation, hiddenFromStudents: false }),
        expect.objectContaining({ installationId: hidden.installation, hiddenFromStudents: true }),
      ]),
    )
  })

  it('an upgrade still makes an open frame stale, at its next call and its next heartbeat', async () => {
    session.userId = PROFESSOR
    const next = ok(
      await lifecycle.publishVersion({
        sectionId: section,
        projectId: shown.project,
        manifest: { ...exitTicket, id: shown.slug, version: '1.0.1' },
        source: {},
        studentBundle: 'student_next()',
        professorBundle: 'professor_next()',
      }),
    )
    const upgrade = { sectionId: section, installationId: shown.installation, versionId: next }
    // Students can see this tool: a version the validator hasn't cleared can't reach them.
    expect(await lifecycle.approveAndActivateVersion(upgrade)).toMatchObject({ ok: false, error: expect.stringMatching(/automatic checks/) })
    expect(await status(STUDENT, shown)).toBe('available')
    await clearedByValidator(next)
    session.userId = PROFESSOR
    ok(await lifecycle.approveAndActivateVersion(upgrade))
    expect(await call(STUDENT, shown, 'records.list', { collection: 'responses' })).toMatchObject({ ok: false, error: { code: 'stale' } })
    expect(await status(STUDENT, shown)).toBe('stale')
    expect(await status(STUDENT, shown, next)).toBe('available')
  })

  it('an archived installation leaves the tabs, and a student who could see it keeps read-only access', async () => {
    session.userId = PROFESSOR
    const current = (await sql<{ v: string }>('select current_version_id as v from public.studio_plugin_installations where id = $1', [shown.installation]))[0].v
    ok(await lifecycle.archiveInstallation({ sectionId: section, installationId: shown.installation }))
    expect((await studentToolTabs(section)).map((t) => t.installationId)).not.toContain(shown.installation)
    expect((await professorToolTabs(section)).map((t) => t.installationId)).not.toContain(shown.installation)
    const archived = { ...shown, version: current }
    expect(await call(STUDENT, archived, 'records.list', { collection: 'responses' })).toMatchObject({ ok: true })
    expect(await status(STUDENT, archived)).toBe('readOnly')
  })
})

// ── Per-student quota (Step 5C) ───────────────────────────────────────

describe('per-student storage quota', () => {
  let q: Plugin
  let limits: { studentRecords: number; studentBytes: number; installationRecords: number }

  beforeAll(async () => {
    q = await install('student')
    const [row] = await sql<{ sr: string; sb: string; ir: string }>(
      'select student_max_records as sr, student_max_bytes as sb, installation_max_records as ir from public.studio_plugin_limits where id',
    )
    limits = { studentRecords: Number(row.sr), studentBytes: Number(row.sb), installationRecords: Number(row.ir) }
  })

  const insertAnswer = (student: string, text = 'mine') =>
    sql<{ id: string }>(
      `insert into public.studio_plugin_records (institution_id, section_id, installation_id, version_id, collection, owner_id, author_id, data)
       values ($1, $2, $3, $4, 'responses', $5, $5, $6::jsonb) returning id`,
      [A.institution, section, q.installation, q.version, student, JSON.stringify({ questionId: 'q1', answer: text, confidence: 1 })],
    )
  const insertQuestion = () =>
    sql<{ id: string }>(
      `insert into public.studio_plugin_records (institution_id, section_id, installation_id, version_id, collection, owner_id, author_id, data)
       values ($1, $2, $3, $4, 'questions', null, $5, '{"prompt": "p", "skill": "s", "open": true}'::jsonb) returning id`,
      [A.institution, section, q.installation, q.version, PROFESSOR],
    )
  const studentUsage = async (student: string) => {
    const [row] = await sql<{ n: string; b: string }>(
      'select record_count as n, record_bytes as b from public.studio_plugin_student_usage where installation_id = $1 and student_id = $2',
      [q.installation, student],
    )
    return row ? { records: Number(row.n), bytes: Number(row.b) } : null
  }
  const studentActual = async (student: string) => {
    const [row] = await sql<{ n: string; b: string }>(
      `select count(*) as n, coalesce(sum(octet_length(data::text)), 0) as b
         from public.studio_plugin_records where installation_id = $1 and owner_id = $2`,
      [q.installation, student],
    )
    return { records: Number(row.n), bytes: Number(row.b) }
  }
  const installationUsage = async () => {
    const [row] = await sql<{ n: string; b: string }>(
      'select record_count as n, record_bytes as b from public.studio_plugin_usage where installation_id = $1',
      [q.installation],
    )
    return { records: Number(row.n), bytes: Number(row.b) }
  }
  const setStudentUsage = (student: string, records: number, bytes: number) =>
    sql('update public.studio_plugin_student_usage set record_count = $3, record_bytes = $4 where installation_id = $1 and student_id = $2', [
      q.installation,
      student,
      records,
      bytes,
    ])
  /** Puts every counter back to what is actually stored. */
  const recount = async () => {
    for (const student of [STUDENT, FINISHED]) {
      const now = await studentActual(student)
      await setStudentUsage(student, now.records, now.bytes)
    }
    await sql(
      `update public.studio_plugin_usage u set record_count = c.n, record_bytes = c.b
         from (select count(*) as n, coalesce(sum(octet_length(data::text)), 0) as b
                 from public.studio_plugin_records where installation_id = $1) c
        where u.installation_id = $1`,
      [q.installation],
    )
  }

  it('a student’s first record creates their counter, and every write keeps it exact', async () => {
    expect(await studentUsage(STUDENT)).toBeNull()
    const [a] = await insertAnswer(STUDENT)
    await insertAnswer(STUDENT, 'second')
    expect(await studentUsage(STUDENT)).toEqual(await studentActual(STUDENT))
    await sql(`update public.studio_plugin_records set data = $2::jsonb where id = $1`, [
      a.id,
      JSON.stringify({ questionId: 'q1', answer: 'a much longer answer than before', confidence: 1 }),
    ])
    expect(await studentUsage(STUDENT)).toEqual(await studentActual(STUDENT))
    await sql('delete from public.studio_plugin_records where id = $1', [a.id])
    expect(await studentUsage(STUDENT)).toEqual(await studentActual(STUDENT))
    expect((await studentUsage(STUDENT))!.records).toBe(1)
  })

  it('an update changes the student’s bytes by the difference only', async () => {
    const [row] = await insertAnswer(STUDENT, 'x')
    const before = (await studentUsage(STUDENT))!
    await sql(`update public.studio_plugin_records set data = $2::jsonb where id = $1`, [
      row.id,
      JSON.stringify({ questionId: 'q1', answer: 'x'.repeat(51), confidence: 1 }),
    ])
    const after = (await studentUsage(STUDENT))!
    expect(after.records).toBe(before.records)
    expect(after.bytes - before.bytes).toBe(50)
  })

  it('refuses the record past a student’s record limit; nothing is stored or counted', async () => {
    const now = await studentActual(STUDENT)
    const installationBefore = await installationUsage()
    await setStudentUsage(STUDENT, limits.studentRecords, now.bytes)
    await expect(insertAnswer(STUDENT)).rejects.toMatchObject({ code: '54000', hint: 'student' })
    expect((await studentActual(STUDENT)).records).toBe(now.records)
    // The installation's counter was taken first, and the rollback gave it back.
    expect(await installationUsage()).toEqual(installationBefore)
    await recount()
  })

  it('refuses the write past a student’s byte limit', async () => {
    const now = await studentActual(STUDENT)
    await setStudentUsage(STUDENT, now.records, limits.studentBytes - 10)
    await expect(insertAnswer(STUDENT, 'more than ten bytes of answer')).rejects.toMatchObject({ code: '54000' })
    expect((await studentActual(STUDENT)).records).toBe(now.records)
    await recount()
  })

  it('one student at their limit doesn’t touch another student’s allowance', async () => {
    const now = await studentActual(STUDENT)
    await setStudentUsage(STUDENT, limits.studentRecords, now.bytes)
    await expect(insertAnswer(STUDENT)).rejects.toMatchObject({ code: '54000' })
    await insertAnswer(FINISHED, 'mine to keep')
    expect((await studentUsage(FINISHED))!.records).toBe(1)
    await recount()
  })

  it('staff content counts toward the installation only, never a student', async () => {
    const before = await installationUsage()
    const students = await sql('select * from public.studio_plugin_student_usage where installation_id = $1 order by student_id', [q.installation])
    const [row] = await insertQuestion()
    expect((await installationUsage()).records).toBe(before.records + 1)
    expect(await sql('select * from public.studio_plugin_student_usage where installation_id = $1 order by student_id', [q.installation])).toEqual(students)
    await sql('delete from public.studio_plugin_records where id = $1', [row.id])
  })

  it('a full installation refuses a student who still has allowance left', async () => {
    const before = await installationUsage()
    await sql('update public.studio_plugin_usage set record_count = $2 where installation_id = $1', [q.installation, limits.installationRecords])
    const studentBefore = await studentUsage(STUDENT)
    await expect(insertAnswer(STUDENT)).rejects.toMatchObject({ code: '54000', hint: 'installation' })
    expect(await studentUsage(STUDENT)).toEqual(studentBefore)
    await sql('update public.studio_plugin_usage set record_count = $2 where installation_id = $1', [q.installation, before.records])
  })

  it('a write refused for any other reason leaves both counters as they were', async () => {
    await recount()
    const [installationBefore, studentBefore] = [await installationUsage(), await studentUsage(STUDENT)]
    // The records guard refuses a perStudent record whose owner isn't enrolled here.
    await expect(
      sql(
        `insert into public.studio_plugin_records (institution_id, section_id, installation_id, version_id, collection, owner_id, author_id, data)
         values ($1, $2, $3, $4, 'responses', $5, $5, '{"questionId": "q", "answer": "a", "confidence": 1}'::jsonb)`,
        [A.institution, section, q.installation, q.version, STRANGER],
      ),
    ).rejects.toThrow()
    expect(await installationUsage()).toEqual(installationBefore)
    expect(await studentUsage(STUDENT)).toEqual(studentBefore)
  })

  it('without its limits row the database refuses every write, rather than allowing everything', async () => {
    const [saved] = await sql<Record<string, string>>('select * from public.studio_plugin_limits where id')
    await sql('delete from public.studio_plugin_limits where id')
    try {
      await expect(insertQuestion()).rejects.toMatchObject({ code: '54000', message: expect.stringMatching(/limits are missing/) })
    } finally {
      await sql(
        `insert into public.studio_plugin_limits (id, installation_max_records, installation_max_bytes, student_max_records, student_max_bytes)
         values (true, $1, $2, $3, $4)`,
        [saved.installation_max_records, saved.installation_max_bytes, saved.student_max_records, saved.student_max_bytes],
      )
    }
  })

  it('client roles can’t read or change the limits or the per-student counters', async () => {
    const [row] = await sql<Record<string, boolean>>(
      `select has_table_privilege('authenticated', 'public.studio_plugin_limits', 'select') as a,
              has_table_privilege('authenticated', 'public.studio_plugin_limits', 'update') as b,
              has_table_privilege('authenticated', 'public.studio_plugin_student_usage', 'select') as c,
              has_table_privilege('anon', 'public.studio_plugin_student_usage', 'insert') as d`,
    )
    expect(row).toEqual({ a: false, b: false, c: false, d: false })
  })

  it('through the Bridge, a student at their own limit is told it’s their allowance', async () => {
    ok(await show(q.installation))
    const now = await studentActual(STUDENT)
    await setStudentUsage(STUDENT, limits.studentRecords, now.bytes)
    expect(await call(STUDENT, q, 'records.create', { collection: 'responses', data: answer })).toEqual({
      ok: false,
      error: { code: 'full', message: 'You’ve used all the storage this tool gives you, so this wasn’t saved.' },
    })
    // A classmate is unaffected.
    expect(await call(FINISHED, q, 'records.create', { collection: 'responses', data: answer })).toMatchObject({ ok: true })
    await recount()
  })

  // Real connections only: PGlite has one.
  it.skipIf(ON_PGLITE)('two concurrent writes by one student can’t both take their last slot', async () => {
    const env = dbEnv()
    const [first, second] = [new Client({ connectionString: env.pgUrl }), new Client({ connectionString: env.pgUrl })]
    await first.connect()
    await second.connect()
    const insert = (c: Client) =>
      c.query(
        `insert into public.studio_plugin_records (institution_id, section_id, installation_id, version_id, collection, owner_id, author_id, data)
         values ($1, $2, $3, $4, 'responses', $5, $5, '{"questionId": "q", "answer": "race", "confidence": 1}'::jsonb)`,
        [A.institution, section, q.installation, q.version, STUDENT],
      )
    try {
      await recount()
      const now = await studentActual(STUDENT)
      await setStudentUsage(STUDENT, limits.studentRecords - 1, now.bytes)
      await first.query('begin')
      await insert(first)
      const racing = insert(second).then(
        () => 'stored',
        (e: { code?: string }) => e.code,
      )
      await first.query('commit')
      expect(await racing).toBe('54000')
      expect((await studentUsage(STUDENT))!.records).toBe(limits.studentRecords)
    } finally {
      await first.end()
      await second.end()
      await recount()
    }
  })
})

// ── Candidate preview and the professor's actions (Step 5C) ───────────

describe('previewing another version', () => {
  let p: Plugin
  let next = ''
  let foreign = ''

  beforeAll(async () => {
    p = await install('preview')
    session.userId = PROFESSOR
    next = ok(
      await lifecycle.publishVersion({
        sectionId: section,
        projectId: p.project,
        manifest: { ...exitTicket, id: p.slug, version: '1.1.0' },
        source: {},
        studentBundle: 'student_candidate()',
        professorBundle: 'professor_candidate()',
      }),
    )
    foreign = (await install('foreign')).version
  })

  const state = async () =>
    (
      await sql<{ current: string; visibility: string; approvals: string; records: string }>(
        `select i.current_version_id as current, i.student_visibility as visibility,
                (select count(*) from public.studio_plugin_approvals a where a.installation_id = i.id) as approvals,
                (select count(*) from public.studio_plugin_records r where r.installation_id = i.id) as records
           from public.studio_plugin_installations i where i.id = $1`,
        [p.installation],
      )
    )[0]

  it('serves the candidate’s own bundle, and changes nothing about the installation', async () => {
    const before = await state()
    session.userId = PROFESSOR
    const viewer = await resolveViewer(p.installation)
    expect(await candidateVersion(viewer!, next)).toMatchObject({ versionId: next, manifest: { version: '1.1.0' } })
    for (const view of ['student', 'professor'] as const) {
      const url = new URL((await issueFrameUrl(p.installation, view, next))!)
      const html = await (await frameResponse(url.host, p.installation, view, url.searchParams.get('t'))).text()
      expect(html).toContain(`${view}_candidate()`)
    }
    expect(await state()).toEqual(before)
  })

  it('a candidate ticket used on the live bridge gets `stale`, so it reaches no data', async () => {
    expect(await call(PROFESSOR, p, 'records.list', { collection: 'responses' }, next)).toMatchObject({ ok: false, error: { code: 'stale' } })
  })

  it('refuses a version of another plugin, and refuses everyone but the professor', async () => {
    session.userId = PROFESSOR
    const viewer = await resolveViewer(p.installation)
    expect(await candidateVersion(viewer!, foreign)).toBeNull()
    expect(await issueFrameUrl(p.installation, 'student', foreign)).toBeNull()
    session.userId = TA
    const ta = await resolveViewer(p.installation)
    expect(await candidateVersion(ta!, next)).toBeNull()
  })
})

describe('the professor’s actions, end to end', () => {
  let p: Plugin
  beforeAll(async () => {
    p = await install('actions')
  })

  it('showing a tool the validator hasn’t cleared is refused', async () => {
    session.userId = PROFESSOR
    expect(await publicationActions.showToStudentsAction(section, p.installation, true)).toMatchObject({
      error: expect.any(String),
      blockers: [{ code: 'validator_failed' }],
    })
    expect(await visibilityOf(p.installation)).toBe('hidden')
  })

  it('a TA’s call to any of them changes nothing', async () => {
    session.userId = TA
    expect(await publicationActions.archiveInstallationAction(section, p.installation)).toEqual({ error: 'This isn’t available.' })
    expect(await publicationActions.hideFromStudentsAction(section, p.installation)).toEqual({ error: 'This isn’t available.' })
    const [row] = await sql<{ status: string }>('select status from public.studio_plugin_installations where id = $1', [p.installation])
    expect(row.status).toBe('active')
  })

  it('hiding works while Studio is paused', async () => {
    ok(await show(p.installation))
    await withKillSwitch(async () => {
      session.userId = PROFESSOR
      expect(await publicationActions.hideFromStudentsAction(section, p.installation)).toEqual({ success: true })
    })
    expect(await visibilityOf(p.installation)).toBe('hidden')
  })

  it('archiving keeps every record, leaves the tabs, moves a visible tool to Past tools, and can’t be undone by showing', async () => {
    ok(await show(p.installation))
    expect(await call(STUDENT, p, 'records.create', { collection: 'responses', data: answer })).toMatchObject({ ok: true })
    const records = await recordCount(p.installation)
    session.userId = PROFESSOR
    expect(await publicationActions.archiveInstallationAction(section, p.installation)).toEqual({ success: true })
    expect(await recordCount(p.installation)).toBe(records)
    expect((await studentToolTabs(section)).map((t) => t.installationId)).not.toContain(p.installation)
    expect((await studentPastTools(section)).map((t) => t.installationId)).toContain(p.installation)
    vi.mocked(prePublishVerdict).mockResolvedValueOnce({ status: 'passed' })
    session.userId = PROFESSOR
    expect(await publicationActions.showToStudentsAction(section, p.installation, true)).toMatchObject({ blockers: [{ code: 'not_active' }] })
  })

  it('a hidden tool that was archived never appears in a student’s Past tools', async () => {
    const q = await install('hiddenarchive')
    session.userId = PROFESSOR
    ok(await lifecycle.archiveInstallation({ sectionId: section, installationId: q.installation }))
    expect((await studentPastTools(section)).map((t) => t.installationId)).not.toContain(q.installation)
  })
})
