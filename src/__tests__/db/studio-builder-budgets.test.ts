/**
 * Builder caps, recovery and races against a real database (`npm run test:db`). The
 * hermetic side of the same rules is src/__tests__/studio-builder-recovery.test.ts.
 *
 * The cap tests run inside one transaction that is rolled back, so they can clear the
 * rows a cap counts and test its exact boundary without touching anyone else's data.
 * The race tests need two or more real connections with committed rows, so they run
 * only against real Postgres. Each race uses a lock as its barrier: one connection holds
 * the lock the functions take, and the test waits until the others are blocked on it
 * before releasing it. Their rows live in institution B, under projects named MARK, and
 * are deleted before and after.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dbEnv } from './env'
import { FIXTURE } from './fixture'
import { grantStudio } from './studio-entitlement'
import { call, finish, scriptedModel } from '../helpers/builder-fixtures'
import {
  STUDIO_BUILDER_DAILY_RUNS_PER_PROFESSOR,
  STUDIO_BUILDER_HEARTBEAT_STALE_MS,
  STUDIO_BUILDER_INSTITUTION_DAILY_COST_USD,
  STUDIO_BUILDER_MAX_BYTES_WRITTEN,
  STUDIO_BUILDER_MAX_CHECK_RUNS,
  STUDIO_BUILDER_MAX_LIVE_RUNS_PER_INSTITUTION,
  STUDIO_BUILDER_MAX_QUESTIONS,
  STUDIO_BUILDER_MAX_REPAIR_ROUNDS,
  STUDIO_BUILDER_MAX_RESUMES,
  STUDIO_BUILDER_MAX_TOOL_CALLS,
  STUDIO_BUILDER_MAX_WRITES,
  STUDIO_BUILDER_WAITING_TTL_MS,
} from '@/lib/studio/limits'

vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/jobs/enqueue', () => ({ kickWorker: vi.fn(async () => ({ kicked: true })) }))

const { runBuilderSlice, realHarnessDeps } = await import('@/lib/studio/builder/harness')
type RunStore = import('@/lib/studio/builder/harness').RunStore

const ON_PGLITE = process.env.STUDIO_DB_STAND_IN === 'pglite'
const MARK = 'Builder budget test'
const A = FIXTURE.a
const B = FIXTURE.b
const PROF_A = A.users.professor.id
const PROF_B = B.users.professor.id
const CAPS = {
  tool_calls: STUDIO_BUILDER_MAX_TOOL_CALLS,
  writes: STUDIO_BUILDER_MAX_WRITES,
  bytes_written: STUDIO_BUILDER_MAX_BYTES_WRITTEN,
  check_runs: STUDIO_BUILDER_MAX_CHECK_RUNS,
  repair_rounds: STUDIO_BUILDER_MAX_REPAIR_ROUNDS,
  questions: STUDIO_BUILDER_MAX_QUESTIONS,
}
const DAILY_RUNS = STUDIO_BUILDER_DAILY_RUNS_PER_PROFESSOR
const LIVE_RUNS = STUDIO_BUILDER_MAX_LIVE_RUNS_PER_INSTITUTION
const DAILY_COST = STUDIO_BUILDER_INSTITUTION_DAILY_COST_USD

let db: Client
let restoreEntitlement: (() => Promise<void>) | undefined
let sectionA = ''

type Json = Record<string, unknown>

/** Calls a builder function. Objects and arrays are sent as JSON text and cast, so both
 * node-postgres (which sends arrays as Postgres arrays) and PGlite get real jsonb. */
async function rpcOn(c: Client, fn: string, args: unknown[]): Promise<Json> {
  const params = args.map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a))
  const placeholders = args.map((a, i) => (a !== null && typeof a === 'object' ? `$${i + 1}::text::jsonb` : `$${i + 1}`)).join(', ')
  return (await c.query(`select public.${fn}(${placeholders}) as r`, params)).rows[0].r as Json
}
const rpc = (fn: string, args: unknown[]) => rpcOn(db, fn, args)
async function one<T = Json>(text: string, params: unknown[] = []): Promise<T> {
  return (await db.query(text, params)).rows[0] as T
}

interface StartOpts {
  owner?: string
  institution?: string
  section?: string
  project?: string | null
  crid?: string
  maxDaily?: number
  maxLive?: number
  maxCost?: number
}
const startArgs = (o: StartOpts = {}) => [
  o.owner ?? PROF_B, o.institution ?? B.institution, o.section ?? B.section, o.project ?? null,
  `tool-${randomBytes(4).toString('hex')}`, MARK, 'Build flashcards', o.crid ?? randomUUID(), null,
  o.maxDaily ?? 1000, o.maxLive ?? 1000, o.maxCost ?? 1_000_000,
]
const startOn = (c: Client, o: StartOpts = {}) => rpcOn(c, 'studio_builder_start', startArgs(o))
const start = (o: StartOpts = {}) => startOn(db, o)

