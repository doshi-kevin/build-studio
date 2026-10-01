// Tests for Athena per-model daily rate limiting (Issue #268).
//
// The load-bearing guarantee is CONCURRENCY SAFETY: two (or many) accepted sends
// racing must never push a model past its cap. Real atomicity lives in the DB
// (the athena_increment_rate_limit RPC's single guarded INSERT … ON CONFLICT …
// DO UPDATE … WHERE). Here we model that RPC as an atomic check-and-increment
// (a synchronous body with NO await — JS single-threading makes it indivisible,
// exactly like one SQL statement) and prove reserveAthenaSlot:
//   (a) only ever increments the model that ACCEPTS,
//   (b) respects the accept/reject verdict and fails over,
//   (c) never lets a model's count exceed its cap under heavy concurrency.
// A non-atomic reserve (read → await → write) would over-count against this fake
// and fail these tests.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { reserveAthenaSlot, getAthenaUsageStatus } from '@/lib/ai/professor-assistant/rate-limit'
import {
  ATHENA_LIMIT_SCOPES,
  ATHENA_MODELS,
  computeModelUsage,
  percentRemaining,
  failoverCandidates,
  resolveAthenaModelDef,
  type AthenaLimitScope,
  type AthenaModelId,
} from '@/lib/ai/professor-assistant/models'
import { resolveAthenaLimitScope } from '@/lib/ai/assignment-assistant/context'
import { computeCostUsd } from '@/lib/ai/cost'

const PRO = ATHENA_MODELS.find((m) => m.id === 'gemini-pro')!
const FLASH = ATHENA_MODELS.find((m) => m.id === 'gemini-flash')!

interface FakeRow {
  institution_id: string
  user_id: string
  scope: string
  model_id: string
  request_count: number
  window_start: string
}

/**
 * In-memory stand-in for the admin Supabase client. `rpc` models
 * athena_increment_rate_limit as an ATOMIC check-and-increment (no await inside,
 * so concurrent callers can't interleave mid-mutation). `from(...).select().eq().eq()`
 * is a thenable that returns the user's rows (for getAthenaUsageStatus).
 */
function makeFakeDb() {
  const rows = new Map<string, FakeRow>()
  // Mirrors the athena_rate_limits_unique constraint: the pool is per SURFACE, so
  // scope is part of the row's identity, not a filter applied afterwards.
  const key = (i: string, u: string, s: string, m: string) => `${i}|${u}|${s}|${m}`

  return {
    rows,
    seed(
      inst: string,
      user: string,
      model: string,
      count: number,
      windowStart = new Date().toISOString(),
      scope = 'console',
    ) {
      rows.set(key(inst, user, scope, model), {
        institution_id: inst,
        user_id: user,
        scope,
        model_id: model,
        request_count: count,
        window_start: windowStart,
      })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rpc(name: string, args: any) {
      if (name !== 'athena_increment_rate_limit') throw new Error(`unexpected rpc: ${name}`)
      const k = key(args.p_institution_id, args.p_user_id, args.p_scope, args.p_model_id)
      const now = Date.now()
      const windowMs = args.p_window_hours * 3_600_000
      const row = rows.get(k)

      if (!row) {
        const created: FakeRow = {
          institution_id: args.p_institution_id,
          user_id: args.p_user_id,
          scope: args.p_scope,
          model_id: args.p_model_id,
          request_count: 1,
          window_start: new Date(now).toISOString(),
        }
        rows.set(k, created)
        return { data: [{ accepted: true, request_count: 1, window_start: created.window_start }], error: null }
      }

      const lapsed = now - new Date(row.window_start).getTime() >= windowMs
      if (lapsed) {
        row.request_count = 1
        row.window_start = new Date(now).toISOString()
        return { data: [{ accepted: true, request_count: 1, window_start: row.window_start }], error: null }
      }
      if (row.request_count < args.p_cap) {
        row.request_count += 1
        return { data: [{ accepted: true, request_count: row.request_count, window_start: row.window_start }], error: null }
      }
      return { data: [{ accepted: false, request_count: row.request_count, window_start: row.window_start }], error: null }
    },
    from() {
      let inst = ''
      let usr = ''
      let scope = ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: string) => {
          if (col === 'institution_id') inst = val
          if (col === 'user_id') usr = val
          if (col === 'scope') scope = val
          return builder
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (resolve: (v: any) => void) => {
          const data = [...rows.values()]
            .filter((r) => r.institution_id === inst && r.user_id === usr && r.scope === scope)
            .map((r) => ({ model_id: r.model_id, request_count: r.request_count, window_start: r.window_start }))
          resolve({ data, error: null })
        },
      }
      return builder
    },
  }
}

