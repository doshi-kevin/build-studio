/**
 * updateProgram's stale-write guard (#724).
 *
 * Courses and departments push their guard down into the shared query helpers
 * (queries-optimistic-concurrency.test.ts covers those); updateProgram builds the
 * statement inline, so its guard is a third, hand-written copy — and the only one
 * where the WHERE clause is assembled in the action itself. That is what these
 * tests inspect: the recorded `.eq()` calls on the update chain, because the guard
 * is only a guard if it reaches the statement.
 *
 * The nastiest failure mode here is silent in both directions:
 *   - forget the `.eq('updated_at', …)` and the action still succeeds, having
 *     quietly stopped being concurrency-safe;
 *   - apply it unconditionally and an un-guarded caller sends
 *     `updated_at=eq.undefined`, which matches zero rows — so every edit from a
 *     form that doesn't pass the timestamp starts reporting a phantom conflict.
 * Neither shows up as an error, so both are pinned below.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockVerifyAdmin = vi.fn()
const mockGetByCode = vi.fn()
const mockLogEvent = vi.fn()

const PROGRAM_A = 'prog-A'
const DEPT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STAMP = '2026-08-20T12:00:00.000Z'
const DIRECTOR_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const DIRECTOR_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

/** table -> row id -> institution_id, consumed by the real assertTenantOwns. */
let tenantData: Record<string, Record<string, string>> = {}
/** What the update statement resolves to — the lever for conflict vs error. */
let updateResult: { data: unknown; error: unknown }
/** Every `.eq()` applied to the UPDATE chain, in order. The WHERE clause. */
let updateWhere: Array<[string, unknown]>
/** Rows handed to insert() — empty means createProgram never reached the write. */
let inserted: unknown[]
let insertResult: { data: unknown; error: unknown }

/* One fake client serving two shapes off the same chain: assertTenantOwns'
   select/eq/maybeSingle, and update/eq…/select/maybeSingle. `update()` having been
   called is what tells them apart. */