async function claimOn(c: Client, runId: string): Promise<string | null> {
  const r = await one<{ job_id: string; slice_no: number }>('select job_id, slice_no from public.studio_plugin_builder_runs where id = $1', [runId])
  const out = await rpcOn(c, 'studio_builder_claim', [runId, r.job_id, Number(r.slice_no), STUDIO_BUILDER_HEARTBEAT_STALE_MS, STUDIO_BUILDER_MAX_RESUMES])
  return (out.token as string | null) ?? null
}
const claim = (runId: string) => claimOn(db, runId)
const stale = (runId: string) =>
  db.query("update public.studio_plugin_builder_runs set heartbeat_at = now() - interval '5 minutes' where id = $1", [runId])
const runRow = (id: string) => one('select * from public.studio_plugin_builder_runs where id = $1', [id])
const spend = async (institution = B.institution) => Number((await one<{ v: string }>('select public.studio_builder_spend($1) as v', [institution])).v)
const turnStep = (id: string, cost: number) => ({ kind: 'model_turn', tool_call_id: id, status: 'done', label: 'turn.next', cost_usd: cost })
const toolStep = (id: string) => ({ kind: 'tool', tool: 'read_file', tool_call_id: id, status: 'done', label: 'file.read' })
const work = (rev: number) => ({ work_rev: rev, manifest: null, files: {}, working_set: [], changed: [], kit_refs: [], last_check: null, streaks: {}, delta: { approved: [], declined: [], direct: [] } })
const snapshot = (hash: string) => ({ hash, compiler: 'studio-tsx-v1+test', manifest: { id: 'x' }, files: { 'views/student.tsx': 's', 'views/professor.tsx': 'p' }, student_bundle: 's', professor_bundle: 'p', check_summary: { passed: true } })
const hash = () => randomBytes(32).toString('hex')
const recordTurnOn = (c: Client, runId: string, token: string, step: Json) => rpcOn(c, 'studio_builder_record_turn', [runId, token, step, 0, false])
/** A model call's cost, as the harness records it the moment the reply lands. */
const addCostOn = (c: Client, runId: string, cost: number) => rpcOn(c, 'studio_builder_add_cost', [runId, 0, 0, 0, cost])
const applyOn = (c: Client, runId: string, token: string, step: Json) => rpcOn(c, 'studio_builder_apply', [runId, token, step, 0, null, null, null, { tool_calls: 1 }, CAPS, 0])
const endOn = (c: Client, runId: string, token: string, status = 'failed', snap: Json | null = null) =>
  rpcOn(c, 'studio_builder_end', [runId, token, status, status === 'failed' ? 'internal' : null, { status }, snap, 0])
const seedWork = (runId: string, token: string) =>
  rpc('studio_builder_apply', [runId, token, { kind: 'system', tool_call_id: 'sys:work', status: 'done', label: 'run.slice' }, -1, work(0), null, null, {}, CAPS, 0])
const askOn = (c: Client, runId: string, token: string) =>
  rpcOn(c, 'studio_builder_pause', [runId, token, { ...toolStep('9.0'), tool: 'ask_professor', label: 'question.asked' }, [], null, { id: randomUUID(), question: 'Which week?', answer: null }, {}, CAPS, STUDIO_BUILDER_WAITING_TTL_MS, 0])

/** Runs `fn` in a transaction on the main connection and rolls it back. */
async function rolledBack(fn: () => Promise<void>) {
  await db.query('begin')
  try {
    await fn()
  } finally {
    await db.query('rollback')
  }
}
/** Inside rolledBack: removes every builder run an institution's caps would count. */
/** Spend rows outlive their runs, so a school's caps need both cleared. */
const clearRuns = async (institution: string) => {
  await db.query('delete from public.studio_plugin_builder_runs where institution_id = $1', [institution])
  await db.query('delete from public.studio_plugin_builder_spend where institution_id = $1', [institution])
}

