/**
 * The stale-write guard inside the query helpers (#724).
 *
 * `departmentQueries.update` and `courseAdminQueries.update` are two copies of the
 * same code, and the action layer above them only sees the discriminated result —
 * so the action tests (actions-admin-course-actions.test.ts) can prove the message
 * mapping while saying nothing about whether a guard was ever sent to Postgres.
 * This file drives the real helpers against a fake client and reads back the
 * statement they built.
 *
 * Three properties, none of which surfaces as an error when broken:
 *
 *   1. `expectedUpdatedAt` lands in the WHERE clause. Only there is the check
 *      atomic; a read-then-compare in the helper would be the race it exists to
 *      close. Lose it and every save silently goes back to last-write-wins.
 *   2. It is applied only when given. PostgREST would happily send
 *      `updated_at=eq.undefined` for an un-guarded caller, match zero rows, and
 *      report a conflict for an edit nobody raced.
 *   3. Zero rows means 'conflict', a driver error means 'error'. Collapsing the two
 *      is what makes the UI say "Failed to update" to someone who needs to be told
 *      to reload — the whole reason the return type stopped being `T | null`.
 *
 * Plus the invariant that keeps the guard working over time: every update must
 * write a fresh `updated_at`. If it stopped, the stamp a form was rendered from
 * would keep matching forever and the guard would pass every stale write.
 *
 * Both helpers run the same table of cases: this fix is the kind that gets applied
 * to one copy and missed on the other.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { departmentQueries, courseAdminQueries } from '@/lib/supabase/queries'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const STAMP = '2026-08-20T12:00:00.000Z'

/** Everything the helper built, read back after the call. */
interface Recorded {
  table: string
  payload: Record<string, unknown>
  where: Array<[string, unknown]>
}

function fakeClient(result: { data: unknown; error: unknown }, rec: Recorded) {
  return {
    from: (table: string) => {
      rec.table = table
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      chain.update = (payload: Record<string, unknown>) => {
        rec.payload = payload
        return chain
      }
      chain.eq = (col: string, val: unknown) => {
        rec.where.push([col, val])
        return chain
      }
      chain.select = () => chain
      /* maybeSingle only. A revert to .single() would make this fake throw rather
         than quietly pass, which is the outcome we want: under .single() zero rows
         comes back as an error and every stale write reads as a DB failure. */
      chain.maybeSingle = async () => result
      return chain
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

interface HelperCase {
  label: string
  table: string
  update: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    id: string,
    input: Record<string, unknown>,
    expectedUpdatedAt?: string | null,
  ) => Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: 'conflict' | 'error' }>
  id: string
}

const CASES: HelperCase[] = [
  { label: 'departmentQueries.update', table: 'departments', update: departmentQueries.update, id: 'dept-1' },
  { label: 'courseAdminQueries.update', table: 'courses', update: courseAdminQueries.update, id: 'course-1' },
]

for (const c of CASES) {
  describe(`${c.label} — optimistic concurrency (#724)`, () => {
    let rec: Recorded

    beforeEach(() => {
      rec = { table: '', payload: {}, where: [] }
    })

    const whereCols = () => rec.where.map(([col]) => col)

    it('adds expectedUpdatedAt to the WHERE clause and returns the updated row', async () => {
      const client = fakeClient({ data: { id: c.id, name: 'Updated' }, error: null }, rec)

      const res = await c.update(client, c.id, { name: 'Updated' }, STAMP)

      expect(res).toEqual({ ok: true, data: { id: c.id, name: 'Updated' } })
      expect(rec.table).toBe(c.table)
      expect(rec.where).toContainEqual(['id', c.id])
      expect(rec.where).toContainEqual(['updated_at', STAMP])
    })

    it('sends no updated_at predicate when the caller passes no timestamp', async () => {
      const client = fakeClient({ data: { id: c.id }, error: null }, rec)

      const res = await c.update(client, c.id, { name: 'Updated' })

      expect(res.ok).toBe(true)
      expect(whereCols()).toEqual(['id'])
    })

    /* null is what a row with no updated_at yields, and '' is what an untouched
       hidden form field yields. Both must read as "no guard", not as a predicate
       that can never match. */
    it.each([null, ''])('treats %o as no guard rather than an unmatchable predicate', async (stamp) => {
      const client = fakeClient({ data: { id: c.id }, error: null }, rec)

      const res = await c.update(client, c.id, { name: 'Updated' }, stamp as string | null)

      expect(res.ok).toBe(true)
      expect(whereCols()).toEqual(['id'])
    })

    it('reports zero matched rows as a conflict, not a failure', async () => {
      const client = fakeClient({ data: null, error: null }, rec)

      const res = await c.update(client, c.id, { name: 'Updated' }, 'stale-stamp')

      /* Past the caller's assertTenantOwns the row is known to exist, so zero rows
         can only mean the guard fired — hence 'conflict' and not 'error'. */
      expect(res).toEqual({ ok: false, reason: 'conflict' })
    })

    it('reports a driver error as an error, not a conflict', async () => {
      const client = fakeClient({ data: null, error: { message: 'connection reset' } }, rec)

      const res = await c.update(client, c.id, { name: 'Updated' }, STAMP)

      expect(res).toEqual({ ok: false, reason: 'error' })
    })

    it('reports a thrown exception as an error rather than letting it escape', async () => {
      const client = {
        from: () => {
          throw new Error('client exploded')
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any

      /* The helpers' contract is that they never throw at their callers — the
         actions have no try//catch around this call beyond the outer one. */
      await expect(c.update(client, c.id, { name: 'Updated' }, STAMP)).resolves.toEqual({
        ok: false,
        reason: 'error',
      })
    })

    /* What keeps the guard alive across edits: the next form is rendered from the
       stamp this write sets. If updates stopped advancing updated_at, every stale
       write would keep matching and the guard would never fire again. */
    it('always writes a fresh updated_at so the next guard has something to catch', async () => {
      const client = fakeClient({ data: { id: c.id }, error: null }, rec)

      await c.update(client, c.id, { name: 'Updated' }, STAMP)

      expect(typeof rec.payload.updated_at).toBe('string')
      expect(rec.payload.updated_at).not.toBe(STAMP)
      expect(Number.isNaN(Date.parse(String(rec.payload.updated_at)))).toBe(false)
    })
  })
}
