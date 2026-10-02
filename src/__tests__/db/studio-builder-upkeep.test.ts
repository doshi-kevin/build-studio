/**
 * The job worker's stalled-run sweep against a real database (`npm run test:db`):
 * studio_builder_sweep, and the owner-checked studio_builder_tend that now shares its body.
 * The hermetic side (the kick runs upkeep before the drain) is src/__tests__/jobs-upkeep.test.ts.
 *
 * The sweep tends runs in every school, so each test runs in one transaction that is rolled
 * back, and first sweeps everything already stalled (other files' leftovers) inside that
 * transaction. After that, the counts a sweep returns are this test's alone. The SKIP LOCKED
 * test needs a committed row and a second connection; its rows live in institution B under
 * projects named MARK and are deleted before and after.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dbEnv } from './env'
import { FIXTURE } from './fixture'
import {
  STUDIO_BUILDER_HEARTBEAT_STALE_MS,
  STUDIO_BUILDER_MAX_LIVE_RUNS_PER_INSTITUTION,
  STUDIO_BUILDER_MAX_QUESTIONS,
  STUDIO_BUILDER_MAX_RESUMES,
  STUDIO_BUILDER_WAITING_TTL_MS,
} from '@/lib/studio/limits'

const ON_PGLITE = process.env.STUDIO_DB_STAND_IN === 'pglite'
const MARK = 'Builder upkeep test'
const A = FIXTURE.a
const B = FIXTURE.b
const PROF_A = A.users.professor.id
const PROF_B = B.users.professor.id
const LIVE_RUNS = STUDIO_BUILDER_MAX_LIVE_RUNS_PER_INSTITUTION
const STALE = STUDIO_BUILDER_HEARTBEAT_STALE_MS
const RESUMES = STUDIO_BUILDER_MAX_RESUMES
const CAPS = { tool_calls: 48, writes: 30, bytes_written: 262144, check_runs: 6, repair_rounds: 3, questions: STUDIO_BUILDER_MAX_QUESTIONS }

let db: Client
type Json = Record<string, unknown>

/** Calls a builder function. Objects and arrays are sent as JSON text and cast to jsonb. */
async function rpcOn(c: Client, fn: string, args: unknown[]): Promise<Json> {
  const params = args.map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a))
  const placeholders = args.map((a, i) => (a !== null && typeof a === 'object' ? `$${i + 1}::text::jsonb` : `$${i + 1}`)).join(', ')
  return (await c.query(`select public.${fn}(${placeholders}) as r`, params)).rows[0].r as Json
}
const rpc = (fn: string, args: unknown[]) => rpcOn(db, fn, args)
async function one<T = Json>(text: string, params: unknown[] = []): Promise<T> {
  return (await db.query(text, params)).rows[0] as T
}

const start = (o: { maxLive?: number } = {}) =>
  rpc('studio_builder_start', [
    PROF_B, B.institution, B.section, null, `tool-${randomBytes(4).toString('hex')}`, MARK, 'Build flashcards', randomUUID(), null,
    1000, o.maxLive ?? 1000, 1_000_000,
  ])
const startRun = async () => String((await start()).run_id)
async function claim(runId: string): Promise<string | null> {
  const r = await one<{ job_id: string; slice_no: number }>('select job_id, slice_no from public.studio_plugin_builder_runs where id = $1', [runId])
  const out = await rpc('studio_builder_claim', [runId, r.job_id, Number(r.slice_no), STALE, RESUMES])
  return (out.token as string | null) ?? null
}
const runRow = (id: string) => one('select * from public.studio_plugin_builder_runs where id = $1', [id])
const jobOf = async (runId: string) => one<{ id: string; status: string; params: Json }>('select j.id, j.status, j.params from public.background_jobs j join public.studio_plugin_builder_runs r on r.job_id = j.id where r.id = $1', [runId])
/** The slice stops heartbeating: its instance died. */
const stale = (runId: string) =>
  db.query("update public.studio_plugin_builder_runs set heartbeat_at = now() - interval '5 minutes' where id = $1", [runId])
/** What the worker or the kick's reaper writes on the run's current job. */
const setJob = (runId: string, status: string) =>
  db.query('update public.background_jobs set status = $2 where id = (select job_id from public.studio_plugin_builder_runs where id = $1)', [runId, status])