/** Deletes this file's committed projects (and so their runs, steps and snapshots). */
async function cleanup() {
  const { rows } = await db.query('select id from public.studio_plugin_projects where name = $1 and owner_id = any($2::uuid[])', [MARK, [PROF_A, PROF_B]])
  for (const { id } of rows as { id: string }[]) {
    await db.query('update public.studio_plugin_projects set draft_head_hash = null, draft_undo_hash = null where id = $1', [id])
    await db.query('delete from public.studio_plugin_versions where project_id = $1', [id])
    await db.query('delete from public.studio_plugin_projects where id = $1', [id])
  }
  await db.query('delete from public.studio_plugin_builder_spend where institution_id = any($1::uuid[])', [[A.institution, B.institution]])
  await db.query(
    `delete from public.background_jobs where type = 'studio_builder_slice' and institution_id = any($1::uuid[])
       and not exists (select 1 from public.studio_plugin_builder_runs r where r.id::text = params ->> 'runId')`,
    [[A.institution, B.institution]],
  )
}

beforeAll(async () => {
  const env = dbEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey
  db = new Client({ connectionString: env.pgUrl })
  await db.connect()
  await cleanup()
  restoreEntitlement = await grantStudio(db, A.institution)
  const r = await one<{ id: string }>(
    `insert into public.course_sections (institution_id, course_id, section_code, semester, year, professor_id)
     values ($1, $2, $3, 'Fall', 2026, $4) returning id`,
    [A.institution, A.course, `BUD-${randomBytes(4).toString('hex')}`, PROF_A],
  )
  sectionA = r.id
})

afterAll(async () => {
  if (!db) return
  await cleanup()
  await restoreEntitlement?.()
  await db.query('delete from public.course_sections where id = $1', [sectionA])
  await db.end()
})

describe('a professor’s daily builds', () => {
  it('the last allowed build in 24 hours starts and the next is refused; ending one frees nothing; older builds don’t count', async () => {
    await rolledBack(async () => {
      await db.query('delete from public.studio_plugin_builder_runs where owner_id = $1', [PROF_B])
      // A build from 25 hours ago.
      const old = await one<{ id: string }>('insert into public.studio_plugin_projects (institution_id, owner_id, slug, name) values ($1, $2, $3, $4) returning id', [B.institution, PROF_B, `tool-${randomBytes(4).toString('hex')}`, MARK])
      await db.query(
        `insert into public.studio_plugin_builder_runs (project_id, institution_id, owner_id, section_id, client_request_id, request, status, base_rev, result, created_at)
         values ($1, $2, $3, $4, gen_random_uuid(), 'x', 'cancelled', 0, '{}', now() - interval '25 hours')`,
        [old.id, B.institution, PROF_B, B.section],
      )
      const started: string[] = []
      for (let i = 0; i < DAILY_RUNS; i++) {
        const r = await start({ maxDaily: DAILY_RUNS })
        expect(r.outcome).toBe('started')
        started.push(String(r.run_id))
      }
      expect(await start({ maxDaily: DAILY_RUNS })).toEqual({ outcome: 'limit_daily_runs' })
      expect((await rpc('studio_builder_stop', [started[0], PROF_B, STUDIO_BUILDER_HEARTBEAT_STALE_MS])).outcome).toBe('cancelled')
      expect(await start({ maxDaily: DAILY_RUNS })).toEqual({ outcome: 'limit_daily_runs' })
    })
  })
})

describe('a school’s live builds', () => {
  it('the last live slot can be taken and the next start is refused; a waiting build holds no slot and can resume only into a free one', async () => {
    await rolledBack(async () => {
      await clearRuns(B.institution)
      const runs: string[] = []
      for (let i = 0; i < LIVE_RUNS; i++) {
        const r = await start({ maxLive: LIVE_RUNS })
        expect(r.outcome).toBe('started')
        runs.push(String(r.run_id))
      }
      // A running build counts like a queued one.
      const token = (await claim(runs[0]))!
      expect(await start({ maxLive: LIVE_RUNS })).toEqual({ outcome: 'limit_live_runs' })
      await seedWork(runs[0], token)
      expect((await askOn(db, runs[0], token)).ok).toBe(true)
      expect((await start({ maxLive: LIVE_RUNS })).outcome).toBe('started')
      expect(await start({ maxLive: LIVE_RUNS })).toEqual({ outcome: 'limit_live_runs' })
      // Answering puts the waiting build back in the queue, under the same cap.
      const questions = (await runRow(runs[0])).questions as { id: string }[]
      const answer = () => rpc('studio_builder_answer', [runs[0], PROF_B, questions[questions.length - 1].id, 'Week 3', LIVE_RUNS])
      expect(await answer()).toEqual({ outcome: 'busy' })
      expect((await rpc('studio_builder_stop', [runs[1], PROF_B, STUDIO_BUILDER_HEARTBEAT_STALE_MS])).outcome).toBe('cancelled')
      expect((await answer()).outcome).toBe('answered')
      expect(await start({ maxLive: LIVE_RUNS })).toEqual({ outcome: 'limit_live_runs' })
    })
  })
})

