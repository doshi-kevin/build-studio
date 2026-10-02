/**
 * The builder's TypeScript and its SQL agree, checked from the migration text so it runs in CI
 * (the real-Postgres suite in src/__tests__/db/ is a local gate and calls the functions
 * positionally, so it never sees db.ts's named arguments).
 *
 * - Every builderRpcs call sends exactly the parameter names of the function it calls. PostgREST
 *   resolves an RPC by its argument names: one misspelt key is a 404, builderRpc returns null,
 *   and for the sweep that silently turns stalled-run upkeep off.
 * - Every error code the harness can end a run with is allowed by the runs table's CHECK. A code
 *   missing there makes studio_builder_end fail, so the run never ends with its real reason.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const calls: { name: string; args: Record<string, unknown> }[] = []
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return { data: {}, error: null }
    },
  }),
}))

const { builderRpcs } = await import('@/lib/studio/db')
const { BUDGET_CODES, VALIDATION_CODES, BLOCK_CODES, FAILURE_CODES } = await import('@/lib/studio/builder/work')

const DIR = 'supabase/migrations'
const migrations = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(join(DIR, f), 'utf8').replace(/^\s*--.*$/gm, '') }))

/** Parameter names of the latest CREATE of public.<fn>, in order. */
function paramsOf(fn: string): string[] | null {
  let latest: string | null = null
  const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${fn}\\s*\\(([\\s\\S]*?)\\)\\s*returns`, 'gi')
  for (const { sql } of migrations) for (const m of sql.matchAll(re)) latest = m[1]
  return latest === null ? null : [...latest.matchAll(/\b(p_\w+)\b/g)].map((m) => m[1])
}

/** Codes the latest studio_plugin_builder_runs_error_code_check allows, from `sql` or all migrations. */
function allowedErrorCodes(only?: string): string[] {
  let latest: string | null = null
  // The column's inline CHECK in the CREATE TABLE (auto-named <table>_error_code_check), or a
  // later named re-add of it.
  const re = /(?:studio_plugin_builder_runs_error_code_check\s+check|\berror_code\s+text\s+check)\s*\(\s*error_code\s+is\s+null\s+or\s+error_code\s+in\s*\(([^)]*)\)/gi
  for (const { file, sql } of migrations) {
    if (only && file !== only) continue
    for (const m of sql.matchAll(re)) latest = m[1]
  }
  return latest === null ? [] : [...latest.matchAll(/'(\w+)'/g)].map((m) => m[1])
}

describe('builderRpcs and the SQL functions they call', () => {
  const entries = Object.entries(builderRpcs) as [string, (...a: unknown[]) => Promise<unknown>][]

  it.each(entries.map(([k]) => k))('%s sends exactly the function’s parameter names', async (key) => {
    calls.length = 0
    const fn = builderRpcs[key as keyof typeof builderRpcs] as (...a: unknown[]) => Promise<unknown>
    // Object args for the ones that take one; extra positional args are ignored.
    await fn({}, {}, {}, {}, {}, {}, {})
    expect(calls).toHaveLength(1)
    const { name, args } = calls[0]
    const params = paramsOf(name)
    expect(params, `no migration creates public.${name}`).not.toBeNull()
    expect(params!.length).toBeGreaterThan(0)
    expect(Object.keys(args).sort()).toEqual([...params!].sort())
  })

  it('covers the stalled-run sweep the job worker’s upkeep calls', () => {
    expect(entries.map(([k]) => k)).toContain('sweep')
    expect(paramsOf('studio_builder_sweep')).toEqual(['p_stale_ms', 'p_max_resumes', 'p_limit'])
  })
})

describe('run error codes and the runs table CHECK', () => {
  const codes = [...BUDGET_CODES, ...VALIDATION_CODES, ...BLOCK_CODES, ...FAILURE_CODES, 'superseded', 'expired']

  it('allows every code the harness can end a run with', () => {
    const allowed = new Set(allowedErrorCodes())
    expect(codes.filter((c) => !allowed.has(c))).toEqual([])
  })

  it('reads the latest constraint: the original one lacked limit_daily_cost', () => {
    // Proves the parser discriminates, so the rule above can fail.
    expect(allowedErrorCodes('20261002160000_studio_builder.sql')).toContain('limit_cost')
    expect(allowedErrorCodes('20261002160000_studio_builder.sql')).not.toContain('limit_daily_cost')
  })
})
