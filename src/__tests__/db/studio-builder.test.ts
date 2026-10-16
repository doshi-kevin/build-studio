/**
 * Step 7B against a real database (`npm run test:db`): the builder's tables and every
 * database function, then one whole build through the real harness, the real check
 * worker and db.ts, with only the model scripted.
 *
 * Mocked, and only these: the session cookie, logEvent, revalidatePath, the job kick,
 * and the Stage 1 purpose classifier at Save (no model is called).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dbEnv } from './env'
import { FIXTURE } from './fixture'
import { grantStudio } from './studio-entitlement'
import {
  call,
  finish,
  plan,
  PROFESSOR_VIEW,
  proposeManifest,
  scriptedModel,
  STUDENT_VIEW,
  write,
} from '../helpers/builder-fixtures'

const session: { userId: string | null } = { userId: null }
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null } }) } }),
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/jobs/enqueue', () => ({ kickWorker: vi.fn(async () => ({ kicked: true })) }))
vi.mock('@/lib/studio/validator/purpose-ai', () => ({
  createPurposeClassifier: () => async (input: { category: string }) => ({ ok: true, model: 'test', result: { verdict: 'educational', category: input.category, confidence: 0.99, reasons: [] } }),
}))

const { runBuilderSlice, realHarnessDeps } = await import('@/lib/studio/builder/harness')
const service = await import('@/lib/studio/builder/service')
const { publishDraft } = await import('@/lib/studio/lifecycle')
const studioDb = await import('@/lib/studio/db')

const A = FIXTURE.a
const PROFESSOR = A.users.professor.id
const TA = A.users.ta.id
const tag = `b${randomBytes(4).toString('hex')}`
const CAPS = { tool_calls: 48, writes: 30, bytes_written: 262144, check_runs: 6, repair_rounds: 3, questions: 2 }

let db: Client
let restoreEntitlement: (() => Promise<void>) | undefined
let section = ''
const projects: string[] = []

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(text, params)).rows as T[]
}
const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await sql<T>(text, params))[0]
const rpc = async (fn: string, args: unknown[]) => {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ')
  // node-postgres sends a JS array as a Postgres array literal; every array these functions take is jsonb.
  const params = args.map((a) => (Array.isArray(a) ? JSON.stringify(a) : a))
  return (await one<{ r: Record<string, unknown> }>(`select public.${fn}(${placeholders}) as r`, params)).r
}

async function start(project: string | null, opts: { owner?: string; replace?: string | null; crid?: string; maxDaily?: number; maxLive?: number; maxCost?: number } = {}) {
  const r = await rpc('studio_builder_start', [
    opts.owner ?? PROFESSOR, A.institution, section, project, `tool-${randomBytes(4).toString('hex')}`, 'Untitled tool', 'Build flashcards',
    opts.crid ?? randomUUID(), opts.replace ?? null, opts.maxDaily ?? 100, opts.maxLive ?? 100, opts.maxCost ?? 1000,
  ])
  if (typeof r.project_id === 'string' && !projects.includes(r.project_id)) projects.push(r.project_id)
  return r
}
async function claim(runId: string, slice = 1) {
  const job = await one<{ id: string }>('select id from public.background_jobs where id = (select job_id from public.studio_plugin_builder_runs where id = $1)', [runId])
  const r = await rpc('studio_builder_claim', [runId, job?.id ?? randomUUID(), slice, 60000, 2])
  return r.token as string | null
}
const runRow = (id: string) => one<Record<string, unknown>>('select * from public.studio_plugin_builder_runs where id = $1', [id])
const step = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'tool', tool: 'read_file', tool_call_id: id, status: 'done', label: 'file.read', ...extra })
const snapshot = (hash: string) => ({ hash, compiler: 'studio-tsx-v1+test', manifest: { id: 'x' }, files: { 'views/student.tsx': 's', 'views/professor.tsx': 'p' }, student_bundle: 's', professor_bundle: 'p', check_summary: { passed: true } })
const work = (rev: number, manifest: unknown = null) => ({ work_rev: rev, manifest, files: {}, working_set: [], changed: [], kit_refs: [], last_check: null, streaks: {}, delta: { approved: [], declined: [], direct: [] } })

beforeAll(async () => {
  const env = dbEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey
  db = new Client({ connectionString: env.pgUrl })
  await db.connect()
  restoreEntitlement = await grantStudio(db, A.institution)
  const [{ id }] = await sql<{ id: string }>(
    `insert into public.course_sections (institution_id, course_id, section_code, semester, year, professor_id)
     values ($1, $2, $3, 'Fall', 2026, $4) returning id`,
    [A.institution, A.course, `BLD-${tag}`, PROFESSOR],
  )
  section = id
})

afterAll(async () => {
  if (!db) return
  await restoreEntitlement?.()
  for (const p of projects) {
    await sql('update public.studio_plugin_projects set draft_head_hash = null, draft_undo_hash = null where id = $1', [p])
    await sql('delete from public.studio_plugin_versions where project_id = $1', [p])
    await sql('delete from public.studio_plugin_projects where id = $1', [p])
  }
  await sql("delete from public.background_jobs where type = 'studio_builder_slice' and institution_id = $1", [A.institution])
  await sql('delete from public.course_sections where id = $1', [section])
  await db.end()
})

describe('server-only tables', () => {
  it.each(['studio_plugin_snapshots', 'studio_plugin_builder_runs', 'studio_plugin_builder_steps', 'studio_plugin_builder_spend'])('%s: RLS on, and no client role holds any privilege', async (table) => {
    const r = await one<{ rls: boolean }>('select relrowsecurity as rls from pg_class where relname = $1', [table])
    expect(r.rls).toBe(true)
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['select', 'insert', 'update', 'delete']) {
        expect((await one<{ ok: boolean }>(`select has_table_privilege($1, $2, $3) as ok`, [role, `public.${table}`, priv])).ok).toBe(false)
      }
    }
  })
  it('no client role may call a builder function', async () => {
    const fns = await sql<{ oid: string; proname: string }>("select oid::regprocedure::text as oid, proname from pg_proc where proname like 'studio_builder_%' or proname = 'studio_snapshots_guard'")
    expect(fns.length).toBeGreaterThanOrEqual(23)
    for (const f of fns) {
      for (const role of ['anon', 'authenticated']) {
        expect((await one<{ ok: boolean }>('select has_function_privilege($1, $2, $3) as ok', [role, f.oid, 'execute'])).ok).toBe(false)
      }
    }
  })
})

describe('starting builds', () => {
  it('creates the project, the run and a slice job that carries ids only and no section', async () => {
    const s = await start(null)
    expect(s.outcome).toBe('started')
    const job = await one<{ params: Record<string, unknown>; section_id: string | null; type: string }>('select params, section_id, type from public.background_jobs where id = $1', [s.job_id])
    expect(job).toEqual({ params: { runId: s.run_id, sliceNo: 1 }, section_id: null, type: 'studio_builder_slice' })
    expect((await runRow(String(s.run_id))).status).toBe('queued')
  })
  it('one active run per project: a second request is busy', async () => {
    const s = await start(null)
    expect((await start(String(s.project_id))).outcome).toBe('busy')
  })
  it('refuses a project someone else in the school owns, and creates nothing', async () => {
    const s = await start(null)
    await rpc('studio_builder_stop', [s.run_id, PROFESSOR, 60000])
    const runs = async () => (await sql('select id from public.studio_plugin_builder_runs where project_id = $1', [s.project_id])).length
    expect(await runs()).toBe(1)
    expect(await start(String(s.project_id), { owner: A.users.admin.id })).toEqual({ outcome: 'not_found' })
    expect(await runs()).toBe(1)
  })
  it('the same client request id returns the same run', async () => {
    const crid = randomUUID()
    const a = await start(null, { crid })
    const b = await start(null, { crid })
    expect(b).toMatchObject({ outcome: 'existing', run_id: a.run_id })
  })
  it('enforces the professor’s daily runs, the school’s live runs and its daily spend', async () => {
    const used = Number((await one<{ n: string }>("select count(*) as n from public.studio_plugin_builder_runs where owner_id = $1 and created_at > now() - interval '24 hours'", [PROFESSOR])).n)
    expect((await start(null, { maxDaily: used })).outcome).toBe('limit_daily_runs')
    const live = Number((await one<{ n: string }>("select count(*) as n from public.studio_plugin_builder_runs where institution_id = $1 and status in ('queued','running')", [A.institution])).n)
    expect((await start(null, { maxLive: live })).outcome).toBe('limit_live_runs')
    expect((await start(null, { maxCost: 0 })).outcome).toBe('limit_daily_cost')
  })
  it('a run waiting for the professor is never replaced silently, only on explicit confirmation', async () => {
    const s = await start(null)
    const token = await claim(String(s.run_id))
    await rpc('studio_builder_apply', [s.run_id, token, { kind: 'system', tool_call_id: 'sys:work', status: 'done', label: 'run.slice' }, -1, work(0), null, null, {}, CAPS, 0])
    const p = await rpc('studio_builder_pause', [s.run_id, token, step('1.0', { tool: 'ask_professor', label: 'question.asked' }), [], null, { id: randomUUID(), question: 'Which week?', answer: null }, {}, CAPS, 60000, 0])
    expect(p.ok).toBe(true)
    const waiting = await start(String(s.project_id))
    expect(waiting).toMatchObject({ outcome: 'waiting', run_id: s.run_id, status: 'waiting_for_professor' })
    const replaced = await start(String(s.project_id), { replace: String(s.run_id) })
    expect(replaced.outcome).toBe('started')
    const old = await runRow(String(s.run_id))
    expect(old).toMatchObject({ status: 'cancelled', error_code: 'superseded', work: null })
    // The audit trail stays.
    expect(Number((await one<{ n: string }>('select count(*) as n from public.studio_plugin_builder_steps where run_id = $1', [s.run_id])).n)).toBeGreaterThanOrEqual(3)
  })
})

describe('the fence', () => {
  it('only the current slice may claim, and a re-claim fences out the old holder', async () => {
    const s = await start(null)
    const runId = String(s.run_id)
    expect(await claim(runId, 2)).toBeNull()
    const first = await claim(runId)
    expect(first).toBeTruthy()
    expect(await claim(runId)).toBeNull()
    // The first holder goes silent; its heartbeat goes stale.
    await sql("update public.studio_plugin_builder_runs set heartbeat_at = now() - interval '5 minutes' where id = $1", [runId])
    const second = await claim(runId)
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
    expect(await rpc('studio_builder_apply', [runId, first, step('1.0'), -1, work(0), null, null, {}, CAPS, 0])).toEqual({ ok: false, reason: 'fence' })
    expect((await rpc('studio_builder_heartbeat', [runId, first])).fence_lost).toBe(true)
    expect((await rpc('studio_builder_apply', [runId, second, step('1.0'), -1, work(0), null, null, { tool_calls: 1 }, CAPS, 0])).ok).toBe(true)
  })
  it('a run re-claimed past its resume limit fails as interrupted', async () => {
    const s = await start(null)
    const runId = String(s.run_id)
    await claim(runId)
    for (let i = 0; i < 2; i++) {
      await sql("update public.studio_plugin_builder_runs set heartbeat_at = now() - interval '5 minutes' where id = $1", [runId])
      expect(await claim(runId)).toBeTruthy()
    }
    await sql("update public.studio_plugin_builder_runs set heartbeat_at = now() - interval '5 minutes' where id = $1", [runId])
    expect(await claim(runId)).toBeNull()
    expect(await runRow(runId)).toMatchObject({ status: 'failed', error_code: 'interrupted' })
  })
  it('a replayed step applies nothing; a stale working copy and an exceeded cap are refused in the transaction', async () => {
    const s = await start(null)
    const runId = String(s.run_id)
    const token = await claim(runId)
    await rpc('studio_builder_apply', [runId, token, { kind: 'system', tool_call_id: 'sys:work', status: 'done', label: 'run.slice' }, -1, work(0), null, null, {}, CAPS, 0])
    expect((await rpc('studio_builder_apply', [runId, token, step('1.0'), 0, work(1), null, 'editing', { tool_calls: 1, writes: 1, bytes_written: 10 }, CAPS, 0])).ok).toBe(true)
    expect(await rpc('studio_builder_apply', [runId, token, step('1.0'), 1, work(2), null, null, { tool_calls: 1, writes: 1 }, CAPS, 0])).toMatchObject({ ok: true, duplicate: true })
    expect(await rpc('studio_builder_apply', [runId, token, step('1.1'), 0, work(2), null, null, {}, CAPS, 0])).toEqual({ ok: false, reason: 'stale_work' })
    expect(await rpc('studio_builder_apply', [runId, token, step('1.2'), 1, null, null, null, { writes: 30 }, CAPS, 0])).toEqual({ ok: false, reason: 'limit_writes' })
    expect(await rpc('studio_builder_apply', [runId, token, step('1.3'), 1, null, null, null, { bytes_written: CAPS.bytes_written }, CAPS, 0])).toEqual({ ok: false, reason: 'limit_bytes' })
    const r = await runRow(runId)
    expect(r).toMatchObject({ writes: 1, tool_calls: 1, bytes_written: 10 })
  })
})

describe('approval cards', () => {
  async function paused() {
    const s = await start(null)
    const runId = String(s.run_id)
    const token = await claim(runId)
    await rpc('studio_builder_apply', [runId, token, { kind: 'system', tool_call_id: 'sys:work', status: 'done', label: 'run.slice' }, -1, work(0), null, null, {}, CAPS, 0])
    const card = { proposal_id: randomUUID(), tool_call_id: '1.0', work_rev: 0, proposed_manifest: { name: 'x' }, items: [{ kind: 'collection_added', line: 'Store "cards"' }], direct: [], delta_hash: 'd'.repeat(64) }
    expect((await rpc('studio_builder_pause', [runId, token, step('1.0', { tool: 'propose_manifest_change', label: 'approval.waiting' }), [step('1.1', { status: 'interrupted', label: 'step.interrupted' })], card, null, { writes: 1, bytes_written: 5 }, CAPS, 60000, 0])).ok).toBe(true)
    return { runId, card, token }
  }
  it('an approval applies exactly the stored proposal, once', async () => {
    const { runId, card } = await paused()
    expect((await rpc('studio_builder_decide', [runId, PROFESSOR, randomUUID(), card.delta_hash, true, 100])).outcome).toBe('gone')
    expect((await rpc('studio_builder_decide', [runId, PROFESSOR, card.proposal_id, 'e'.repeat(64), true, 100])).outcome).toBe('gone')
    expect((await rpc('studio_builder_decide', [runId, TA, card.proposal_id, card.delta_hash, true, 100])).outcome).toBe('gone')
    expect((await rpc('studio_builder_decide', [runId, PROFESSOR, card.proposal_id, card.delta_hash, true, 100])).outcome).toBe('decided')
    expect((await rpc('studio_builder_decide', [runId, PROFESSOR, card.proposal_id, card.delta_hash, true, 100])).outcome).toBe('gone')
    const r = await runRow(runId)
    expect(r.status).toBe('queued')
    expect((r.work as Record<string, unknown>).manifest).toEqual({ name: 'x' })
    expect((r.work as { work_rev: number }).work_rev).toBe(1)
    expect((r.work as { delta: { approved: unknown[] } }).delta.approved).toEqual(card.items)
  })
  it('a decline leaves the working copy’s manifest alone', async () => {
    const { runId, card } = await paused()
    expect((await rpc('studio_builder_decide', [runId, PROFESSOR, card.proposal_id, card.delta_hash, false, 100])).outcome).toBe('decided')
    expect(((await runRow(runId)).work as Record<string, unknown>).manifest).toBeNull()
  })
  it('an expired card ends the run, and a decision waits for room under the live-run cap', async () => {
    const a = await paused()
    expect((await rpc('studio_builder_decide', [a.runId, PROFESSOR, a.card.proposal_id, a.card.delta_hash, true, 0])).outcome).toBe('busy')
    // Declining requeues the run too, so it waits for room as well.
    expect((await rpc('studio_builder_decide', [a.runId, PROFESSOR, a.card.proposal_id, a.card.delta_hash, false, 0])).outcome).toBe('busy')
    await sql("update public.studio_plugin_builder_runs set waiting_until = now() - interval '1 minute' where id = $1", [a.runId])
    expect((await rpc('studio_builder_decide', [a.runId, PROFESSOR, a.card.proposal_id, a.card.delta_hash, true, 100])).outcome).toBe('expired')
    expect(await runRow(a.runId)).toMatchObject({ status: 'cancelled', error_code: 'expired' })
  })
})

describe('committing a snapshot', () => {
  it('moves the draft pointer by compare-and-swap, and never overwrites a draft that moved', async () => {
    const s = await start(null)
    const runId = String(s.run_id)
    const token = await claim(runId)
    const h1 = randomBytes(32).toString('hex')
    expect((await rpc('studio_builder_end', [runId, token, 'preview_ready', null, { status: 'preview_ready' }, snapshot(h1), 0])).outcome).toBe('ended')
    const moved = await one<{ draft_head_hash: string; draft_rev: string }>('select draft_head_hash, draft_rev from public.studio_plugin_projects where id = $1', [s.project_id])
    expect(moved.draft_head_hash).toBe(h1)
    expect(Number(moved.draft_rev)).toBe(1)

    const s2 = await start(String(s.project_id))
    const t2 = await claim(String(s2.run_id))
    // Someone else moves the draft while this run works.
    await sql('update public.studio_plugin_projects set draft_rev = draft_rev + 1 where id = $1', [s.project_id])
    expect((await rpc('studio_builder_end', [s2.run_id, t2, 'preview_ready', null, { status: 'preview_ready' }, snapshot(randomBytes(32).toString('hex')), 0])).outcome).toBe('conflict')
    expect(await runRow(String(s2.run_id))).toMatchObject({ status: 'blocked', error_code: 'draft_changed', result_hash: null })
    expect((await one<{ h: string }>('select draft_head_hash as h from public.studio_plugin_projects where id = $1', [s.project_id])).h).toBe(h1)
  })
  it('snapshots are immutable and can’t be pointed at from another project', async () => {
    const s = await start(null)
    const token = await claim(String(s.run_id))
    const h = randomBytes(32).toString('hex')
    await rpc('studio_builder_end', [s.run_id, token, 'preview_ready', null, { status: 'preview_ready' }, snapshot(h), 0])
    await expect(sql("update public.studio_plugin_snapshots set compiler = 'x' where hash = $1", [h])).rejects.toThrow(/immutable/)
    const other = await start(null)
    await expect(sql('update public.studio_plugin_projects set draft_head_hash = $2 where id = $1', [other.project_id, h])).rejects.toThrow(/foreign key|violates/)
  })
  it('stores the sample data the build wrote, and none for a build without it (Step 11)', async () => {
    const sample = { attendance: [{ student: 0, data: { status: 'present' } }] }
    const withSample = await start(null)
    const t1 = await claim(String(withSample.run_id))
    const h1 = randomBytes(32).toString('hex')
    await rpc('studio_builder_end', [withSample.run_id, t1, 'preview_ready', null, { status: 'preview_ready' }, { ...snapshot(h1), sample_data: sample }, 0])
    const without = await start(null)
    const t2 = await claim(String(without.run_id))
    const h2 = randomBytes(32).toString('hex')
    await rpc('studio_builder_end', [without.run_id, t2, 'preview_ready', null, { status: 'preview_ready' }, snapshot(h2), 0])

    const rows = await sql<{ hash: string; sample_data: unknown }>('select hash, sample_data from public.studio_plugin_snapshots where hash = any($1)', [[h1, h2]])
    expect(Object.fromEntries(rows.map((r) => [r.hash, r.sample_data]))).toEqual({ [h1]: sample, [h2]: null })
    expect((await studioDb.loadSnapshot(String(withSample.project_id), h1))?.sampleData).toEqual(sample)
  })

  it('refuses sample data that isn’t an object, and keeps the run where it was', async () => {
    const s = await start(null)
    const token = await claim(String(s.run_id))
    const h = randomBytes(32).toString('hex')
    await expect(
      rpc('studio_builder_end', [s.run_id, token, 'preview_ready', null, { status: 'preview_ready' }, { ...snapshot(h), sample_data: [1, 2] }, 0]),
    ).rejects.toThrow(/sample_data/)
    expect(await runRow(String(s.run_id))).toMatchObject({ status: 'running' })
  })

  it('a run can be reviewing or improving, and nothing else new (Step 11)', async () => {
    const s = await start(null)
    await claim(String(s.run_id))
    for (const phase of ['reviewing', 'improving']) {
      await sql('update public.studio_plugin_builder_runs set phase = $2 where id = $1', [s.run_id, phase])
      expect(await runRow(String(s.run_id))).toMatchObject({ phase })
    }
    await expect(sql(`update public.studio_plugin_builder_runs set phase = 'polishing' where id = $1`, [s.run_id])).rejects.toThrow(/phase_check/)
  })

  it('Stop wins over a commit that arrives after it', async () => {
    const s = await start(null)
    const token = await claim(String(s.run_id))
    expect((await rpc('studio_builder_stop', [s.run_id, PROFESSOR, 60000])).outcome).toBe('requested')
    expect((await rpc('studio_builder_end', [s.run_id, token, 'preview_ready', null, { status: 'preview_ready' }, snapshot(randomBytes(32).toString('hex')), 0])).outcome).toBe('cancelled')
    expect((await one<{ h: string | null }>('select draft_head_hash as h from public.studio_plugin_projects where id = $1', [s.project_id])).h).toBeNull()
  })
})

describe('one-step undo', () => {
  const project = (id: unknown) =>
    one<{ head: string | null; undo: string | null; rev: string; status: string }>(
      'select draft_head_hash as head, draft_undo_hash as undo, draft_rev as rev, status from public.studio_plugin_projects where id = $1',
      [id],
    )
  const undo = (p: unknown, actor: string, head: string | null, rev: number) => rpc('studio_builder_undo', [p, actor, head, rev])
  /** One successful build of `p` (null: a new project) that commits `h` through studio_builder_end. */
  async function commit(p: string | null, h: string, result: Record<string, unknown> = { status: 'preview_ready' }) {
    const s = await start(p)
    expect(s.outcome).toBe('started')
    const token = await claim(String(s.run_id))
    expect((await rpc('studio_builder_end', [s.run_id, token, 'preview_ready', null, result, snapshot(h), 0])).outcome).toBe('ended')
    return { projectId: String(s.project_id), runId: String(s.run_id) }
  }
  async function twoBuilds() {
    const [a, b] = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
    const { projectId } = await commit(null, a)
    await commit(projectId, b)
    return { projectId, a, b }
  }

  it('a real commit sets the undo target to the head it replaced; the first build has none', async () => {
    const a = randomBytes(32).toString('hex')
    const { projectId } = await commit(null, a)
    expect(await project(projectId)).toMatchObject({ head: a, undo: null })
    expect(await undo(projectId, PROFESSOR, a, 1)).toEqual({ outcome: 'unavailable' })
    const b = randomBytes(32).toString('hex')
    await commit(projectId, b)
    expect(await project(projectId)).toMatchObject({ head: b, undo: a })
    expect(Number((await project(projectId)).rev)).toBe(2)
  })

  it('undone: the pointer goes back by compare-and-swap; nothing is deleted and no version changes', async () => {
    const { projectId, a, b } = await twoBuilds()
    const slug = (await one<{ slug: string }>('select slug from public.studio_plugin_projects where id = $1', [projectId])).slug
    await sql(
      `insert into public.studio_plugin_versions (project_id, institution_id, version, manifest, bridge_version, source, student_bundle, professor_bundle, bundle_sha256, published_by, source_snapshot_hash)
       values ($1, $2, '1.0.0', $3, 'v1', '{}', 's', 'p', $4, $5, $6)`,
      [projectId, A.institution, { id: slug, version: '1.0.0', bridgeVersion: 'v1', collections: {} }, 'f'.repeat(64), PROFESSOR, b],
    )
    expect(await undo(projectId, PROFESSOR, b, 2)).toEqual({ outcome: 'undone', head: a, rev: 3 })
    expect(await project(projectId)).toMatchObject({ head: a, undo: null })
    expect(Number((await project(projectId)).rev)).toBe(3)
    expect((await sql<{ hash: string }>('select hash from public.studio_plugin_snapshots where project_id = $1', [projectId])).map((r) => r.hash).sort()).toEqual([a, b].sort())
    expect(await sql('select version, source_snapshot_hash from public.studio_plugin_versions where project_id = $1', [projectId])).toEqual([{ version: '1.0.0', source_snapshot_hash: b }])
    // One step only.
    expect(await undo(projectId, PROFESSOR, a, 3)).toEqual({ outcome: 'unavailable' })
    // The next build starts from the draft the undo went back to.
    const next = await start(projectId)
    expect(await runRow(String(next.run_id))).toMatchObject({ base_hash: a })
    expect(Number((await runRow(String(next.run_id))).base_rev)).toBe(3)
  })

  it('draft_changed: a stale head or revision changes nothing', async () => {
    const { projectId, a, b } = await twoBuilds()
    expect(await undo(projectId, PROFESSOR, a, 2)).toEqual({ outcome: 'draft_changed' })
    expect(await undo(projectId, PROFESSOR, b, 1)).toEqual({ outcome: 'draft_changed' })
    expect(await project(projectId)).toMatchObject({ head: b, undo: a })
  })

  it('busy: never undoes behind a queued, running or waiting run', async () => {
    const { projectId, b } = await twoBuilds()
    const s = await start(projectId)
    expect(await undo(projectId, PROFESSOR, b, 2)).toEqual({ outcome: 'busy' })
    const token = await claim(String(s.run_id))
    expect(await undo(projectId, PROFESSOR, b, 2)).toEqual({ outcome: 'busy' })
    await rpc('studio_builder_apply', [s.run_id, token, { kind: 'system', tool_call_id: 'sys:work', status: 'done', label: 'run.slice' }, -1, work(0), null, null, {}, CAPS, 0])
    await rpc('studio_builder_pause', [s.run_id, token, step('1.0', { tool: 'ask_professor', label: 'question.asked' }), [], null, { id: randomUUID(), question: 'Which week?', answer: null }, {}, CAPS, 60000, 0])
    expect(await undo(projectId, PROFESSOR, b, 2)).toEqual({ outcome: 'busy' })
    await rpc('studio_builder_stop', [s.run_id, PROFESSOR, 60000])
    expect((await undo(projectId, PROFESSOR, b, 2)).outcome).toBe('undone')
  })

  it('not_owner and archived: a TA, another project id and an archived tool are refused', async () => {
    const { projectId, a, b } = await twoBuilds()
    expect(await undo(projectId, TA, b, 2)).toEqual({ outcome: 'not_owner' })
    expect(await undo(randomUUID(), PROFESSOR, b, 2)).toEqual({ outcome: 'not_owner' })
    await sql("update public.studio_plugin_projects set status = 'archived' where id = $1", [projectId])
    expect(await undo(projectId, PROFESSOR, b, 2)).toEqual({ outcome: 'archived' })
    expect(await project(projectId)).toMatchObject({ head: b, undo: a })
  })

  it('the undo target can only name one of the project’s own snapshots', async () => {
    const mine = await twoBuilds()
    const other = await twoBuilds()
    await expect(sql('update public.studio_plugin_projects set draft_undo_hash = $2 where id = $1', [mine.projectId, other.a])).rejects.toThrow(/foreign key|violates/)
    await expect(sql('update public.studio_plugin_projects set draft_undo_hash = $2 where id = $1', [mine.projectId, randomBytes(32).toString('hex')])).rejects.toThrow(/foreign key|violates/)
  })

  it('history: newest first, one row per snapshot, and no model-written text', async () => {
    const [a, b] = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
    const { projectId, runId: first } = await commit(null, a, { status: 'preview_ready', summary: 'MODEL-WRITTEN SUMMARY' })
    const { runId: second } = await commit(projectId, b, { status: 'preview_ready', summary: 'MODEL-WRITTEN SUMMARY' })
    // A run that ended without a snapshot isn't history.
    const s = await start(projectId)
    await rpc('studio_builder_stop', [s.run_id, PROFESSOR, 60000])
    const rows = await studioDb.listDraftHistory(projectId, 20)
    expect(rows?.map((r) => [r.runId, r.hash, r.request])).toEqual([[second, b, 'Build flashcards'], [first, a, 'Build flashcards']])
    expect(rows?.every((r) => typeof r.snapshotCreatedAt === 'string' && r.savedVersion === null)).toBe(true)
    expect(JSON.stringify(rows)).not.toMatch(/MODEL-WRITTEN|student_bundle|views\//)
    session.userId = TA
    expect(await service.listDraftHistory({ sectionId: section, pluginProjectId: projectId })).toBeNull()
    session.userId = null
  })

  // Real concurrency needs real connections: the stand-in has one connection and no locks.
  it.skipIf(process.env.STUDIO_DB_STAND_IN === 'pglite')('an undo and a start racing from the same revision end consistent, in either order', async () => {
    const env = dbEnv()
    const c1 = new Client({ connectionString: env.pgUrl })
    const c2 = new Client({ connectionString: env.pgUrl })
    await c1.connect()
    await c2.connect()
    const startSql = 'select public.studio_builder_start($1, $2, $3, $4, $5, $6, $7, $8, null, 100, 100, 1000) as r'
    const startArgs = (p: string) => [PROFESSOR, A.institution, section, p, `tool-${randomBytes(4).toString('hex')}`, 'Untitled tool', 'Build flashcards', randomUUID()]
    const undoSql = 'select public.studio_builder_undo($1, $2, $3, $4) as r'
    /** Waits until some backend is blocked on a lock inside a builder function. */
    const blocked = () =>
      vi.waitFor(
        async () => {
          const r = await one<{ n: string }>("select count(*) as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%studio_builder_%'")
          if (Number(r.n) === 0) throw new Error('the second call never waited on the first')
        },
        { timeout: 5000, interval: 50 },
      )
    try {
      // The undo holds the project row; the start waits, then builds on the moved draft.
      const first = await twoBuilds()
      await c1.query('begin')
      const undone = (await c1.query(undoSql, [first.projectId, PROFESSOR, first.b, 2])).rows[0].r
      const racing = c2.query(startSql, startArgs(first.projectId))
      await blocked()
      await c1.query('commit')
      const started = (await racing).rows[0].r
      expect(undone).toMatchObject({ outcome: 'undone', head: first.a })
      expect(started.outcome).toBe('started')
      expect(await runRow(String(started.run_id))).toMatchObject({ base_hash: first.a })
      expect(Number((await runRow(String(started.run_id))).base_rev)).toBe(3)

      // The start holds the project row; the undo waits, then sees the active run.
      const second = await twoBuilds()
      await c2.query('begin')
      const won = (await c2.query(startSql, startArgs(second.projectId))).rows[0].r
      const losing = c1.query(undoSql, [second.projectId, PROFESSOR, second.b, 2])
      await blocked()
      await c2.query('commit')
      expect(won.outcome).toBe('started')
      expect((await losing).rows[0].r).toEqual({ outcome: 'busy' })
      expect(await project(second.projectId)).toMatchObject({ head: second.b, undo: second.a })
      expect(await runRow(String(won.run_id))).toMatchObject({ base_hash: second.b })
    } finally {
      await c1.query('rollback').catch(() => undefined)
      await c2.query('rollback').catch(() => undefined)
      await c1.end()
      await c2.end()
    }
  })
})