const sweepOn = (c: Client, limit = 100_000) => rpcOn(c, 'studio_builder_sweep', [STALE, RESUMES, limit])
const sweep = (limit?: number) => sweepOn(db, limit)
const tend = (runId: string, owner = PROF_B) => rpc('studio_builder_tend', [runId, owner, STALE, RESUMES])
const counts = (r: Json) => ({ none: r.none, expired: r.expired, requeued: r.requeued, failed: r.failed, cancelled: r.cancelled })
const only = (outcome: string, n = 1) => ({ none: 0, expired: 0, requeued: 0, failed: 0, cancelled: 0, [outcome]: n })
const NOTHING = only('none', 0)
const toolStep = (id: string) => ({ kind: 'tool', tool: 'read_file', tool_call_id: id, status: 'done', label: 'file.read' })
const work = (rev: number) => ({ work_rev: rev, manifest: null, files: {}, working_set: [], changed: [], kit_refs: [], last_check: null, streaks: {}, delta: { approved: [], declined: [], direct: [] } })
const applyOn = (c: Client, runId: string, token: string, step: Json) => rpcOn(c, 'studio_builder_apply', [runId, token, step, 0, null, null, null, { tool_calls: 1 }, CAPS, 0])
const seedWork = (runId: string, token: string) =>
  rpc('studio_builder_apply', [runId, token, { kind: 'system', tool_call_id: 'sys:work', status: 'done', label: 'run.slice' }, -1, work(0), null, null, {}, CAPS, 0])
const ask = (runId: string, token: string) =>
  rpc('studio_builder_pause', [runId, token, { ...toolStep('9.0'), tool: 'ask_professor', label: 'question.asked' }, [], null, { id: randomUUID(), question: 'Which week?', answer: null }, {}, CAPS, STUDIO_BUILDER_WAITING_TTL_MS, 0])
const rows = async (ids: string[]) => {
  const out: Json[] = []
  for (const id of ids) out.push(await runRow(id))
  return out
}
const liveRuns = async () => Number((await one<{ n: string }>("select count(*) as n from public.studio_plugin_builder_runs where institution_id = $1 and status in ('queued', 'running')", [B.institution])).n)

/** Runs `fn` in a transaction, after sweeping everything already stalled, and rolls it back. */
async function rolledBack(fn: () => Promise<void>) {
  await db.query('begin')
  try {
    await sweep()
    expect(counts(await sweep())).toEqual(NOTHING)
    await fn()
  } finally {
    await db.query('rollback')
  }
}
/** Inside rolledBack: removes every run and spend row school B's caps would count. */
const clearRuns = async () => {
  await db.query('delete from public.studio_plugin_builder_runs where institution_id = $1', [B.institution])
  await db.query('delete from public.studio_plugin_builder_spend where institution_id = $1', [B.institution])
}

async function cleanup() {
  const { rows } = await db.query('select id from public.studio_plugin_projects where name = $1 and owner_id = $2', [MARK, PROF_B])
  for (const { id } of rows as { id: string }[]) await db.query('delete from public.studio_plugin_projects where id = $1', [id])
  await db.query(
    `delete from public.background_jobs where type = 'studio_builder_slice' and institution_id = $1
       and not exists (select 1 from public.studio_plugin_builder_runs r where r.id::text = params ->> 'runId')`,
    [B.institution],
  )
}

beforeAll(async () => {
  const env = dbEnv()
  db = new Client({ connectionString: env.pgUrl })
  await db.connect()
  await cleanup()
})

afterAll(async () => {
  if (!db) return
  await cleanup()
  await db.end()
})