describe('a school’s daily spend', () => {
  it('a start just under the cap is allowed; at the cap it is refused', async () => {
    await rolledBack(async () => {
      await clearRuns(B.institution)
      const r = await start({ maxCost: DAILY_COST })
      await claim(String(r.run_id))
      await addCostOn(db, String(r.run_id), DAILY_COST - 0.000001)
      expect(await spend()).toBeCloseTo(DAILY_COST - 0.000001, 6)
      expect((await start({ maxCost: DAILY_COST })).outcome).toBe('started')
      await addCostOn(db, String(r.run_id), 0.000001)
      expect(await spend()).toBeCloseTo(DAILY_COST, 6)
      expect(await start({ maxCost: DAILY_COST })).toEqual({ outcome: 'limit_daily_cost' })
    })
  })

  it('counts spend by when it was spent: a run started two days ago spending now counts, a turn from 25 hours ago doesn’t', async () => {
    await rolledBack(async () => {
      await clearRuns(B.institution)
      const p = await one<{ id: string }>('insert into public.studio_plugin_projects (institution_id, owner_id, slug, name) values ($1, $2, $3, $4) returning id', [B.institution, PROF_B, `tool-${randomBytes(4).toString('hex')}`, MARK])
      const token = randomUUID()
      const run = await one<{ id: string }>(
        `insert into public.studio_plugin_builder_runs (project_id, institution_id, owner_id, section_id, client_request_id, request, status, base_rev, claim_token, heartbeat_at, created_at)
         values ($1, $2, $3, $4, gen_random_uuid(), 'x', 'running', 0, $5, now(), now() - interval '2 days') returning id`,
        [p.id, B.institution, PROF_B, B.section, token],
      )
      expect(token).toBeTruthy()
      await addCostOn(db, run.id, 0.5)
      const insertSpend = (cost: number, age: string) =>
        db.query(
          `insert into public.studio_plugin_builder_spend (run_id, institution_id, cost_usd, created_at) values ($1, $2, $3, now() - $4::interval)`,
          [run.id, B.institution, cost, age],
        )
      await insertSpend(7, '25 hours')
      await insertSpend(2, '23 hours')
      expect(await spend()).toBeCloseTo(2.5, 6)
    })
  })
})

describe('spend that arrives after a run ended', () => {
  /** A failed, a committed and a stopped run, each with the token a late reply would carry. */
  async function endedRuns(): Promise<[string, string][]> {
    const failed = String((await start()).run_id)
    const t1 = (await claim(failed))!
    expect((await endOn(db, failed, t1, 'failed')).outcome).toBe('ended')
    const committed = String((await start()).run_id)
    const t2 = (await claim(committed))!
    expect((await endOn(db, committed, t2, 'preview_ready', snapshot(hash()))).outcome).toBe('ended')
    const stopped = String((await start()).run_id)
    expect((await rpc('studio_builder_stop', [stopped, PROF_B, STUDIO_BUILDER_HEARTBEAT_STALE_MS])).outcome).toBe('cancelled')
    return [[failed, t1], [committed, t2], [stopped, randomUUID()]]
  }

  it('still adds to the run’s cost, whatever the ending; the late turn itself is refused', async () => {
    await rolledBack(async () => {
      await clearRuns(B.institution)
      for (const [runId, token] of await endedRuns()) {
        await rpc('studio_builder_add_cost', [runId, 1000, 0, 300, 0.25])
        expect(Number((await runRow(runId)).cost_usd)).toBeCloseTo(0.25, 6)
        expect(await recordTurnOn(db, runId, token, turnStep('turn:9:0', 0.25))).toEqual({ ok: false, reason: 'fence' })
      }
    })
  })

  it('reaches the school’s daily spend, though its turn is never recorded', async () => {
    await rolledBack(async () => {
      await clearRuns(B.institution)
      const before = await spend()
      for (const [runId] of await endedRuns()) await rpc('studio_builder_add_cost', [runId, 1000, 0, 300, 0.25])
      expect(await spend()).toBeCloseTo(before + 0.75, 6)
    })
  })
})