function makeAdminDb() {
  return {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      let isUpdate = false
      let isInsert = false
      let rowId = ''
      chain.select = () => chain
      chain.update = () => {
        isUpdate = true
        return chain
      }
      chain.insert = (row: unknown) => {
        inserted.push(row)
        isInsert = true
        return chain
      }
      chain.single = async () => (isInsert ? insertResult : updateResult)
      chain.eq = (col: string, val: unknown) => {
        if (isUpdate) updateWhere.push([col, val])
        if (col === 'id') rowId = String(val)
        return chain
      }
      chain.maybeSingle = async () => {
        if (isUpdate) return updateResult
        const inst = tenantData[table]?.[rowId]
        return inst ? { data: { institution_id: inst }, error: null } : { data: null, error: null }
      }
      return chain
    },
  }
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: vi.fn() } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeAdminDb() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }))
vi.mock('@/lib/auth/admin-context', () => ({
  verifyInstitutionAdmin: (...a: unknown[]) => mockVerifyAdmin(...a),
}))
vi.mock('@/lib/supabase/queries', () => ({
  programQueries: {
    getByCode: (...a: unknown[]) => mockGetByCode(...a),
    remove: vi.fn(),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let updateProgram: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createProgram: any

beforeEach(async () => {
  vi.resetModules()
  mockVerifyAdmin.mockReset().mockResolvedValue({ userId: 'admin-A', institutionId: 'inst-A' })
  mockGetByCode.mockReset().mockResolvedValue(null)
  mockLogEvent.mockReset()
  tenantData = {
    programs: { [PROGRAM_A]: 'inst-A', 'prog-B': 'inst-B' },
    departments: { [DEPT_A]: 'inst-A' },
    /* Two professors, one per tenant. The foreign one is the whole point: a
       director_id is client-supplied, so nothing stops an admin naming it. */
    profiles: { [DIRECTOR_A]: 'inst-A', [DIRECTOR_B]: 'inst-B' },
  }
  updateResult = { data: { id: PROGRAM_A, name: 'BS Computer Science' }, error: null }
  insertResult = { data: { id: 'prog-new', name: 'BS Computer Science' }, error: null }
  updateWhere = []
  inserted = []

  const mod = await import('@/app/(dashboard)/admin/programs/actions')
  updateProgram = mod.updateProgram
  createProgram = mod.createProgram
})

/** Column names in the update's WHERE clause. */
const whereCols = () => updateWhere.map(([col]) => col)

describe('updateProgram — stale-write guard (#724)', () => {
  it('puts expectedUpdatedAt in the WHERE clause so a stale write matches zero rows', async () => {
    const res = await updateProgram(PROGRAM_A, { name: 'BS Computer Science' }, STAMP)

    expect(res.success).toBe(true)
    /* Not "the action was called with a timestamp" — the timestamp has to reach the
       statement. Compared atomically in the WHERE because a read-then-compare in
       the action would be the same race it exists to close. */
    expect(updateWhere).toContainEqual(['updated_at', STAMP])
    expect(updateWhere).toContainEqual(['id', PROGRAM_A])
  })

  it('leaves updated_at out of the WHERE clause when no timestamp is passed', async () => {
    /* The documented opt-out for callers that predate the guard. Applying the eq
       unconditionally would send `updated_at=eq.undefined`, match nothing, and turn
       every legacy caller's save into a phantom "someone else changed this". */
    const res = await updateProgram(PROGRAM_A, { name: 'BS Computer Science' })

    expect(res.success).toBe(true)
    expect(whereCols()).toEqual(['id'])
  })

  it('reads zero matched rows as a conflict and says so in words the admin can act on', async () => {
    updateResult = { data: null, error: null }

    const res = await updateProgram(PROGRAM_A, { name: 'BS Computer Science' }, 'stale-stamp')

    expect(res.success).toBeUndefined()
    /* "Failed to update program" would send the admin straight back into the same
       race with no idea they are about to overwrite someone. */
    expect(res.error).toMatch(/someone else changed this/i)
    expect(res.error).toMatch(/reload/i)
    /* The flag the form branches on: a conflict shown as an auto-dismissing toast
       leaves the reader looking at a filled-in form with no visible reason nothing
       saved. Lose the flag and the message degrades to a toast with no type error. */
    expect(res.conflict).toBe(true)
  })

  it('still reports a real DB failure as a failure, not a conflict', async () => {
    updateResult = { data: null, error: { message: 'connection reset' } }

    const res = await updateProgram(PROGRAM_A, { name: 'BS Computer Science' }, STAMP)

    expect(res.error).toBe('Failed to update program')
    expect(res.error).not.toMatch(/someone else/i)
  })

  it('logs no program.updated event for a rejected stale write', async () => {
    updateResult = { data: null, error: null }

    await updateProgram(PROGRAM_A, { name: 'BS Computer Science' }, 'stale-stamp')

    expect(mockLogEvent).not.toHaveBeenCalled()
  })
})

/* Adjacent, not part of #724: updateProgram had no test file at all, and the
   tenant guard is the one thing in it whose failure is a cross-institution write. */
describe('updateProgram — tenant isolation', () => {
  it('rejects a program owned by another institution and never issues the update', async () => {
    const res = await updateProgram('prog-B', { name: 'Hijacked' }, STAMP)

    expect(res).toEqual({ error: 'Not found' })
    expect(updateWhere).toEqual([])
  })
})

/**
 * director_id tenant ownership.
 *
 * `department_id` is guarded in the action AND backstopped in Postgres by
 * trg_programs_tenant_match — but that trigger fires only on
 * `institution_id, department_id`, so a sibling FK like this one has no DB
 * backstop at all. Nothing but the action can catch it.
 *
 * The write alone would be an integrity bug; what makes it a disclosure is the
 * read-back. programs/page.tsx fetches with the RLS-bypassing admin client and
 * getAllWithRelated selects `director:profiles(id, name, email)`. The
 * institution filter scopes the PROGRAM rows; the join then follows the FK
 * wherever it points — so a foreign director's name and email render in the
 * attacker's own console.
 *
 * Until #725 wired an edit dialog, updateProgram had no caller at all, which is
 * why this sat unnoticed. Both directions are asserted: refusing the foreign id,
 * and still accepting a legitimate one (a guard that rejects everything would
 * pass a refusal-only test while breaking the feature).
 */
describe('program director must belong to the caller institution', () => {
  it('updateProgram refuses a director from another institution, and writes nothing', async () => {
    const res = await updateProgram(PROGRAM_A, { director_id: DIRECTOR_B }, STAMP)

    expect(res.success).toBeUndefined()
    expect(res.error).toBeTruthy()
    /* The refusal has to land BEFORE the statement — an error returned after the
       update would leave the foreign id persisted. */
    expect(updateWhere).toEqual([])
  })

  it('updateProgram accepts a director from the caller institution', async () => {
    const res = await updateProgram(PROGRAM_A, { director_id: DIRECTOR_A }, STAMP)

    expect(res.success).toBe(true)
    expect(updateWhere).toContainEqual(['id', PROGRAM_A])
  })

  it('createProgram refuses a foreign director, and inserts nothing', async () => {
    const res = await createProgram({
      name: 'BS Computer Science',
      code: 'CS',
      degree_type: 'bachelor',
      status: 'active',
      department_id: DEPT_A,
      director_id: DIRECTOR_B,
    })

    expect(res.success).toBeUndefined()
    expect(res.error).toBeTruthy()
    expect(inserted).toEqual([])
  })

  it('createProgram accepts a director from the caller institution', async () => {
    const res = await createProgram({
      name: 'BS Computer Science',
      code: 'CS',
      degree_type: 'bachelor',
      status: 'active',
      department_id: DEPT_A,
      director_id: DIRECTOR_A,
    })

    expect(res.error).toBeUndefined()
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ director_id: DIRECTOR_A, institution_id: 'inst-A' })
  })
})