const INST = 'inst-1'
const USER = 'prof-1'
const reserve = (
  db: ReturnType<typeof makeFakeDb>,
  preferred: AthenaModelId = 'gemini-pro',
  scope: AthenaLimitScope = 'console',
) => reserveAthenaSlot(db, { institutionId: INST, userId: USER, scope, preferredModelId: preferred })

describe('reserveAthenaSlot — concurrency safety', () => {
  it('two concurrent sends at the boundary cannot BOTH land on the capped model', async () => {
    const db = makeFakeDb()
    db.seed(INST, USER, 'gemini-pro', PRO.dailyCap - 1) // one slot left on Pro

    const [a, b] = await Promise.all([reserve(db), reserve(db)])

    // Exactly one took the last Pro slot; the other failed over to Flash.
    expect(a.accepted && b.accepted).toBe(true)
    expect(db.rows.get(`${INST}|${USER}|console|gemini-pro`)!.request_count).toBe(PRO.dailyCap) // never cap+1
    expect(db.rows.get(`${INST}|${USER}|console|gemini-flash`)!.request_count).toBe(1)
    const used = [a, b].map((r) => (r.accepted ? r.modelDef.id : null))
    expect(used.sort()).toEqual(['gemini-flash', 'gemini-pro'])
  })

  it('heavy concurrency never pushes any model past its cap', async () => {
    const db = makeFakeDb()
    const total = PRO.dailyCap + FLASH.dailyCap + 25 // oversubscribe past both caps
    const results = await Promise.all(Array.from({ length: total }, () => reserve(db)))

    const proCount = db.rows.get(`${INST}|${USER}|console|gemini-pro`)!.request_count
    const flashCount = db.rows.get(`${INST}|${USER}|console|gemini-flash`)!.request_count

    expect(proCount).toBe(PRO.dailyCap) // exactly the cap — never exceeded
    expect(flashCount).toBe(FLASH.dailyCap)
    expect(proCount).toBeLessThanOrEqual(PRO.dailyCap)
    expect(flashCount).toBeLessThanOrEqual(FLASH.dailyCap)

    const accepted = results.filter((r) => r.accepted).length
    const rejected = results.filter((r) => !r.accepted).length
    expect(accepted).toBe(PRO.dailyCap + FLASH.dailyCap) // counter == ledger: one accept per increment
    expect(rejected).toBe(25)
  })

  it('blocks with a structured resets_at when every model is exhausted', async () => {
    const db = makeFakeDb()
    const start = new Date(Date.now() - 60_000).toISOString() // 1 min into the window
    db.seed(INST, USER, 'gemini-pro', PRO.dailyCap, start)
    db.seed(INST, USER, 'gemini-flash', FLASH.dailyCap, start)

    const res = await reserve(db)
    expect(res.accepted).toBe(false)
    if (!res.accepted) {
      expect(res.resetsAt).toBeTruthy()
      expect(new Date(res.resetsAt!).getTime()).toBeGreaterThan(Date.now()) // ~window from window_start
    }
    // No counter moved past its cap on a rejected send.
    expect(db.rows.get(`${INST}|${USER}|console|gemini-pro`)!.request_count).toBe(PRO.dailyCap)
  })

  it('honors the preferred model when it has budget (no needless failover)', async () => {
    const db = makeFakeDb()
    const res = await reserve(db, 'gemini-flash')
    expect(res.accepted && res.modelDef.id).toBe('gemini-flash')
    expect(db.rows.has(`${INST}|${USER}|console|gemini-pro`)).toBe(false) // Pro untouched
  })
})