describe('recovering a stalled slice', () => {
  it('the progress read requeues a stalled run as a new slice up to the resume limit, then fails it as interrupted', async () => {
    await rolledBack(async () => {
      const runId = String((await start()).run_id)
      let token = (await claim(runId))!
      expect((await rpc('studio_builder_tend', [runId, PROF_B, STUDIO_BUILDER_HEARTBEAT_STALE_MS, STUDIO_BUILDER_MAX_RESUMES])).outcome).toBe('none')
      for (let resume = 1; resume <= STUDIO_BUILDER_MAX_RESUMES; resume++) {
        await stale(runId)
        const tended = await rpc('studio_builder_tend', [runId, PROF_B, STUDIO_BUILDER_HEARTBEAT_STALE_MS, STUDIO_BUILDER_MAX_RESUMES])
        expect(tended.outcome).toBe('requeued')
        expect(await runRow(runId)).toMatchObject({ status: 'queued', slice_no: resume + 1, resume_count: resume, job_id: tended.job_id })
        // The stalled slice is fenced out, and its job can't claim the new slice.
        expect(await applyOn(db, runId, token, toolStep(`${resume}.0`))).toEqual({ ok: false, reason: 'fence' })
        const job = await one<{ params: Json }>('select params from public.background_jobs where id = $1', [tended.job_id])
        expect(job.params).toEqual({ runId, sliceNo: resume + 1 })
        token = (await claim(runId))!
        expect(token).toBeTruthy()
      }
      await stale(runId)
      expect((await rpc('studio_builder_tend', [runId, PROF_B, STUDIO_BUILDER_HEARTBEAT_STALE_MS, STUDIO_BUILDER_MAX_RESUMES])).outcome).toBe('failed')
      expect(await runRow(runId)).toMatchObject({ status: 'failed', error_code: 'interrupted', claim_token: null })
      expect(await claim(runId)).toBeNull()
    })
  })

  it('after a re-claim the old token’s turn, step, pause, hand-off and end are all refused, while its spend still lands', async () => {
    await rolledBack(async () => {
      const runId = String((await start()).run_id)
      const old = (await claim(runId))!
      await seedWork(runId, old)
      await stale(runId)
      const current = (await claim(runId))!
      expect(current).not.toBe(old)
      expect(await recordTurnOn(db, runId, old, turnStep('turn:1:0', 0.1))).toEqual({ ok: false, reason: 'fence' })
      expect(await applyOn(db, runId, old, toolStep('1.0'))).toEqual({ ok: false, reason: 'fence' })
      expect(await askOn(db, runId, old)).toEqual({ ok: false, reason: 'fence' })
      expect(await rpc('studio_builder_handoff', [runId, old, 32, 0])).toEqual({ outcome: 'fence' })
      expect(await endOn(db, runId, old, 'preview_ready', snapshot(hash()))).toEqual({ outcome: 'fence' })
      await rpc('studio_builder_add_cost', [runId, 10, 0, 5, 0.1])
      expect(await runRow(runId)).toMatchObject({ status: 'running', claim_token: current, model_turns: 0 })
      expect(Number((await runRow(runId)).cost_usd)).toBeCloseTo(0.1, 6)
    })
  })

  it('a slice that dies mid-turn resumes through the real harness: the unrecorded calls are marked interrupted', async () => {
    const r = await start({ owner: PROF_A, institution: A.institution, section: sectionA })
    const runId = String(r.run_id)
    const model = scriptedModel([
      { calls: [call('get_kit_reference', { component: 'Button' }), call('get_kit_reference', { component: 'Text' }), call('get_kit_reference', { component: 'Card' })] },
      { calls: [finish('blocked', 'Nothing to build yet.')] },
    ])
    const deps = realHarnessDeps(model)
    // The instance stops answering after the turn's first call is stored.
    let dead = false
    const dying: Record<string, unknown> = {}
    for (const [name, fn] of Object.entries(deps.store) as [string, (...a: unknown[]) => Promise<unknown>][]) {
      dying[name] = async (...args: unknown[]) => {
        const id = String((args[0] as { step?: { tool_call_id?: string } }).step?.tool_call_id ?? '')
        if (name === 'apply' && id.endsWith('.1')) dead = true
        if (dead) throw new Error('instance stopped')
        return fn(...args)
      }
    }
    const slice = async (store: RunStore) => {
      const row = await runRow(runId)
      return runBuilderSlice({ runId, sliceNo: Number(row.slice_no) }, { id: String(row.job_id), deadline: Date.now() + 10 * 60_000 }, { ...deps, store })
    }
    expect(await slice(dying as unknown as RunStore)).toBe('faulted')
    expect((await runRow(runId)).status).toBe('running')

    // What the jobs worker does when the dead job's lease expires: run the same slice again.
    expect(await slice(deps.store)).toBe('not claimed')
    await stale(runId)
    expect(await slice(deps.store)).toBe('stopped')

    const steps = (await db.query('select seq, tool_call_id, status, label from public.studio_plugin_builder_steps where run_id = $1 order by seq', [runId])).rows as { seq: number; tool_call_id: string; status: string; label: string }[]
    const seq = Number(steps.find((s) => s.label === 'turn.understanding')!.seq)
    const status = (id: string) => steps.filter((s) => s.tool_call_id === id).map((s) => s.status)
    expect(status(`${seq}.0`)).toEqual(['done'])
    expect(status(`${seq}.1`)).toEqual(['interrupted'])
    expect(status(`${seq}.2`)).toEqual(['interrupted'])
    expect(steps.some((s) => s.label === 'run.resumed')).toBe(true)
    expect(await runRow(runId)).toMatchObject({ status: 'blocked', error_code: 'agent_blocked', resume_count: 1, model_turns: 2 })
  }, 60_000)
})