describe('the run state machine', () => {
  it('refuses impossible transitions and never lets a finished run change', async () => {
    const s = await start(null)
    await expect(sql("update public.studio_plugin_builder_runs set status = 'preview_ready', result = '{}' where id = $1", [s.run_id])).rejects.toThrow(/can.t move from queued/)
    await rpc('studio_builder_stop', [s.run_id, PROFESSOR, 60000])
    await expect(sql("update public.studio_plugin_builder_runs set status = 'queued' where id = $1", [s.run_id])).rejects.toThrow(/finished run/)
    // Late spend still counts.
    await rpc('studio_builder_add_cost', [s.run_id, 10, 0, 5, 0.01])
    expect(Number((await runRow(String(s.run_id))).cost_usd)).toBeCloseTo(0.01)
  })
  it('a stalled run with a pending Stop is cancelled, not requeued', async () => {
    const s = await start(null)
    await claim(String(s.run_id))
    expect((await rpc('studio_builder_stop', [s.run_id, PROFESSOR, 60000])).outcome).toBe('requested')
    // The slice died before it saw the Stop.
    await sql("update public.studio_plugin_builder_runs set heartbeat_at = now() - interval '5 minutes' where id = $1", [s.run_id])
    expect((await rpc('studio_builder_tend', [s.run_id, PROFESSOR, 60000, 2])).outcome).toBe('cancelled')
    expect(await runRow(String(s.run_id))).toMatchObject({ status: 'cancelled', error_code: null })
  })
  it('Stop on a slice that died ends the run at once; a TA can’t stop it', async () => {
    const s = await start(null)
    await claim(String(s.run_id))
    expect((await rpc('studio_builder_stop', [s.run_id, TA, 60000])).outcome).toBe('gone')
    await sql("update public.studio_plugin_builder_runs set heartbeat_at = now() - interval '5 minutes' where id = $1", [s.run_id])
    expect((await rpc('studio_builder_stop', [s.run_id, PROFESSOR, 60000])).outcome).toBe('cancelled')
  })
  it('a version can be saved from a snapshot only once', async () => {
    const s = await start(null)
    const token = await claim(String(s.run_id))
    const h = randomBytes(32).toString('hex')
    await rpc('studio_builder_end', [s.run_id, token, 'preview_ready', null, { status: 'preview_ready' }, snapshot(h), 0])
    const slug = (await one<{ slug: string }>('select slug from public.studio_plugin_projects where id = $1', [s.project_id])).slug
    const insert = (version: string) =>
      sql(
        `insert into public.studio_plugin_versions (project_id, institution_id, version, manifest, bridge_version, source, student_bundle, professor_bundle, bundle_sha256, published_by, source_snapshot_hash)
         values ($1, $2, $3, $4, 'v1', '{}', 's', 'p', $5, $6, $7)`,
        [s.project_id, A.institution, version, { id: slug, version, bridgeVersion: 'v1', collections: {} }, 'f'.repeat(64), PROFESSOR, h],
      )
    await insert('1.0.0')
    await expect(insert('1.1.0')).rejects.toThrow(/uq_studio_versions_source_snapshot|duplicate/)
  })
})

