/**
 * Step 9 against a real database (`npm run test:db`): course context for the builder.
 * The eligibility function and its disclosure classes, search ranking and focus, tenant and
 * section isolation, the provenance union at commit, the grants, and one whole build through
 * the real harness, the real Postgres retriever and the real copy guard, ending in a saved
 * version that carries its provenance.
 *
 * Mocked, and only these: the session cookie, logEvent, revalidatePath and the job kick.
 * No model is called: the model is scripted.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dbEnv } from './env'
import { FIXTURE } from './fixture'
import { grantStudio } from './studio-entitlement'
import { call, finish, FLASHCARDS_MANIFEST, plan, PROFESSOR_VIEW, proposeManifest, scriptedModel, STUDENT_VIEW, write } from '../helpers/builder-fixtures'

const session: { userId: string | null } = { userId: null }
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null } }) } }),
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/jobs/enqueue', () => ({ kickWorker: vi.fn(async () => ({ kicked: true })) }))

const { runBuilderSlice, realHarnessDeps } = await import('@/lib/studio/builder/harness')
const service = await import('@/lib/studio/builder/service')
const studioDb = await import('@/lib/studio/db')
const { postgresRetriever, retrievalScope } = await import('@/lib/studio/builder/course-retriever')

const A = FIXTURE.a
const B = FIXTURE.b
const PROFESSOR = A.users.professor.id
const STUDENT = A.users.student.id
const tag = `c${randomBytes(4).toString('hex')}`
const DAY = 86_400_000

let db: Client
let restoreEntitlement: (() => Promise<void>) | undefined
let restoreStudent: { first: string | null; last: string | null } | null = null
const S: Record<string, string> = {}
const M: Record<string, string> = {}
const I: Record<string, string> = {}
const projects: string[] = []

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(text, params)).rows as T[]
}
const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await sql<T>(text, params))[0]
const iso = (offset: number) => new Date(Date.now() + offset).toISOString()

async function section(code: string, institution: string, course: string, professor: string, settings: unknown = {}) {
  return (
    await one<{ id: string }>(
      `insert into public.course_sections (institution_id, course_id, section_code, semester, year, professor_id, settings)
       values ($1, $2, $3, 'Fall', 2026, $4, $5) returning id`,
      [institution, course, `${code}-${tag}`, professor, JSON.stringify(settings)],
    )
  ).id
}
async function moduleRow(sectionId: string, o: { title: string; week?: number; published?: boolean; unlock?: string | null; system?: string | null; note?: string; position?: number }) {
  return (
    await one<{ id: string }>(
      `insert into public.modules (section_id, title, description, instructor_note, position, is_published, unlock_date, week_number, system_kind)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [sectionId, o.title, `About ${o.title}`, o.note ?? '', o.position ?? 0, o.published ?? true, o.unlock ?? null, o.week ?? null, o.system ?? null],
    )
  ).id
}
async function item(moduleId: string, o: { title: string; type?: string; visible?: boolean; pages?: string[]; note?: string; position?: number }) {
  const content = { extraction: { status: 'completed', pages: (o.pages ?? []).map((text, i) => ({ pageNumber: i + 1, text, headings: [`${o.title} part ${i + 1}`] })) } }
  return (
    await one<{ id: string }>(
      `insert into public.module_items (module_id, title, item_type, description, instructor_note, content, position, is_visible)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [moduleId, o.title, o.type ?? 'lecture', '', o.note ?? '', JSON.stringify(content), o.position ?? 0, o.visible ?? true],
    )
  ).id
}
const item_ = (m: string) => item(m, { title: 'Neighbour lecture', pages: ['Secret neighbour lecture text about transformer internals for another class.'] })
async function assignment(sectionId: string, title: string, status: string, scheduledAt: string | null = null) {
  return (
    await one<{ id: string }>(
      `insert into public.assignments (section_id, institution_id, created_by, title, description, status, scheduled_publish_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [sectionId, A.institution, PROFESSOR, title, `${title}: write about transformers`, status, scheduledAt],
    )
  ).id
}

type UnitRow = { unit_key: string; source_kind: string; disclosure: string; title: string; body: string; module_id: string | null }
const units = (sectionId: string, institution = A.institution) =>
  sql<UnitRow>('select * from public.studio_course_units($1, $2, now(), null)', [institution, sectionId])
type SearchRow = { unit_key: string | null; module_id: string | null; disclosure: string | null; excerpt: string | null; title: string | null; withheld_matches: number | null }
const search = (sectionId: string, query: string, focus: string[] = [], institution = A.institution) =>
  sql<SearchRow>('select * from public.studio_course_search($1, $2, now(), $3, $4::uuid[], 6)', [institution, sectionId, query, focus])

const W6_P2 = 'The transformer architecture stacks identical encoder layers, each with a feed forward block and residual connections around it.'

beforeAll(async () => {
  const env = dbEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey
  db = new Client({ connectionString: env.pgUrl })
  await db.connect()
  restoreEntitlement = await grantStudio(db, A.institution)
  // A student the professor teaches, with a full name for the redaction checks.
  const p = await one<{ first_name: string | null; last_name: string | null }>('select first_name, last_name from public.profiles where id = $1', [STUDENT])
  restoreStudent = { first: p.first_name, last: p.last_name }
  await sql("update public.profiles set first_name = 'Ada', last_name = 'Quillfeather' where id = $1", [STUDENT])

  S.main = await section('CTX', A.institution, A.course, PROFESSOR, {
    about: { version: 2, blocks: [{ id: 'b1', type: 'syllabus', data: { title: 'Schedule', weeks: [{ id: 'w', week: 6, topic: 'Transformers', description: 'Attention is all you need', readings: 'Vaswani 2017' }] } }] },
  })
  S.other = await section('CTX2', A.institution, A.course, PROFESSOR, { about: { version: 2, blocks: [{ id: 'b', type: 'syllabus', data: { title: 'TBA', tba: true, weeks: [{ id: 'x', week: 1, topic: 'Transformers secret plan', description: '', readings: '' }] } }] } })
  S.foreign = await section('CTXB', B.institution, B.course, B.users.professor.id)

  M.w5 = await moduleRow(S.main, { title: 'Recurrent networks', week: 5, unlock: iso(-10 * DAY), position: 5 })
  M.w6 = await moduleRow(S.main, { title: 'Attention', week: 6, unlock: iso(DAY), position: 6, note: 'INSTRUCTOR-ONLY transformer note' })
  M.w7 = await moduleRow(S.main, { title: 'Exam preparation', week: 7, published: false, position: 7 })
  M.quiz = await moduleRow(S.main, { title: 'Quiz Uploads', system: 'quiz_uploads', position: 90 })
  M.room = await moduleRow(S.main, { title: 'Classroom Uploads', system: 'classroom_uploads', position: 91 })

  // Week 5 is open, with several weak matches; week 6 opens tomorrow and is the real topic.
  I.w5 = await item(M.w5, {
    title: 'RNN lecture',
    pages: ['Recurrent networks keep a hidden state. Attention appears later in the course.', 'Gradients vanish over long sequences; attention is one fix.', 'Group work led by Ada Quillfeather on transformers and attention.'],
  })
  I.w6 = await item(M.w6, { title: 'Attention and Transformers', pages: ['Self attention lets each token weigh every other token.', W6_P2], note: 'INSTRUCTOR-ONLY transformer hint' })
  I.hidden = await item(M.w5, { title: 'HW3 solutions', visible: false, pages: ['Transformer homework answer key: 42.'] })
  I.unpublished = await item(M.w7, { title: 'Midterm solutions', pages: ['Transformer midterm solutions and answer key.'] })
  I.quiz = await item(M.quiz, { title: 'Quiz source', pages: ['Transformer quiz answers live here.'] })
  I.deck = await item(M.room, { title: 'Thursday deck', visible: false, pages: ['Transformer slides for Thursday class.'] })
  I.foreign = await item(await moduleRow(S.foreign, { title: 'Foreign week', week: 6 }), { title: 'Foreign transformers', pages: ['Transformer material from another institution.'] })
  I.other = await item(await moduleRow(S.other, { title: 'Other section week', week: 6 }), { title: 'Other transformers', pages: ['Transformer material from the professor’s other section.'] })

  I.aDraft = await assignment(S.main, 'Draft transformer essay', 'draft')
  I.aScheduled = await assignment(S.main, 'Transformer project', 'scheduled', iso(3 * DAY))
  I.aPublished = await assignment(S.main, 'Attention reading response', 'published')
})

afterAll(async () => {
  if (!db) return
  // This suite's builds count toward the fixture professor's daily cap: remove them.
  for (const p of projects) {
    await sql('delete from public.studio_plugin_builder_runs where project_id = $1', [p])
    await sql('update public.studio_plugin_projects set draft_head_hash = null, draft_undo_hash = null where id = $1', [p])
    await sql('delete from public.studio_plugin_versions where project_id = $1', [p])
    await sql('delete from public.studio_plugin_projects where id = $1', [p])
  }
  await sql("delete from public.background_jobs where type = 'studio_builder_slice' and institution_id = $1", [A.institution])
  await sql('delete from public.course_sections where id = any($1::uuid[])', [Object.values(S)])
  if (restoreStudent) await sql('update public.profiles set first_name = $2, last_name = $3 where id = $1', [STUDENT, restoreStudent.first, restoreStudent.last])
  await restoreEntitlement?.()
  await db.end()
})

describe('studio_course_units: the one eligibility function', () => {
  it('classes every allowed source and leaves out everything else', async () => {
    const rows = await units(S.main)
    const classOf = (prefix: string) => [...new Set(rows.filter((r) => r.unit_key.startsWith(prefix)).map((r) => r.disclosure))]
    expect(classOf(`p:${I.w5}:`)).toEqual(['released'])
    expect(classOf(`p:${I.w6}:`)).toEqual(['scheduled'])
    expect(classOf(`p:${I.hidden}:`)).toEqual(['withheld'])
    expect(classOf(`p:${I.unpublished}:`)).toEqual(['withheld'])
    // A live-classroom deck waiting for class can be read; Quiz Uploads never.
    expect(classOf(`p:${I.deck}:`)).toEqual(['scheduled'])
    expect(rows.some((r) => r.unit_key.includes(I.quiz))).toBe(false)
    expect(rows.find((r) => r.unit_key === `m:${M.w7}`)?.disclosure).toBe('withheld')
    expect(rows.some((r) => r.unit_key === `m:${M.quiz}`)).toBe(false)
    expect(rows.find((r) => r.unit_key === `a:${I.aDraft}`)?.disclosure).toBe('withheld')
    expect(rows.find((r) => r.unit_key === `a:${I.aScheduled}`)?.disclosure).toBe('scheduled')
    expect(rows.find((r) => r.unit_key === `a:${I.aPublished}`)?.disclosure).toBe('released')
    expect(rows.find((r) => r.source_kind === 'syllabus')).toMatchObject({ disclosure: 'released', title: 'Week 6: Transformers' })
    // Instructor notes never become text.
    expect(rows.some((r) => (r.body ?? '').includes('INSTRUCTOR-ONLY') || (r.title ?? '').includes('INSTRUCTOR-ONLY'))).toBe(false)
    // A syllabus marked tba is withheld.
    expect((await units(S.other)).find((r) => r.source_kind === 'syllabus')?.disclosure).toBe('withheld')
  })

  it('returns nothing for a section of another institution, or a section paired with the wrong institution', async () => {
    expect(await units(S.foreign, A.institution)).toEqual([])
    expect(await units(S.main, B.institution)).toEqual([])
  })
})

describe('studio_course_search', () => {
  it('finds this week’s transformers lecture, including a page with only one of the keywords', async () => {
    const rows = (await search(S.main, 'transformers attention', [M.w6])).filter((r) => r.unit_key)
    expect(rows[0].module_id).toBe(M.w6)
    expect(rows.map((r) => r.unit_key)).toContain(`p:${I.w6}:2`)
    // Released and scheduled only, never withheld or out-of-allowlist sources.
    expect(rows.every((r) => r.disclosure === 'released' || r.disclosure === 'scheduled')).toBe(true)
    for (const id of [I.hidden, I.unpublished, I.quiz, I.foreign, I.other]) expect(rows.some((r) => r.unit_key!.includes(id))).toBe(false)
  })

  it('a focus boosts its week without burying a strong title match elsewhere', async () => {
    // Focus on week 5 (it opened 10 days ago): week 6's title still wins on relevance.
    const rows = (await search(S.main, 'attention', [M.w5])).filter((r) => r.unit_key)
    expect(rows[0].unit_key!.startsWith(`p:${I.w6}:`) || rows[0].unit_key === `m:${M.w6}`).toBe(true)
  })

  it('counts withheld matches without showing them, and returns match-centred excerpts with no markup', async () => {
    const rows = await search(S.main, 'solutions answer key')
    const counter = rows.find((r) => r.unit_key === null)!
    expect(counter.withheld_matches).toBe(2)
    expect(rows.filter((r) => r.unit_key)).toEqual([])
    const hit = (await search(S.main, 'encoder residual')).find((r) => r.unit_key === `p:${I.w6}:2`)!
    expect(hit.excerpt).toContain('encoder layers')
    expect(hit.excerpt).not.toContain('<b>')
  })

  it('a query of only stop words or quotes searches nothing', async () => {
    expect((await search(S.main, "the and of ' \\")).filter((r) => r.unit_key)).toEqual([])
  })

  it('stays in its section and institution', async () => {
    expect((await search(S.other, 'transformer')).filter((r) => r.unit_key).every((r) => r.unit_key!.includes(I.other))).toBe(true)
    expect((await search(S.main, 'transformer', [], B.institution)).filter((r) => r.unit_key)).toEqual([])
    expect((await search(S.foreign, 'transformer', [], A.institution)).filter((r) => r.unit_key)).toEqual([])
  })
})

describe('re-read and sources', () => {
  it('the re-read returns released and scheduled keys only; the guard’s read returns every class with text', async () => {
    const keys = [`p:${I.w6}:2`, `p:${I.hidden}:1`, `p:${I.w5}:1`, 'garbage', `p:${I.foreign}:1`]
    const excerpts = await sql<{ unit_key: string }>('select unit_key from public.studio_course_excerpts($1, $2, now(), $3, $4)', [A.institution, S.main, 'encoder', keys])
    expect(excerpts.map((r) => r.unit_key).sort()).toEqual([`p:${I.w5}:1`, `p:${I.w6}:2`].sort())
    const sources = await sql<{ unit_key: string; disclosure: string; body: string }>('select unit_key, disclosure, body from public.studio_course_sources($1, $2, now(), $3)', [A.institution, S.main, keys])
    expect(sources.find((r) => r.unit_key === `p:${I.hidden}:1`)).toMatchObject({ disclosure: 'withheld', body: 'Transformer homework answer key: 42.' })
    expect(sources.some((r) => r.unit_key.includes(I.foreign))).toBe(false)
  })
})

describe('provenance', () => {
  it('the union keeps unit-shaped keys only, stamps the build section, newest last', async () => {
    const r = await one<{ v: { k: string; s: string }[] }>('select public.studio_material_union($1::jsonb, $2::jsonb, $3) as v', [
      JSON.stringify([{ k: `m:${M.w6}`, s: S.main }]),
      JSON.stringify([`p:${I.w6}:1`, 'not-a-key', 42, `m:${M.w6}`]),
      S.main,
    ])
    expect(r.v).toEqual([{ k: `p:${I.w6}:1`, s: S.main }, { k: `m:${M.w6}`, s: S.main }])
    const none = await one<{ v: unknown[] }>('select public.studio_material_union($1::jsonb, $2::jsonb, null) as v', ['[]', JSON.stringify([`m:${M.w6}`])])
    expect(none.v).toEqual([])
  })

  it('pruning keeps only sources students still can’t see, newest last, and flags a list cut for the cap', async () => {
    const entries = [
      { k: `p:${I.w5}:1`, s: S.main }, // released: dropped
      { k: `p:${I.w6}:1`, s: S.main }, // scheduled: kept
      { k: `p:${I.hidden}:1`, s: S.main }, // withheld: kept
      { k: `p:${randomUUID()}:1`, s: S.main }, // gone: dropped
      { k: `m:${M.w6}`, s: S.main }, // scheduled: kept
    ]
    const all = await one<{ v: { entries: { k: string }[]; incomplete: boolean } }>('select public.studio_material_prune($1, $2::jsonb, 96) as v', [A.institution, JSON.stringify(entries)])
    expect(all.v.entries.map((e) => e.k)).toEqual([`p:${I.w6}:1`, `p:${I.hidden}:1`, `m:${M.w6}`])
    expect(all.v.incomplete).toBe(false)
    const capped = await one<{ v: { entries: { k: string }[]; incomplete: boolean } }>('select public.studio_material_prune($1, $2::jsonb, 2) as v', [A.institution, JSON.stringify(entries)])
    expect(capped.v.entries.map((e) => e.k)).toEqual([`p:${I.hidden}:1`, `m:${M.w6}`])
    expect(capped.v.incomplete).toBe(true)
    // Another institution's entries resolve to nothing and are dropped.
    const foreign = await one<{ v: { entries: unknown[] } }>('select public.studio_material_prune($1, $2::jsonb, 96) as v', [B.institution, JSON.stringify(entries)])
    expect(foreign.v.entries).toEqual([])
  })

  it('the provenance columns hold the full cap of 96 longest entries', async () => {
    const entries = Array.from({ length: 96 }, () => ({ k: `p:${randomUUID()}:9999`, s: randomUUID() }))
    const project = await one<{ id: string }>(
      `insert into public.studio_plugin_projects (institution_id, owner_id, slug, name, material_sources)
       values ($1, $2, $3, 'Cap check', $4::jsonb) returning id`,
      [A.institution, PROFESSOR, `cap-${randomBytes(4).toString('hex')}`, JSON.stringify(entries)],
    )
    projects.push(project.id)
    const stored = await one<{ n: number; bytes: number }>(
      'select jsonb_array_length(material_sources) as n, octet_length(material_sources::text) as bytes from public.studio_plugin_projects where id = $1',
      [project.id],
    )
    expect(stored.n).toBe(96)
    expect(stored.bytes).toBeGreaterThan(8192)
  })

  it('no client role can call the course-material functions', async () => {
    for (const fn of ['studio_material_prune(uuid,jsonb,integer)', 'studio_course_units(uuid,uuid,timestamptz,uuid[])', 'studio_course_search(uuid,uuid,timestamptz,text,uuid[],integer)', 'studio_course_excerpts(uuid,uuid,timestamptz,text,text[])', 'studio_course_sources(uuid,uuid,timestamptz,text[])', 'studio_material_union(jsonb,jsonb,uuid)']) {
      for (const role of ['anon', 'authenticated']) {
        const r = await one<{ ok: boolean }>(`select has_function_privilege($1, 'public.${fn}', 'execute') as ok`, [role])
        expect(r.ok, `${role} ${fn}`).toBe(false)
      }
    }
  })
})

describe('the retriever', () => {
  it('redacts a student’s name from excerpts and labels, and resolves a focus', async () => {
    const scope = retrievalScope({ institutionId: A.institution, sectionId: S.main, ownerId: PROFESSOR })!
    const r = await postgresRetriever.search(scope, 'group work led', 'week:5')
    if (!r.ok) throw new Error('search failed')
    const text = JSON.stringify(r.shown)
    expect(text).not.toContain('Quillfeather')
    expect(text).toContain('[student]')
    expect(r.shown[0].label).toMatch(/^Week 5: RNN lecture \(lecture\), page \d$/)
    expect(retrievalScope({ institutionId: A.institution, sectionId: null, ownerId: PROFESSOR })).toBeNull()
  })
})

describe('the copy guard’s labels', () => {
  it('compares a section the owner no longer teaches but never names its material', async () => {
    const { loadGuardSources } = await import('@/lib/studio/builder/course-retriever')
    const notMine = await section('CTXN', A.institution, A.course, A.users.admin.id)
    S.notMine = notMine
    const item = await moduleRow(notMine, { title: 'Someone else week', week: 6, unlock: iso(5 * DAY) }).then((m) => item_(m))
    const sources = await loadGuardSources(A.institution, [{ k: `p:${item}:1`, s: notMine }, { k: `p:${I.w6}:1`, s: S.main }], [], PROFESSOR)
    expect(sources).not.toBeNull()
    const theirs = sources!.find((x) => x.key.includes(item))!
    expect(theirs.label).toBe('course material from a section you no longer teach')
    expect(theirs.text).toContain('Secret neighbour lecture')
    expect(sources!.find((x) => x.key.includes(I.w6))!.label).toMatch(/^Week 6: Attention and Transformers/)
  })
})

describe('one build through the real harness, retriever and guard', () => {
  it('reads scheduled material, is refused a copy, saves a paraphrase, and the saved version carries the provenance', async () => {
    session.userId = PROFESSOR
    const request = 'Build a practice tool for next week’s lecture on transformers'
    const started = await service.startBuild({ sectionId: S.main, pluginProjectId: null, request, clientRequestId: randomUUID() })
    if (!started.ok) throw new Error(started.error)
    projects.push(started.value.pluginProjectId)
    const runId = started.value.runId
    const copied = STUDENT_VIEW.replace('>I know this<', `>${W6_P2}<`)
    const paraphrased = STUDENT_VIEW.replace('>I know this<', '>Layers repeat; each mixes tokens then transforms them<')
    const model = scriptedModel([
      { calls: [call('search_course_material', { query: 'transformers encoder', focus: 'this_week' })] },
      { calls: [plan()] },
      { calls: [proposeManifest(FLASHCARDS_MANIFEST)] },
      // After the professor approves the card.
      { calls: [write('views/student.tsx', copied), write('views/professor.tsx', PROFESSOR_VIEW), call('run_checks')] },
      { calls: [write('views/student.tsx', paraphrased), call('run_checks')] },
      { calls: [finish()] },
    ])
    const slice = async () => {
      const row = await one<{ slice_no: number; job_id: string }>('select slice_no, job_id from public.studio_plugin_builder_runs where id = $1', [runId])
      return runBuilderSlice({ runId, sliceNo: Number(row.slice_no) }, { id: String(row.job_id), deadline: Date.now() + 10 * 60_000 }, realHarnessDeps(model))
    }
    await slice()
    const waiting = await one<{ status: string; pending_approval: { proposal_id: string; delta_hash: string } }>('select status, pending_approval from public.studio_plugin_builder_runs where id = $1', [runId])
    expect(waiting.status).toBe('waiting_for_approval')
    const decided = await service.decideApproval({ sectionId: S.main, runId, proposalId: waiting.pending_approval.proposal_id, deltaHash: waiting.pending_approval.delta_hash, approve: true })
    expect(decided.ok).toBe(true)
    await slice()

    // The excerpt reached the model labelled as not visible yet, with no id.
    const shownPrompt = model.prompts[1].prompt
    expect(shownPrompt).toContain('Week 6: Attention and Transformers (lecture), page 2 (not visible to students yet, opens')
    expect(shownPrompt).toContain('encoder layers')
    for (const id of [I.w6, M.w6, S.main, A.institution]) expect(shownPrompt).not.toContain(id)

    // The copy was refused by the real guard, by label; the paraphrase passed and committed.
    const checks = await sql<{ result_summary: { passed: boolean; failing: Record<string, number> } }>(
      "select result_summary from public.studio_plugin_builder_steps where run_id = $1 and tool = 'run_checks' order by seq",
      [runId],
    )
    expect(checks.map((c) => c.result_summary.passed)).toEqual([false, true])
    expect(Object.keys(checks[0].result_summary.failing)).toContain('builder.disclosure|views/student.tsx')
    const run = await one<{ status: string; result: { material_read: { label: string; visible: boolean }[] } }>('select status, result from public.studio_plugin_builder_runs where id = $1', [runId])
    expect(run.status).toBe('preview_ready')
    expect(run.result.material_read.some((m) => m.label.startsWith('Week 6: Attention and Transformers') && m.visible === false)).toBe(true)
    // No course text in the trajectory.
    const steps = JSON.stringify(await sql('select args_summary, result_summary from public.studio_plugin_builder_steps where run_id = $1', [runId]))
    expect(steps).not.toContain('encoder layers')

    // The project's provenance holds the scheduled keys, stamped with the build section.
    const project = await studioDb.loadBuilderProject(started.value.pluginProjectId)
    expect(project!.materialSources.length).toBeGreaterThan(0)
    expect(project!.materialSources.every((e) => e.s === S.main)).toBe(true)
    expect(project!.materialSources.some((e) => e.k.startsWith(`p:${I.w6}:`))).toBe(true)
    // Only scheduled sources are recorded: nothing students can already see.
    expect(project!.materialSources.some((e) => e.k.includes(I.w5) || e.k.includes(I.aPublished))).toBe(false)

    // Save as version: the guard runs again, and the version keeps the same provenance.
    const saved = await service.saveDraftAsVersion({ sectionId: S.main, pluginProjectId: started.value.pluginProjectId, snapshotHash: project!.draftHeadHash! })
    if (!saved.ok) throw new Error(saved.error)
    const version = await one<{ material_sources: unknown }>('select material_sources from public.studio_plugin_versions where id = $1', [saved.value.versionId])
    expect(version.material_sources).toEqual(project!.materialSources)
    session.userId = null
  }, 90_000)
})