describe('ATHENA_LIMIT_SCOPES stays in sync with the DB CHECK constraint', () => {
  // Why this test exists: the desync fails OPEN, silently.
  //
  // Add a scope in TypeScript without adding it to athena_rate_limits_scope_check
  // and the insert violates the constraint → supabase-js returns an `error` rather
  // than throwing → reserveAthenaSlot deliberately fails open and ACCEPTS → the new
  // surface has NO rate limit at all, with nothing on screen and only a log line.
  // That is exactly the outcome this whole feature exists to prevent, and lint,
  // typecheck and the full unit suite would all stay green through it.
  //
  // It is also reachable through normal ops: migrations reach prod via the Supabase
  // MCP separately from the Cloud Run deploy, so shipping code with a new scope
  // before applying its migration produces the same uncapped pool.
  //
  // Same shape as frontier-mode-migration.test.ts, added after a comparable bug.
  it('the CHECK constraint lists exactly the scopes the code knows about', () => {
    /* Reads the LATEST migration that defines the constraint rather than a
       hardcoded filename: the constraint gets widened each time a surface is
       added (tutor was the first), and pinning one file means this guard silently
       checks a superseded definition from then on. Migration names are timestamp
       -prefixed, so lexical order is chronological. */
    /* Both conditions, because `scope` is not a unique column name:
       discussion_channels already carries its own CHECK (scope IN ('course',
       'team')). Matching on the constraint shape alone, the next migration to
       touch ANY table's scope check becomes the newest match and this guard
       starts comparing ATHENA_LIMIT_SCOPES against that other table's values. */
    const dir = join(process.cwd(), 'supabase/migrations')
    const defining = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => {
        const sql = readFileSync(join(dir, f), 'utf8')
        return /check\s*\(scope in \(/i.test(sql) && /athena_rate_limits/i.test(sql)
      })

    expect(defining.length, 'no migration defines athena_rate_limits_scope_check').toBeGreaterThan(0)

    const sql = readFileSync(join(dir, defining[defining.length - 1]), 'utf8')
    const check = sql.match(/check\s*\(scope in \(([^)]*)\)\)/i)
    expect(check, 'athena_rate_limits_scope_check not found in the migration').toBeTruthy()

    const inMigration = [...check![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    expect(inMigration).toEqual([...ATHENA_LIMIT_SCOPES].sort())
  })
})

describe('scope isolation — one pool per Athena surface', () => {
  it('exhausting one surface leaves every other surface at full budget', async () => {
    const db = makeFakeDb()

    // Drain the assignment pool completely: both models, right up to their caps.
    const drain = FLASH.dailyCap + PRO.dailyCap
    const drained = await Promise.all(
      Array.from({ length: drain }, () => reserve(db, 'gemini-flash', 'assignment')),
    )
    expect(drained.every((r) => r.accepted)).toBe(true)

    // One more on that surface is refused — the pool really is spent.
    const overflow = await reserve(db, 'gemini-flash', 'assignment')
    expect(overflow.accepted).toBe(false)

    // The whole point: the other three surfaces are untouched.
    for (const scope of ['quiz', 'grade', 'console'] as const) {
      const res = await reserve(db, 'gemini-flash', scope)
      expect(res.accepted, `${scope} should still have budget`).toBe(true)
      if (res.accepted) expect(res.modelDef.id).toBe('gemini-flash') // fresh pool, no failover
    }

    // And the refused turn moved no counter anywhere.
    expect(db.rows.get(`${INST}|${USER}|assignment|gemini-flash`)!.request_count).toBe(FLASH.dailyCap)
    expect(db.rows.get(`${INST}|${USER}|assignment|gemini-pro`)!.request_count).toBe(PRO.dailyCap)
    expect(db.rows.get(`${INST}|${USER}|quiz|gemini-flash`)!.request_count).toBe(1)
  })

  it('reports usage for the asked-for surface only', async () => {
    const db = makeFakeDb()
    const start = new Date(Date.now() - 60_000).toISOString()
    db.seed(INST, USER, 'gemini-flash', FLASH.dailyCap, start, 'quiz')
    db.seed(INST, USER, 'gemini-pro', PRO.dailyCap, start, 'quiz')

    const quiz = await getAthenaUsageStatus(db, { institutionId: INST, userId: USER, scope: 'quiz' })
    expect(quiz.models.every((m) => m.exhausted)).toBe(true)
    expect(quiz.resets_at).toBeTruthy()

    // The assignment pool has no rows at all — it must read as untouched, not as
    // "whatever the quiz pool says".
    const assignment = await getAthenaUsageStatus(db, {
      institutionId: INST,
      userId: USER,
      scope: 'assignment',
    })
    expect(assignment.models.every((m) => m.used === 0)).toBe(true)
    expect(assignment.models.some((m) => m.exhausted)).toBe(false)
    expect(assignment.resets_at).toBeNull()
  })
})

describe('resolveAthenaLimitScope — which pool a turn is charged to', () => {
  const SECTION = 'sec-1'

  /**
   * Minimal admin-client stand-in holding one quiz row. It HONOURS the `.eq()`
   * filters rather than ignoring them, so the section scoping is genuinely
   * asserted — a fake that swallowed `.eq('section_id', …)` would pass even if
   * the production filter were deleted.
   */
  const dbWith = (
    quiz: { id: string; section_id: string } | null,
    error: unknown = null,
  ) => ({
    from: (table: string) => {
      if (table !== 'quizzes') throw new Error(`unexpected table: ${table}`)
      const filters: Record<string, string> = {}
      const builder = {
        select: () => builder,
        eq: (col: string, val: string) => {
          filters[col] = val
          return builder
        },
        maybeSingle: async () => {
          if (error) return { data: null, error }
          const hit =
            quiz &&
            (filters.id === undefined || filters.id === quiz.id) &&
            (filters.section_id === undefined || filters.section_id === quiz.section_id)
          return { data: hit ? quiz : null, error: null }
        },
      }
      return builder
    },
  })

  const dbWhere = (quizExists: boolean, error: unknown = null) =>
    dbWith(quizExists ? { id: 'q1', section_id: SECTION } : null, error)

  it('charges the grade pool whenever the surface is grading', async () => {
    // Even though the subject IS a quiz, grading is its own pool.
    const scope = await resolveAthenaLimitScope(dbWhere(true), {
      sectionId: SECTION,
      surface: 'grade',
      kind: 'quiz',
      assignmentId: 'q1',
    })
    expect(scope).toBe('grade')
  })

  it('believes the database, not the client, about quiz vs assignment', async () => {
    // The tamper case: client claims 'quiz' while authoring a real assignment.
    // Charging the quiz pool here would hand them a fresh budget for free.
    const spoofed = await resolveAthenaLimitScope(dbWhere(false), {
      sectionId: SECTION,
      surface: 'authoring',
      kind: 'quiz',
      assignmentId: 'a1',
    })
    expect(spoofed).toBe('assignment')

    // ...and the mirror: a real quiz is charged to the quiz pool even if the
    // client understates the kind.
    const real = await resolveAthenaLimitScope(dbWhere(true), {
      sectionId: SECTION,
      surface: 'authoring',
      kind: 'notebook',
      assignmentId: 'q1',
    })
    expect(real).toBe('quiz')
  })

  it('only counts a quiz that lives in the VERIFIED section', async () => {
    // A real quiz id, but from somewhere else. It must not route to the quiz pool —
    // otherwise which pool responds becomes an oracle for "does this id exist?".
    const foreign = await resolveAthenaLimitScope(
      dbWith({ id: 'q-elsewhere', section_id: 'some-other-section' }),
      { sectionId: SECTION, surface: 'authoring', kind: 'quiz', assignmentId: 'q-elsewhere' },
    )
    expect(foreign).toBe('assignment')
  })

  it('charges the About pool ahead of the subject lookup, and never mid-turn', async () => {
    // The About page has no subject row, so the claimed kind decides — but the
    // check must sit ABOVE the assignmentId branch. Moved below it, a forged
    // assignmentId would divert an About turn into the quiz/assignment pool
    // (which is exactly the mislabeling QA caught on the ledger side).
    const about = await resolveAthenaLimitScope(dbWhere(true), {
      sectionId: SECTION,
      surface: 'authoring',
      kind: 'about',
      assignmentId: 'q1',
    })
    expect(about).toBe('about')

    // ...but grading still wins over it: the About kind is an authoring kind.
    const grading = await resolveAthenaLimitScope(dbWhere(false), {
      sectionId: SECTION,
      surface: 'grade',
      kind: 'about',
      assignmentId: undefined,
    })
    expect(grading).toBe('grade')
  })

  it('falls back to the claimed kind only when there is nothing saved to check', async () => {
    const unsavedQuiz = await resolveAthenaLimitScope(dbWhere(false), {
      sectionId: SECTION,
      surface: 'authoring',
      kind: 'quiz',
      assignmentId: undefined,
    })
    expect(unsavedQuiz).toBe('quiz')

    const unsavedAssignment = await resolveAthenaLimitScope(dbWhere(false), {
      sectionId: SECTION,
      surface: 'authoring',
      kind: undefined,
      assignmentId: undefined,
    })
    expect(unsavedAssignment).toBe('assignment')
  })

  it('degrades to the claimed kind rather than failing the turn when the lookup errors', async () => {
    const scope = await resolveAthenaLimitScope(dbWhere(false, new Error('boom')), {
      sectionId: SECTION,
      surface: 'authoring',
      kind: 'quiz',
      assignmentId: 'q1',
    })
    expect(scope).toBe('quiz')
  })
})

describe('getAthenaUsageStatus', () => {
  it('reports exhausted + nearing per model and the earliest reset', async () => {
    const db = makeFakeDb()
    const start = new Date(Date.now() - 3_600_000).toISOString() // 1h ago
    db.seed(INST, USER, 'gemini-pro', PRO.dailyCap, start) // exhausted
    db.seed(INST, USER, 'gemini-flash', Math.ceil(FLASH.dailyCap * 0.8), start) // nearing

    const status = await getAthenaUsageStatus(db, { institutionId: INST, userId: USER, scope: 'console' })
    const pro = status.models.find((m) => m.id === 'gemini-pro')!
    const flash = status.models.find((m) => m.id === 'gemini-flash')!

    expect(pro.exhausted).toBe(true)
    expect(flash.exhausted).toBe(false)
    expect(flash.nearing).toBe(true)
    expect(status.resets_at).toBeTruthy()
  })

  it('treats a lapsed window as 0 used (limits reset automatically)', async () => {
    const db = makeFakeDb()
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString() // > 24h ago
    db.seed(INST, USER, 'gemini-pro', PRO.dailyCap, old)

    const status = await getAthenaUsageStatus(db, { institutionId: INST, userId: USER, scope: 'console' })
    const pro = status.models.find((m) => m.id === 'gemini-pro')!
    expect(pro.used).toBe(0)
    expect(pro.exhausted).toBe(false)
    expect(status.resets_at).toBeNull() // nothing exhausted
  })
})

describe('pure registry helpers', () => {
  it('computeModelUsage derives remaining/nearing/exhausted from the cap', () => {
    const u = computeModelUsage(PRO, PRO.dailyCap) // fully used
    expect(u).toMatchObject({ remaining: 0, nearing: true, exhausted: true })
    const mid = computeModelUsage(PRO, Math.floor(PRO.dailyCap * 0.5))
    expect(mid.nearing).toBe(false)
    expect(mid.exhausted).toBe(false)
  })

  it('percentRemaining returns a clamped percentage (never a raw count)', () => {
    expect(percentRemaining(computeModelUsage(PRO, 0))).toBe(100)
    expect(percentRemaining(computeModelUsage(PRO, PRO.dailyCap))).toBe(0)
    // 24/30 used → 6 left → 20%
    expect(percentRemaining(computeModelUsage(PRO, 24))).toBe(20)
  })

  it('failoverCandidates puts the preferred model first, works for N models', () => {
    const order = failoverCandidates('gemini-flash').map((m) => m.id)
    expect(order[0]).toBe('gemini-flash')
    expect(order).toHaveLength(ATHENA_MODELS.length)
    expect(new Set(order).size).toBe(ATHENA_MODELS.length) // every model exactly once
  })
})

describe('Pro cost-rate fix', () => {
  it("prices the Pro model on its OWN rate row (not the Flash fallback)", () => {
    const proModel = resolveAthenaModelDef('gemini-pro').model
    // 1M output tokens: Pro is $12, Flash is $2.5 — must differ now.
    const proCost = computeCostUsd(proModel, { outputTokens: 1_000_000 })
    expect(proCost).toBe(12)
    expect(proCost).not.toBe(computeCostUsd('gemini-3-flash-preview', { outputTokens: 1_000_000 }))
  })
})