describe('the sweep recovers a build whose worker died', () => {
  it('requeues it as a new slice the drain can claim; the old slice’s writes are refused', async () => {
    await rolledBack(async () => {
      const runId = await startRun()
      const old = (await claim(runId))!
      await setJob(runId, 'running')
      // The instance dies; the kick's reaper later fails its exhausted job.
      await stale(runId)
      await setJob(runId, 'failed')
      const before = await jobOf(runId)

      const swept = await sweep()
      expect(counts(swept)).toEqual(only('requeued'))
      const job = await jobOf(runId)
      expect(swept.job_ids).toEqual([job.id])
      expect(job).toMatchObject({ status: 'pending', params: { runId, sliceNo: 2 } })
      expect(job.id).not.toBe(before.id)
      expect(await runRow(runId)).toMatchObject({ status: 'queued', slice_no: 2, resume_count: 1, claim_token: null, heartbeat_at: null })

      expect(await applyOn(db, runId, old, toolStep('1.0'))).toEqual({ ok: false, reason: 'fence' })
      const next = await claim(runId)
      expect(next).toBeTruthy()
      expect(next).not.toBe(old)
      expect(await applyOn(db, runId, old, toolStep('1.1'))).toEqual({ ok: false, reason: 'fence' })
    })
  })

  it('requeues a running build whose job finished or failed even with a fresh heartbeat, and a queued one whose job failed', async () => {
    await rolledBack(async () => {
      const running = await startRun()
      await claim(running)
      await setJob(running, 'done')
      const queued = await startRun()
      await setJob(queued, 'failed')
      expect(counts(await sweep())).toEqual(only('requeued', 2))
      for (const id of [running, queued]) expect(await runRow(id)).toMatchObject({ status: 'queued', slice_no: 2, resume_count: 1 })
    })
  })

  it('at the resume limit fails it as interrupted, which frees the school’s live slot for a start that was refused', async () => {
    await rolledBack(async () => {
      await clearRuns()
      const runs: string[] = []
      for (let i = 0; i < LIVE_RUNS; i++) runs.push(String((await start({ maxLive: LIVE_RUNS })).run_id))
      expect(await start({ maxLive: LIVE_RUNS })).toEqual({ outcome: 'limit_live_runs' })
      const dead = runs[0]
      for (let resume = 1; resume <= RESUMES; resume++) {
        expect(await claim(dead)).toBeTruthy()
        await stale(dead)
        expect(counts(await sweep())).toEqual(only('requeued'))
        // A requeued build is still live: the slot stays taken.
        expect(await start({ maxLive: LIVE_RUNS })).toEqual({ outcome: 'limit_live_runs' })
      }
      expect(await claim(dead)).toBeTruthy()
      await stale(dead)
      expect(counts(await sweep())).toEqual(only('failed'))
      expect(await runRow(dead)).toMatchObject({ status: 'failed', error_code: 'interrupted', claim_token: null, work: null })
      expect(await liveRuns()).toBe(LIVE_RUNS - 1)
      expect((await start({ maxLive: LIVE_RUNS })).outcome).toBe('started')
    })
  })

  it('cancels a stalled build whose professor pressed Stop, and frees its slot', async () => {
    await rolledBack(async () => {
      await clearRuns()
      const runs: string[] = []
      for (let i = 0; i < LIVE_RUNS; i++) runs.push(String((await start({ maxLive: LIVE_RUNS })).run_id))
      await claim(runs[0])
      await setJob(runs[0], 'running')
      expect((await rpc('studio_builder_stop', [runs[0], PROF_B, STALE])).outcome).toBe('requested')
      expect(counts(await sweep())).toEqual(NOTHING)
      // The slice died before it saw the Stop.
      await stale(runs[0])
      expect(counts(await sweep())).toEqual(only('cancelled'))
      expect(await runRow(runs[0])).toMatchObject({ status: 'cancelled', error_code: null, claim_token: null })
      expect((await start({ maxLive: LIVE_RUNS })).outcome).toBe('started')
    })
  })
})

describe('the sweep leaves alone what isn’t stalled', () => {
  it('a healthy running build, a queued build whose job is pending or just claimed, and a finished build', async () => {
    await rolledBack(async () => {
      const healthy = await startRun()
      const token = await claim(healthy)
      await setJob(healthy, 'running')
      const pending = await startRun()
      const claimed = await startRun()
      await setJob(claimed, 'running')
      const finished = await startRun()
      expect((await rpc('studio_builder_stop', [finished, PROF_B, STALE])).outcome).toBe('cancelled')
      // A finished build with every stalled sign: no claim, an old heartbeat, a failed job.
      await stale(finished)
      await setJob(finished, 'failed')
      const ids = [healthy, pending, claimed, finished]
      const before = await rows(ids)

      expect(counts(await sweep())).toEqual(NOTHING)
      expect(await rows(ids)).toEqual(before)
      expect(await runRow(healthy)).toMatchObject({ status: 'running', claim_token: token })
    })
  })

  it('a waiting build is untouched until its card expires, then cancelled as expired', async () => {
    await rolledBack(async () => {
      const runId = await startRun()
      const token = (await claim(runId))!
      await seedWork(runId, token)
      expect((await ask(runId, token)).ok).toBe(true)
      // Waiting holds no claim and no heartbeat; it is not stalled until it expires.
      expect(counts(await sweep())).toEqual(NOTHING)
      expect((await runRow(runId)).status).toBe('waiting_for_professor')
      await db.query("update public.studio_plugin_builder_runs set waiting_until = now() - interval '1 minute' where id = $1", [runId])
      expect(counts(await sweep())).toEqual(only('expired'))
      expect(await runRow(runId)).toMatchObject({ status: 'cancelled', error_code: 'expired', waiting_until: null })
    })
  })

  it('tends at most the limit per call; the rest wait for the next', async () => {
    await rolledBack(async () => {
      for (const id of [await startRun(), await startRun()]) await setJob(id, 'failed')
      expect(counts(await sweep(1))).toEqual(only('requeued'))
      expect(counts(await sweep(1))).toEqual(only('requeued'))
      expect(counts(await sweep(1))).toEqual(NOTHING)
    })
  })
})

