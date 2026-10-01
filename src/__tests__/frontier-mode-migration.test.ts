import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards the shape of the Frontier migration against a bug that every other gate missed.
 *
 * Runtime QA found that `saveAssignmentDesign`'s upsert ALWAYS failed: the unique indexes
 * were declared partial (`WHERE assignment_id IS NOT NULL`), and Postgres refuses to infer
 * a partial index from `ON CONFLICT (assignment_id)` unless the statement repeats the
 * predicate — which PostgREST/supabase-js cannot emit. Every insert died with "no unique or
 * exclusion constraint matching the ON CONFLICT specification", so the design notes — the
 * entire reason the feature can refresh an assignment next term instead of rewriting it —
 * never persisted. Lint, typecheck and 3171 unit tests all passed while it was broken.
 *
 * The predicate was never needed: Postgres already treats NULLs as distinct in a unique
 * index, so quiz designs (NULL assignment_id) coexist freely while non-null ones stay
 * unique. These assertions exist so nobody re-adds it for tidiness.
 */

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260728221850_frontier_mode.sql'),
  'utf8',
)

/** The migration with `--` line comments stripped. Assertions about what the SQL DOES must
 *  read SQL, not prose: this file explains at length why there is no FOR ALL policy, and a
 *  naive match on the whole text fails on that very sentence. */
const SQL_ONLY = MIGRATION.replace(/--[^\n]*/g, '')

/** The single `CREATE UNIQUE INDEX …;` statement for a given index name. */
function uniqueIndexStatement(name: string): string {
  const match = SQL_ONLY.match(new RegExp(`CREATE UNIQUE INDEX[^;]*?${name}[^;]*;`, 'i'))
  expect(match, `no CREATE UNIQUE INDEX found for ${name}`).toBeTruthy()
  return match![0]
}

describe('frontier_mode migration — upsert-compatible unique indexes', () => {
  it.each(['uq_assignment_designs_assignment', 'uq_assignment_designs_quiz'])(
    '%s is NOT partial, so ON CONFLICT can infer it',
    (name) => {
      const stmt = uniqueIndexStatement(name)
      // A WHERE clause here is the exact bug: it makes the index uninferable from the
      // upsert, which then fails at runtime with no compile-time or unit-test signal.
      expect(stmt.toUpperCase()).not.toContain('WHERE')
    },
  )

  it('keeps the XOR subject constraint (exactly one of assignment_id / quiz_id)', () => {
    // Dropping the index predicate must not weaken the thing that predicate LOOKED like it
    // was protecting: a row still has to name exactly one subject.
    expect(MIGRATION).toContain('assignment_designs_one_subject')
    expect(MIGRATION).toMatch(/assignment_id IS NOT NULL AND quiz_id IS NULL/)
    expect(MIGRATION).toMatch(/assignment_id IS NULL AND quiz_id IS NOT NULL/)
  })

  it('keeps RLS on with a read-only policy and no client write policies', () => {
    expect(SQL_ONLY).toMatch(/ENABLE ROW LEVEL SECURITY/i)
    expect(SQL_ONLY).toMatch(/FOR SELECT/i)
    // The house rule: writes go through the service role behind a server action. A
    // FOR ALL / FOR INSERT policy here would be a client write hole.
    expect(SQL_ONLY).not.toMatch(/CREATE POLICY[^;]*FOR (ALL|INSERT|UPDATE|DELETE)/i)
  })
})

describe('frontier_mode migration — re-runnable', () => {
  /**
   * Caught by actually piping this file into Postgres twice, which no static gate does.
   *
   * Every object here is guarded (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
   * `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`) — except the policy, because
   * Postgres has no `CREATE POLICY IF NOT EXISTS`. A second run therefore died with
   * `policy "…" for table "assignment_designs" already exists`, and because ON_ERROR_STOP
   * halts there, the trigger and the settings-merge RPC after it never got created.
   *
   * That is not a theoretical concern: prod stamps its OWN migration version when applied
   * via the Supabase MCP, so this file is re-applied by `supabase migration up` on any
   * machine that already has the table, and an interrupted prod apply could not be retried.
   */
  it('guards every CREATE so a second apply is a no-op', () => {
    const guarded = [
      /CREATE TABLE IF NOT EXISTS/i,
      /CREATE UNIQUE INDEX IF NOT EXISTS/i,
      /CREATE INDEX IF NOT EXISTS/i,
      /CREATE OR REPLACE FUNCTION/i,
      /DROP TRIGGER IF EXISTS/i,
    ]
    for (const re of guarded) expect(SQL_ONLY).toMatch(re)
  })

  it('drops the RLS policy before creating it (no CREATE POLICY IF NOT EXISTS in Postgres)', () => {
    const dropAt = SQL_ONLY.search(/DROP POLICY IF EXISTS/i)
    const createAt = SQL_ONLY.search(/CREATE POLICY/i)
    expect(dropAt, 'policy is created without a preceding DROP — a second apply will fail').toBeGreaterThan(-1)
    // Order matters as much as presence: a DROP after the CREATE would delete the policy and
    // leave RLS on with NO policy, which denies everyone and silently breaks all reads.
    expect(dropAt).toBeLessThan(createAt)
  })

  it('still ends with RLS enabled and the policy present, not dropped', () => {
    expect(SQL_ONLY).toMatch(/ENABLE ROW LEVEL SECURITY/i)
    const drops = SQL_ONLY.match(/DROP POLICY IF EXISTS/gi) ?? []
    const creates = SQL_ONLY.match(/CREATE POLICY/gi) ?? []
    expect(creates.length).toBe(drops.length)
  })
})
