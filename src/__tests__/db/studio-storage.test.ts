/**
 * Studio plugin storage (supabase/migrations/20260930175948_studio_plugin_storage.sql).
 *
 * Every refusal here is the DATABASE refusing, with no server code involved. The server
 * decides what each viewer may see; these constraints and triggers are what still hold if
 * that server code has a bug. Each test builds its own plugin project in tenant A, so the
 * tests don't depend on each other's state.
 */
import { createHash, randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import exitTicket from '@/lib/studio/fixtures/exit-ticket/plugin.manifest.json'
import { dbEnv } from './env'
import { FIXTURE } from './fixture'

const A = FIXTURE.a
const B = FIXTURE.b
const run = `t${randomBytes(4).toString('hex')}`

let db: Client
// A second section in tenant A, so one version can be installed in two sections.
let sectionA2: string
const projects: string[] = []
let slugs = 0

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(text, params)).rows as T[]
}

/** Asserts the database refused, with this SQLSTATE code. */
async function refused(attempt: Promise<unknown>, code: string, message?: RegExp) {
  const err = await attempt.then(
    () => null,
    (e: { code?: string; message: string }) => e,
  )
  expect(err, 'expected the database to refuse this').not.toBeNull()
  expect(err!.code, err!.message).toBe(code)
  if (message) expect(err!.message).toMatch(message)
}

const FK_VIOLATION = '23503'
const CHECK_VIOLATION = '23514'
const INSUFFICIENT_PRIVILEGE = '42501'

type Collections = Record<string, unknown>

function manifestFor(slug: string, version: string, extraCollections: Collections = {}) {
  return { ...exitTicket, id: slug, version, collections: { ...exitTicket.collections, ...extraCollections } }
}

async function publish(projectId: string, slug: string, version: string, extraCollections: Collections = {}) {
  const manifest = manifestFor(slug, version, extraCollections)
  const bundle = `/* ${slug} ${version} */`
  const [row] = await sql<{ id: string }>(
    `insert into public.studio_plugin_versions
       (project_id, institution_id, version, manifest, bridge_version, source, student_bundle, professor_bundle,
        bundle_sha256, published_by)
     values ($1, $2, $3, $4, 'v1', '{}'::jsonb, $5, $5, $6, $7) returning id`,
    [projectId, A.institution, version, manifest, bundle, createHash('sha256').update(bundle).digest('hex'), A.users.professor.id],
  )
  return row.id
}

/** A fresh project in tenant A with 1.0.0 and 1.1.0 published. 1.1.0 adds a `hints` collection. */
async function newPlugin(extraCollections: Collections = {}) {
  const slug = `p-${run}-${slugs++}`
  const [{ id }] = await sql<{ id: string }>(
    `insert into public.studio_plugin_projects (institution_id, owner_id, slug, name)
     values ($1, $2, $3, 'Exit ticket') returning id`,
    [A.institution, A.users.professor.id, slug],
  )
  projects.push(id)
  const v1 = await publish(id, slug, '1.0.0', extraCollections)
  const v2 = await publish(id, slug, '1.1.0', { ...extraCollections, hints: { access: 'shared', fields: { text: 'text' } } })
  return { id, slug, v1, v2 }
}

async function install(sectionId: string, versionId: string) {
  const [{ id }] = await sql<{ id: string }>('select public.studio_install_plugin($1, $2, $3) as id', [
    sectionId,
    versionId,
    A.users.professor.id,
  ])
  return id
}

/** These installations are never shown to students, so activation expects 'hidden'. */
function activate(installationId: string, versionId: string, approve: boolean, actor = A.users.professor.id) {
  return sql(`select public.studio_activate_version($1, $2, $3, $4, 'hidden')`, [installationId, versionId, actor, approve])
}

interface RecordInput {
  installation: string
  version: string
  section?: string
  collection?: string
  owner?: string | null
  author?: string
  data?: Record<string, unknown>
}