describe('the sweep and a live lock', () => {
  it.skipIf(ON_PGLITE)('skips a run another transaction holds instead of waiting on it, and tends it once released', async () => {
    await cleanup()
    const holder = new Client({ connectionString: dbEnv().pgUrl })
    await holder.connect()
    try {
      const runId = await startRun()
      await claim(runId)
      await stale(runId)
      await holder.query('begin')
      await holder.query('select 1 from public.studio_plugin_builder_runs where id = $1 for update', [runId])
      await db.query('begin')
      try {
        // Waiting on the row would hit this and fail the call.
        await db.query("set local lock_timeout = '2s'")
        await sweep()
        expect((await runRow(runId)).status).toBe('running')
        await holder.query('rollback')
        expect(counts(await sweep())).toEqual(only('requeued'))
        expect((await runRow(runId)).status).toBe('queued')
      } finally {
        await db.query('rollback')
      }
    } finally {
      await holder.query('rollback').catch(() => undefined)
      await holder.end()
      await cleanup()
    }
  })
})

describe('the owner’s progress read', () => {
  it('tends only the owner’s own run, with the same outcomes as before', async () => {
    await rolledBack(async () => {
      const runId = await startRun()
      await claim(runId)
      await stale(runId)
      const before = await runRow(runId)
      expect(await tend(runId, PROF_A)).toEqual({ outcome: 'none' })
      expect(await tend(randomUUID())).toEqual({ outcome: 'none' })
      expect(await runRow(runId)).toEqual(before)
      const tended = await tend(runId)
      expect(tended).toEqual({ outcome: 'requeued', job_id: (await jobOf(runId)).id })
      expect(await tend(runId)).toEqual({ outcome: 'none' })

      const token = (await claim(runId))!
      await seedWork(runId, token)
      expect((await ask(runId, token)).ok).toBe(true)
      expect(await tend(runId)).toEqual({ outcome: 'none' })
      await db.query("update public.studio_plugin_builder_runs set waiting_until = now() - interval '1 minute' where id = $1", [runId])
      expect(await tend(runId, PROF_A)).toEqual({ outcome: 'none' })
      expect(await tend(runId)).toEqual({ outcome: 'expired' })

      const stopped = await startRun()
      await claim(stopped)
      await setJob(stopped, 'running')
      expect((await rpc('studio_builder_stop', [stopped, PROF_B, STALE])).outcome).toBe('requested')
      await stale(stopped)
      expect(await tend(stopped)).toEqual({ outcome: 'cancelled' })
    })
  })

  it('no client role, and not even service_role, may call the internal tend body', async () => {
    const fn = 'public.studio_builder_tend_run(uuid, integer, integer)'
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await one<{ ok: boolean }>('select has_function_privilege($1, $2, $3) as ok', [role, fn, 'execute'])).ok).toBe(false)
    }
    for (const f of ['public.studio_builder_sweep(integer, integer, integer)', 'public.studio_builder_tend(uuid, uuid, integer, integer)']) {
      for (const role of ['anon', 'authenticated']) {
        expect((await one<{ ok: boolean }>('select has_function_privilege($1, $2, $3) as ok', [role, f, 'execute'])).ok).toBe(false)
      }
      expect((await one<{ ok: boolean }>('select has_function_privilege($1, $2, $3) as ok', ['service_role', f, 'execute'])).ok).toBe(true)
    }
  })
})