// ── Races: real Postgres only ─────────────────────────────────────────

describe('races between connections', () => {
  const clients: Client[] = []
  async function connect(n: number): Promise<{ c: Client; pid: number }[]> {
    const out = []
    for (let i = 0; i < n; i++) {
      const c = new Client({ connectionString: dbEnv().pgUrl })
      await c.connect()
      clients.push(c)
      out.push({ c, pid: Number((await c.query('select pg_backend_pid() as pid')).rows[0].pid) })
    }
    return out
  }
  /** The barrier: resolves once every one of these backends is waiting on a lock. */
  async function blocked(pids: number[]) {
    await vi.waitFor(
      async () => {
        const r = await one<{ n: number }>('select count(distinct pid)::int as n from pg_locks where pid = any($1::int[]) and not granted', [pids])
        if (r.n !== pids.length) throw new Error('the racing calls never blocked')
      },
      { timeout: 5000, interval: 10 },
    )
  }
  /** One connection holds the institution lock studio_builder_start takes. */
  async function holdStartLock(c: Client, institution = B.institution) {
    await c.query('begin')
    await c.query("select pg_advisory_xact_lock(hashtextextended('studio_builder:' || $1::text, 0))", [institution])
  }
  const outcomes = (rs: Json[]) => rs.map((r) => String(r.outcome)).sort()
  const count = async (where: string, params: unknown[]) => Number((await one<{ n: string }>(`select count(*) as n from public.studio_plugin_builder_runs where ${where}`, params)).n)
  const releaseAll = async () => {
    for (const c of clients.splice(0)) {
      await c.query('rollback').catch(() => undefined)
      await c.end()
    }
  }

  it.skipIf(ON_PGLITE)('two starts for the same project at once make exactly one run', async () => {
    await cleanup()
    const [holder, x, y] = await connect(3)
    try {
      const first = await start()
      await rpc('studio_builder_stop', [first.run_id, PROF_B, STUDIO_BUILDER_HEARTBEAT_STALE_MS])
      const project = String(first.project_id)
      await holdStartLock(holder.c)
      const racing = [startOn(x.c, { project }), startOn(y.c, { project })]
      await blocked([x.pid, y.pid])
      await holder.c.query('commit')
      expect(outcomes(await Promise.all(racing))).toEqual(['busy', 'started'])
      expect(await count("project_id = $1 and status in ('queued', 'running')", [project])).toBe(1)
    } finally {
      await releaseAll()
    }
  })

  it.skipIf(ON_PGLITE)('two starts at the professor’s last daily build: exactly one starts', async () => {
    await cleanup()
    const [holder, x, y] = await connect(3)
    try {
      const used = await count("owner_id = $1 and created_at > now() - interval '24 hours'", [PROF_B])
      for (let i = used; i < DAILY_RUNS - 1; i++) expect((await start()).outcome).toBe('started')
      await holdStartLock(holder.c)
      const racing = [startOn(x.c, { maxDaily: DAILY_RUNS }), startOn(y.c, { maxDaily: DAILY_RUNS })]
      await blocked([x.pid, y.pid])
      await holder.c.query('commit')
      expect(outcomes(await Promise.all(racing))).toEqual(['limit_daily_runs', 'started'])
      expect(await count("owner_id = $1 and created_at > now() - interval '24 hours'", [PROF_B])).toBe(DAILY_RUNS)
    } finally {
      await releaseAll()
    }
  })

  it.skipIf(ON_PGLITE)('three starts racing for the school’s last live slot: the cap holds', async () => {
    await cleanup()
    const [holder, x, y, z] = await connect(4)
    try {
      const live = await count("institution_id = $1 and status in ('queued', 'running')", [B.institution])
      for (let i = live; i < LIVE_RUNS - 1; i++) expect((await start()).outcome).toBe('started')
      await holdStartLock(holder.c)
      const racing = [x, y, z].map((k) => startOn(k.c, { maxLive: LIVE_RUNS }))
      await blocked([x.pid, y.pid, z.pid])
      await holder.c.query('commit')
      expect(outcomes(await Promise.all(racing))).toEqual(['limit_live_runs', 'limit_live_runs', 'started'])
      expect(await count("institution_id = $1 and status in ('queued', 'running')", [B.institution])).toBe(LIVE_RUNS)
    } finally {
      await releaseAll()
    }
  })

  it.skipIf(ON_PGLITE)('starts racing just under the school’s daily spend all start; once spend reaches the cap all are refused', async () => {
    await cleanup()
    const [holder, x, y] = await connect(3)
    try {
      const r = await start()
      const runId = String(r.run_id)
      const token = (await claim(runId))!
      expect(token).toBeTruthy()
      await addCostOn(db, runId, Math.max(0.000001, Number((DAILY_COST - (await spend()) - 0.000001).toFixed(6))))
      expect(await spend()).toBeLessThan(DAILY_COST)
      await holdStartLock(holder.c)
      let racing = [startOn(x.c, { maxCost: DAILY_COST }), startOn(y.c, { maxCost: DAILY_COST })]
      await blocked([x.pid, y.pid])
      await holder.c.query('commit')
      expect(outcomes(await Promise.all(racing))).toEqual(['started', 'started'])

      await addCostOn(db, runId, 0.000001)
      expect(await spend()).toBeGreaterThanOrEqual(DAILY_COST)
      await holdStartLock(holder.c)
      racing = [startOn(x.c, { maxCost: DAILY_COST }), startOn(y.c, { maxCost: DAILY_COST })]
      await blocked([x.pid, y.pid])
      await holder.c.query('commit')
      expect(outcomes(await Promise.all(racing))).toEqual(['limit_daily_cost', 'limit_daily_cost'])
    } finally {
      await releaseAll()
      await cleanup()
    }
  })

  it.skipIf(ON_PGLITE)('Stop racing a commit: the pointer moves only if the commit got there first', async () => {
    await cleanup()
    const [x, y] = await connect(2)
    const pointer = async (project: string) => one<{ h: string | null; rev: string }>('select draft_head_hash as h, draft_rev as rev from public.studio_plugin_projects where id = $1', [project])
    try {
      // The commit holds the run row; Stop waits and finds the run finished.
      const a = await start()
      const ta = (await claim(String(a.run_id)))!
      const h = hash()
      await x.c.query('begin')
      expect((await endOn(x.c, String(a.run_id), ta, 'preview_ready', snapshot(h))).outcome).toBe('ended')
      const stop = rpcOn(y.c, 'studio_builder_stop', [a.run_id, PROF_B, STUDIO_BUILDER_HEARTBEAT_STALE_MS])
      await blocked([y.pid])
      await x.c.query('commit')
      expect(await stop).toEqual({ outcome: 'finished', status: 'preview_ready' })
      expect(await pointer(String(a.project_id))).toEqual({ h, rev: '1' })

      // Stop holds the run row; the commit waits and ends the run cancelled.
      const b = await start()
      const tb = (await claim(String(b.run_id)))!
      await x.c.query('begin')
      expect((await rpcOn(x.c, 'studio_builder_stop', [b.run_id, PROF_B, STUDIO_BUILDER_HEARTBEAT_STALE_MS])).outcome).toBe('requested')
      const commit = endOn(y.c, String(b.run_id), tb, 'preview_ready', snapshot(hash()))
      await blocked([y.pid])
      await x.c.query('commit')
      expect(await commit).toEqual({ outcome: 'cancelled' })
      expect(await pointer(String(b.project_id))).toEqual({ h: null, rev: '0' })
      expect(await runRow(String(b.run_id))).toMatchObject({ status: 'cancelled', result_hash: null })
    } finally {
      await releaseAll()
    }
  })

  it.skipIf(ON_PGLITE)('a re-claim in flight fences out the old slice’s turn, step and end that wait on it', async () => {
    await cleanup()
    const [holder, x, y, z] = await connect(4)
    try {
      const runId = String((await start()).run_id)
      const old = (await claim(runId))!
      await seedWork(runId, old)
      await stale(runId)
      await holder.c.query('begin')
      const current = await claimOn(holder.c, runId)
      expect(current).toBeTruthy()
      const racing = [recordTurnOn(x.c, runId, old, turnStep('turn:1:0', 0.1)), applyOn(y.c, runId, old, toolStep('1.0')), endOn(z.c, runId, old)]
      await blocked([x.pid, y.pid, z.pid])
      await holder.c.query('commit')
      expect(await Promise.all(racing)).toEqual([{ ok: false, reason: 'fence' }, { ok: false, reason: 'fence' }, { outcome: 'fence' }])
      expect(await runRow(runId)).toMatchObject({ status: 'running', claim_token: current, model_turns: 0 })
    } finally {
      await releaseAll()
    }
  })

  it.skipIf(ON_PGLITE)('a commit takes the project row before the run row, the order a start takes them in', async () => {
    await cleanup()
    const [x, y] = await connect(2)
    try {
      const a = await start()
      const runId = String(a.run_id)
      const token = (await claim(runId))!
      // x holds the project row, as studio_builder_start does before it reads the active run.
      await x.c.query('begin')
      await x.c.query('select 1 from public.studio_plugin_projects where id = $1 for update', [a.project_id])
      const commit = endOn(y.c, runId, token, 'preview_ready', snapshot(hash()))
      await blocked([y.pid])
      // The waiting commit holds nothing on the run, so the start's next lock is free. Taken the
      // other way round (run, then project) this would wait on the commit and deadlock.
      await x.c.query('select 1 from public.studio_plugin_builder_runs where id = $1 for update nowait', [runId])
      await x.c.query('commit')
      expect(await commit).toEqual({ outcome: 'ended' })
      expect(await runRow(runId)).toMatchObject({ status: 'preview_ready' })
    } finally {
      await releaseAll()
    }
  })

  it.skipIf(ON_PGLITE)('two commits from the same base revision: exactly one moves the pointer', async () => {
    await cleanup()
    const [x, y] = await connect(2)
    try {
      // The same commit sent twice: the second finds the run already ended.
      const a = await start()
      const ta = (await claim(String(a.run_id)))!
      const [h1, h2] = [hash(), hash()]
      await x.c.query('begin')
      const first = await endOn(x.c, String(a.run_id), ta, 'preview_ready', snapshot(h1))
      const second = endOn(y.c, String(a.run_id), ta, 'preview_ready', snapshot(h2))
      await blocked([y.pid])
      await x.c.query('commit')
      expect([first, await second]).toEqual([{ outcome: 'ended' }, { outcome: 'fence' }])
      expect(await one('select draft_head_hash as h, draft_rev::int as rev from public.studio_plugin_projects where id = $1', [a.project_id])).toEqual({ h: h1, rev: 1 })

      // Another writer moves the draft while the commit waits for the project row.
      const b = await start()
      const tb = (await claim(String(b.run_id)))!
      await x.c.query('begin')
      await x.c.query('update public.studio_plugin_projects set draft_rev = draft_rev + 1 where id = $1', [b.project_id])
      const commit = endOn(y.c, String(b.run_id), tb, 'preview_ready', snapshot(hash()))
      await blocked([y.pid])
      await x.c.query('commit')
      expect(await commit).toEqual({ outcome: 'conflict' })
      expect(await one('select draft_head_hash as h, draft_rev::int as rev from public.studio_plugin_projects where id = $1', [b.project_id])).toEqual({ h: null, rev: 1 })
      expect(await runRow(String(b.run_id))).toMatchObject({ status: 'blocked', error_code: 'draft_changed' })
    } finally {
      await releaseAll()
    }
  })

  it.skipIf(ON_PGLITE)('two saves of the same snapshot at once make exactly one version', async () => {
    await cleanup()
    const [x, y] = await connect(2)
    try {
      const s = await start()
      const token = (await claim(String(s.run_id)))!
      const h = hash()
      await endOn(db, String(s.run_id), token, 'preview_ready', snapshot(h))
      const slug = (await one<{ slug: string }>('select slug from public.studio_plugin_projects where id = $1', [s.project_id])).slug
      const save = (c: Client, version: string) =>
        c.query(
          `insert into public.studio_plugin_versions (project_id, institution_id, version, manifest, bridge_version, source, student_bundle, professor_bundle, bundle_sha256, published_by, source_snapshot_hash)
           values ($1, $2, $3, $4::text::jsonb, 'v1', '{}', 's', 'p', $5, $6, $7)`,
          [s.project_id, B.institution, version, JSON.stringify({ id: slug, version, bridgeVersion: 'v1', collections: {} }), 'f'.repeat(64), PROF_B, h],
        )
      await x.c.query('begin')
      await save(x.c, '1.0.0')
      const racing = save(y.c, '1.1.0').then(() => 'saved', (e: { code?: string }) => e.code)
      await blocked([y.pid])
      await x.c.query('commit')
      expect(await racing).toBe('23505')
      expect(Number((await one<{ n: string }>('select count(*) as n from public.studio_plugin_versions where project_id = $1', [s.project_id])).n)).toBe(1)
    } finally {
      await releaseAll()
    }
  })
})