describe('one whole build, through the real harness', () => {
  const slice = async (runId: string, model: ReturnType<typeof scriptedModel>) => {
    const r = await runRow(runId)
    return runBuilderSlice({ runId, sliceNo: Number(r.slice_no) }, { id: String(r.job_id), deadline: Date.now() + 10 * 60_000 }, realHarnessDeps(model))
  }
  // The first build's project and the draft it committed, for the follow-up.
  const built = { projectId: '', head: '' }

  it('first build: plan, approval, both views, checks, commit, preview, then a human Save', async () => {
    session.userId = PROFESSOR
    // The cases above used up this professor's daily builds; the cap itself is tested above.
    await sql('delete from public.studio_plugin_builder_runs where project_id = any($1::uuid[])', [projects])
    const started = await service.startBuild({ sectionId: section, pluginProjectId: null, request: 'Flashcards for this week’s terms', clientRequestId: randomUUID() })
    if (!started.ok) throw new Error(started.error)
    const { runId, pluginProjectId } = started.value
    projects.push(pluginProjectId)
    const model = scriptedModel([
      { calls: [plan()] },
      { calls: [proposeManifest()] },
      { calls: [write('views/student.tsx', STUDENT_VIEW), write('views/professor.tsx', PROFESSOR_VIEW), call('run_checks')] },
      { calls: [finish()] },
    ])
    await slice(runId, model)
    const progress = await service.readProgress(runId, 0)
    expect(progress?.status).toBe('waiting_for_approval')
    expect(progress?.approval?.items.length).toBeGreaterThan(0)

    const decided = await service.decideApproval({ sectionId: section, runId, proposalId: progress!.approval!.proposalId, deltaHash: progress!.approval!.deltaHash, approve: true })
    expect(decided.ok).toBe(true)
    await slice(runId, model)

    const done = await service.readProgress(runId, 0)
    expect(done?.status).toBe('preview_ready')
    const head = await one<{ h: string }>('select draft_head_hash as h from public.studio_plugin_projects where id = $1', [pluginProjectId])
    expect(done?.result?.previewHash).toBe(head.h)
    const snap = await one<{ files: Record<string, string>; student_bundle: string }>('select files, student_bundle from public.studio_plugin_snapshots where project_id = $1 and hash = $2', [pluginProjectId, head.h])
    expect(snap.files['views/student.tsx']).toBe(STUDENT_VIEW)
    expect(snap.student_bundle).toContain('ScholeraKit.render')
    // The ledger saw every model turn, attributed to the run: the four scripted ones and the
    // design review after the checks passed (Step 11), which the script leaves unanswered.
    const spend = await runRow(runId)
    expect(Number(spend.model_turns)).toBe(5)
    expect(Number(spend.cost_usd)).toBeGreaterThan(0)

    // Nothing reached students; saving is a separate professor action.
    expect(Number((await one<{ n: string }>('select count(*) as n from public.studio_plugin_versions where project_id = $1', [pluginProjectId])).n)).toBe(0)
    const saved = await publishDraft({ sectionId: section, projectId: pluginProjectId, snapshotHash: head.h })
    expect(saved).toMatchObject({ ok: true, value: { version: '1.0.0' } })
    const version = await one<{ source_snapshot_hash: string; n: string }>(
      'select source_snapshot_hash, (select count(*) from public.studio_plugin_installations where project_id = $1) as n from public.studio_plugin_versions where project_id = $1',
      [pluginProjectId],
    )
    expect(version.source_snapshot_hash).toBe(head.h)
    expect(Number(version.n)).toBe(0)
    Object.assign(built, { projectId: pluginProjectId, head: head.h })
  }, 60_000)

  it('a follow-up build loads the saved draft and changes only the view it edits', async () => {
    expect(built.head).not.toBe('')
    session.userId = PROFESSOR
    const started = await service.startBuild({ sectionId: section, pluginProjectId: built.projectId, request: 'Rename the I know this button to Got it', clientRequestId: randomUUID() })
    if (!started.ok) throw new Error(started.error)
    const { runId } = started.value
    expect(await runRow(runId)).toMatchObject({ base_hash: built.head })
    const model = scriptedModel([
      { calls: [call('read_file', { path: 'views/student.tsx' })] },
      { calls: [call('edit_file', { path: 'views/student.tsx', old_text: '>I know this<', new_text: '>Got it<' }), call('run_checks')] },
      { calls: [finish()] },
    ])
    await slice(runId, model)

    expect((await service.readProgress(runId, 0))?.status).toBe('preview_ready')
    const project = await one<{ head: string; undo: string; rev: string }>(
      'select draft_head_hash as head, draft_undo_hash as undo, draft_rev as rev from public.studio_plugin_projects where id = $1',
      [built.projectId],
    )
    expect({ undo: project.undo, rev: Number(project.rev) }).toEqual({ undo: built.head, rev: 2 })
    const snap = await one<{ files: Record<string, string> }>('select files from public.studio_plugin_snapshots where project_id = $1 and hash = $2', [built.projectId, project.head])
    expect(snap.files['views/student.tsx']).toBe(STUDENT_VIEW.replace('>I know this<', '>Got it<'))
    expect(snap.files['views/professor.tsx']).toBe(PROFESSOR_VIEW)
  }, 60_000)

  it('a TA of the section can’t read the build or start one', async () => {
    session.userId = TA
    expect(await service.readProgress(randomUUID(), 0)).toBeNull()
    const r = await service.startBuild({ sectionId: section, pluginProjectId: null, request: 'x', clientRequestId: randomUUID() })
    expect(r.ok).toBe(false)
  })
})