async function write(r: RecordInput) {
  const [row] = await sql<{ id: string }>(
    `insert into public.studio_plugin_records
       (institution_id, section_id, installation_id, version_id, collection, owner_id, author_id, data)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      A.institution,
      r.section ?? A.section,
      r.installation,
      r.version,
      r.collection ?? 'questions',
      r.owner ?? null,
      r.author ?? A.users.professor.id,
      r.data ?? { prompt: 'What was unclear today?', skill: 'recursion', open: true },
    ],
  )
  return row.id
}

async function currentVersion(installationId: string) {
  const [row] = await sql<{ current_version_id: string }>(
    'select current_version_id from public.studio_plugin_installations where id = $1',
    [installationId],
  )
  return row.current_version_id
}

beforeAll(async () => {
  db = new Client({ connectionString: dbEnv().pgUrl })
  await db.connect()
  const [row] = await sql<{ id: string }>(
    `insert into public.course_sections (institution_id, course_id, section_code, semester, year, professor_id)
     values ($1, $2, $3, 'Fall', 2026, $4) returning id`,
    [A.institution, A.course, `STUDIO-${run}`, A.users.professor.id],
  )
  sectionA2 = row.id
})

afterAll(async () => {
  if (!db) return
  await sql('delete from public.studio_plugin_records where installation_id in (select id from public.studio_plugin_installations where project_id = any($1))', [projects])
  await sql('delete from public.studio_plugin_installations where project_id = any($1)', [projects])
  await sql('delete from public.studio_plugin_versions where project_id = any($1)', [projects])
  await sql('delete from public.studio_plugin_projects where id = any($1)', [projects])
  if (sectionA2) await sql('delete from public.course_sections where id = $1', [sectionA2])
  await db.end()
})

describe('one version in two sections (rule 2.4)', () => {
  it('installs the same version twice, with one approval per installation', async () => {
    const p = await newPlugin()
    const inA = await install(A.section, p.v1)
    const inA2 = await install(sectionA2, p.v1)

    expect(inA).not.toBe(inA2)
    expect([await currentVersion(inA), await currentVersion(inA2)]).toEqual([p.v1, p.v1])
    const approvals = await sql('select installation_id from public.studio_plugin_approvals where version_id = $1', [p.v1])
    expect(approvals).toHaveLength(2)
  })

  it('keeps each installation’s records apart, and refuses a record stamped with the other section', async () => {
    const p = await newPlugin()
    const inA = await install(A.section, p.v1)
    const inA2 = await install(sectionA2, p.v1)
    const mine = await write({ installation: inA, version: p.v1 })
    await write({ installation: inA2, version: p.v1, section: sectionA2 })

    const rows = await sql<{ id: string }>('select id from public.studio_plugin_records where installation_id = $1', [inA])
    expect(rows.map((r) => r.id)).toEqual([mine])

    await refused(write({ installation: inA, version: p.v1, section: sectionA2 }), CHECK_VIOLATION, /Tenant mismatch/)
  })

  it('refuses a perStudent record for a student not enrolled in that section', async () => {
    const p = await newPlugin()
    const inA = await install(A.section, p.v1)
    const inA2 = await install(sectionA2, p.v1)
    const answer = { questionId: 'q1', answer: 'The base case', confidence: 3 }

    // The fixture student is enrolled in A's first section only.
    await write({ installation: inA, version: p.v1, collection: 'responses', owner: A.users.student.id, data: answer })
    await refused(
      write({ installation: inA2, version: p.v1, section: sectionA2, collection: 'responses', owner: A.users.student.id, data: answer }),
      CHECK_VIOLATION,
      /enrolled/,
    )
  })
})

// ── Step 11 (supabase/migrations/20261003120000_studio_builder_quality.sql) ──

const ATTENDANCE = { attendance: { access: 'staffPerStudent', fields: { status: 'text' } } }
const PRESENT = { status: 'present' }
const ANSWER = { questionId: 'q1', answer: 'The base case', confidence: 3 }

describe('staffPerStudent records', () => {
  it('accepts one the professor or a TA writes about an enrolled student', async () => {
    const p = await newPlugin(ATTENDANCE)
    const inA = await install(A.section, p.v1)
    const about = { installation: inA, version: p.v1, collection: 'attendance', owner: A.users.student.id, data: PRESENT }
    await write(about)
    await write({ ...about, author: A.users.ta.id })
    const rows = await sql('select owner_id, author_id from public.studio_plugin_records where installation_id = $1 order by created_at', [inA])
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.owner_id === A.users.student.id)).toBe(true)
  })

  it('refuses one about no one, or about someone who isn’t a student of the section', async () => {
    const p = await newPlugin(ATTENDANCE)
    const inA = await install(A.section, p.v1)
    const about = { installation: inA, version: p.v1, collection: 'attendance', data: PRESENT }
    for (const owner of [null, A.users.professor.id, A.users.ta.id, B.users.student.id]) {
      await refused(write({ ...about, owner }), CHECK_VIOLATION, /staffPerStudent record must belong to a student enrolled/)
    }
  })

  it('refuses one written by a grader or by the student themself', async () => {
    const p = await newPlugin(ATTENDANCE)
    const inA = await install(A.section, p.v1)
    const about = { installation: inA, version: p.v1, collection: 'attendance', owner: A.users.student.id, data: PRESENT }
    for (const author of [A.users.grader.id, A.users.student.id]) {
      await refused(write({ ...about, author }), CHECK_VIOLATION, /professor or a TA/)
    }
  })

  it('lets anyone the server allows edit a record a TA wrote: the author check is for new records only', async () => {
    const p = await newPlugin(ATTENDANCE)
    const inA = await install(A.section, p.v1)
    const id = await write({ installation: inA, version: p.v1, collection: 'attendance', owner: A.users.student.id, author: A.users.ta.id, data: PRESENT })
    await sql(`update public.studio_plugin_records set data = '{"status": "late"}'::jsonb where id = $1`, [id])
    const [row] = await sql<{ data: unknown }>('select data from public.studio_plugin_records where id = $1', [id])
    expect(row.data).toEqual({ status: 'late' })
  })
})

describe('a student’s storage counts only what they wrote', () => {
  async function counters(installation: string) {
    const [inst] = await sql<{ n: string }>('select record_count as n from public.studio_plugin_usage where installation_id = $1', [installation])
    const [student] = await sql<{ n: string }>(
      'select record_count as n from public.studio_plugin_student_usage where installation_id = $1 and student_id = $2',
      [installation, A.users.student.id],
    )
    return { installation: Number(inst.n), student: student ? Number(student.n) : null }
  }

  it('a record staff write about a student counts toward the installation only, on insert and on delete', async () => {
    const p = await newPlugin(ATTENDANCE)
    const inA = await install(A.section, p.v1)
    const before = await counters(inA)

    const staffRecord = await write({ installation: inA, version: p.v1, collection: 'attendance', owner: A.users.student.id, data: PRESENT })
    expect(await counters(inA)).toEqual({ installation: before.installation + 1, student: null })

    const own = await write({ installation: inA, version: p.v1, collection: 'responses', owner: A.users.student.id, author: A.users.student.id, data: ANSWER })
    expect(await counters(inA)).toEqual({ installation: before.installation + 2, student: 1 })

    // Deleting the staff record leaves the student's count alone: both branches use owner = author.
    await sql('delete from public.studio_plugin_records where id = $1', [staffRecord])
    expect(await counters(inA)).toEqual({ installation: before.installation + 1, student: 1 })
    await sql('delete from public.studio_plugin_records where id = $1', [own])
    expect(await counters(inA)).toEqual({ installation: before.installation, student: 0 })
  })
})

describe('handle salts', () => {
  it('each installation gets its own, and it never changes', async () => {
    const p = await newPlugin()
    const inA = await install(A.section, p.v1)
    const inA2 = await install(sectionA2, p.v1)
    const rows = await sql<{ handle_salt: string }>('select handle_salt from public.studio_plugin_installations where id = any($1)', [[inA, inA2]])
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.handle_salt))).toBe(true)
    expect(rows[0].handle_salt).not.toBe(rows[1].handle_salt)
    await refused(
      sql(`update public.studio_plugin_installations set handle_salt = repeat('0', 64) where id = $1`, [inA]),
      CHECK_VIOLATION,
      /salt can't change/,
    )
  })
})

describe('bridge versions', () => {
  async function publishOn(projectId: string, slug: string, version: string, bridge: string) {
    const manifest = { ...manifestFor(slug, version, { hints: { access: 'shared', fields: { text: 'text' } } }), bridgeVersion: bridge }
    const bundle = `/* ${slug} ${version} */`
    return sql(
      `insert into public.studio_plugin_versions
         (project_id, institution_id, version, manifest, bridge_version, source, student_bundle, professor_bundle,
          bundle_sha256, published_by)
       values ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $6, $7, $8)`,
      [projectId, A.institution, version, manifest, bridge, bundle, createHash('sha256').update(bundle).digest('hex'), A.users.professor.id],
    )
  }

  it('accepts v2 next to v1, and nothing else', async () => {
    const p = await newPlugin()
    await publishOn(p.id, p.slug, '1.2.0', 'v2')
    await refused(publishOn(p.id, p.slug, '1.3.0', 'v3'), CHECK_VIOLATION)
  })
})

describe('institution boundaries', () => {
  it('refuses to install a project into another institution’s section', async () => {
    const p = await newPlugin()
    await refused(install(B.section, p.v1), CHECK_VIOLATION, /Tenant mismatch/)
  })

  it('refuses a project whose owner belongs to another institution', async () => {
    await refused(
      sql(
        `insert into public.studio_plugin_projects (institution_id, owner_id, slug, name) values ($1, $2, $3, 'x')`,
        [B.institution, A.users.professor.id, `x-${run}`],
      ),
      CHECK_VIOLATION,
      /Tenant mismatch/,
    )
  })

  it('refuses to move a project to another institution, even with an owner there', async () => {
    const p = await newPlugin()
    await refused(
      sql('update public.studio_plugin_projects set institution_id = $1, owner_id = $2 where id = $3', [
        B.institution,
        B.users.professor.id,
        p.id,
      ]),
      CHECK_VIOLATION,
      /can't move to another institution/,
    )
  })

  it('refuses a publisher, installer, approver or archiver from another institution', async () => {
    const p = await newPlugin()
    const outsider = B.users.professor.id
    const bundle = 'x'
    await refused(
      sql(
        `insert into public.studio_plugin_versions
           (project_id, institution_id, version, manifest, bridge_version, source, student_bundle, professor_bundle,
            bundle_sha256, published_by)
         values ($1, $2, '1.2.0', $3, 'v1', '{}'::jsonb, $4, $4, $5, $6)`,
        [p.id, A.institution, manifestFor(p.slug, '1.2.0', { hints: { access: 'shared', fields: { text: 'text' } } }), bundle, createHash('sha256').update(bundle).digest('hex'), outsider],
      ),
      CHECK_VIOLATION,
      /publisher/,
    )
    await refused(
      sql('select public.studio_install_plugin($1, $2, $3)', [A.section, p.v1, outsider]),
      CHECK_VIOLATION,
      /installs/,
    )
    const inA = await install(A.section, p.v1)
    await refused(activate(inA, p.v2, true, outsider), CHECK_VIOLATION, /approver/)
    await refused(
      sql(`update public.studio_plugin_installations set status = 'archived', archived_by = $2 where id = $1`, [inA, outsider]),
      CHECK_VIOLATION,
      /archives/,
    )
  })
})

describe('versions and approvals', () => {
  it('refuses a version from another project', async () => {
    const p = await newPlugin()
    const other = await newPlugin()
    const inA = await install(A.section, p.v1)

    await refused(activate(inA, other.v1, true), FK_VIOLATION)
    await refused(
      sql('update public.studio_plugin_installations set current_version_id = $1 where id = $2', [other.v1, inA]),
      FK_VIOLATION,
    )
  })

  it('refuses to activate a version this installation never approved', async () => {
    const p = await newPlugin()
    const inA = await install(A.section, p.v1)

    await refused(activate(inA, p.v2, false), FK_VIOLATION)
    expect(await currentVersion(inA)).toBe(p.v1)
  })

  it('refuses a record written under a version this installation never approved', async () => {
    const p = await newPlugin()
    const inA = await install(A.section, p.v1)

    await refused(write({ installation: inA, version: p.v2 }), FK_VIOLATION)
  })

  it('rolls back one installation and leaves the other on its version', async () => {
    const p = await newPlugin()
    const inA = await install(A.section, p.v1)
    const inA2 = await install(sectionA2, p.v1)
    await activate(inA, p.v2, true)
    await activate(inA2, p.v2, true)

    await activate(inA, p.v1, false)

    expect(await currentVersion(inA)).toBe(p.v1)
    expect(await currentVersion(inA2)).toBe(p.v2)
    // Approvals are history: the rollback didn't remove 1.1.0's approval.
    const kept = await sql('select 1 from public.studio_plugin_approvals where installation_id = $1', [inA])
    expect(kept).toHaveLength(2)
  })

  it('keeps existing records through an upgrade', async () => {
    const p = await newPlugin()
    const inA = await install(A.section, p.v1)
    const before = await write({ installation: inA, version: p.v1 })

    await activate(inA, p.v2, true)
    await write({ installation: inA, version: p.v2, collection: 'hints', data: { text: 'Start from the base case' } })

    const [row] = await sql<{ version_id: string; data: { prompt: string } }>(
      'select version_id, data from public.studio_plugin_records where id = $1',
      [before],
    )
    expect(row).toEqual({ version_id: p.v1, data: { prompt: 'What was unclear today?', skill: 'recursion', open: true } })
  })

  it('refuses to change a published version or an approval', async () => {
    const p = await newPlugin()
    const inA = await install(A.section, p.v1)

    await refused(
      sql(`update public.studio_plugin_versions set student_bundle = 'alert(1)' where id = $1`, [p.v1]),
      CHECK_VIOLATION,
      /immutable/,
    )
    await refused(
      sql('update public.studio_plugin_approvals set approved_at = now() where installation_id = $1', [inA]),
      CHECK_VIOLATION,
      /immutable/,
    )
  })
})

describe('publishing', () => {
  it('refuses a version that is not higher than the last one', async () => {
    const p = await newPlugin()
    await refused(publish(p.id, p.slug, '1.0.5'), CHECK_VIOLATION, /must be higher/)
  })

  it('refuses a breaking change to an existing collection (deferred in v1)', async () => {
    const p = await newPlugin()
    // Keeps 1.1.0's `hints` (dropping it is refused too) and changes one field in `responses`.
    const changed = {
      hints: { access: 'shared', fields: { text: 'text' } },
      responses: { access: 'perStudent', fields: { questionId: 'text', answers: 'text' } },
    }
    await refused(publish(p.id, p.slug, '2.0.0', changed), CHECK_VIOLATION, /Collection responses changed/)
  })

  it('refuses a manifest whose id is not the project’s slug', async () => {
    const p = await newPlugin()
    await refused(publish(p.id, 'someone-else', '1.2.0'), CHECK_VIOLATION, /project slug/)
  })
})

describe('archiving', () => {
  it('an archived installation accepts no writes and no version changes, and keeps its records', async () => {
    const p = await newPlugin()
    const inA = await install(A.section, p.v1)
    const kept = await write({ installation: inA, version: p.v1 })

    await sql(
      `update public.studio_plugin_installations set status = 'archived', archived_at = now(), archived_by = $2
        where id = $1 and status = 'active'`,
      [inA, A.users.professor.id],
    )

    await refused(write({ installation: inA, version: p.v1 }), CHECK_VIOLATION, /archived/)
    await refused(activate(inA, p.v2, true), CHECK_VIOLATION, /not active/)
    expect(await sql('select 1 from public.studio_plugin_records where id = $1', [kept])).toHaveLength(1)
  })

  it('an archived project can’t publish or be installed again, but running installations keep working', async () => {
    const p = await newPlugin()
    const inA = await install(A.section, p.v1)
    await sql(`update public.studio_plugin_projects set status = 'archived', archived_at = now() where id = $1`, [p.id])

    await refused(publish(p.id, p.slug, '1.2.0'), CHECK_VIOLATION, /archived/)
    await refused(install(sectionA2, p.v1), CHECK_VIOLATION, /active project/)
    await write({ installation: inA, version: p.v1 })
  })
})

describe('client roles reach nothing (server-only tables)', () => {
  for (const role of ['anon', 'authenticated']) {
    it(`${role} can't read the tables or call the lifecycle functions`, async () => {
      for (const statement of [
        ...['projects', 'versions', 'installations', 'approvals', 'records'].map(
          (t) => `select 1 from public.studio_plugin_${t} limit 1`,
        ),
        `select public.studio_install_plugin(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
        `select public.studio_activate_version(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), true, 'hidden')`,
      ]) {
        await sql('begin')
        try {
          await sql(`set local role ${role}`)
          await refused(sql(statement), INSUFFICIENT_PRIVILEGE)
        } finally {
          await sql('rollback')
        }
      }
    })
  }
})
