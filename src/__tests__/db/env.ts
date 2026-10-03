/**
 * Local Supabase connection details for the row-level-security suite.
 *
 * Keys come from `supabase status -o env` rather than a committed .env file: .env.test is
 * gitignored and absent on a fresh clone, and local keys rotate when someone runs
 * `supabase stop --no-backup`. Asking the CLI means the suite works immediately after
 * `supabase start` with nothing to configure.
 *
 * THE HARD GATE IS THE POINT. This suite signs users in, writes rows and reads other tenants'
 * data to prove it cannot. Pointed at production that is not a test, it is an incident. So it
 * refuses to run against anything but 127.0.0.1/localhost, the same gate scripts/seed-e2e.ts
 * uses, and it refuses rather than falling back if the URL is missing.
 */
import { execFileSync } from 'node:child_process'

export interface DbEnv {
  url: string
  anonKey: string
  serviceKey: string
  pgUrl: string
}

function abort(msg: string): never {
  throw new Error(
    `\n\n  RLS suite aborted: ${msg}\n` +
      `  Start a local stack first:  supabase start && supabase migration up\n`,
  )
}

let cached: DbEnv | null = null

export function dbEnv(): DbEnv {
  if (cached) return cached

  let vars: Record<string, string> = {}
  // With all four set in the environment the CLI isn't needed (a stack started without it).
  const fromEnv =
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.SUPABASE_DB_URL
  if (!fromEnv) {
    try {
      const out = execFileSync('supabase', ['status', '-o', 'env'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      for (const line of out.split('\n')) {
        const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim())
        if (m) vars[m[1]] = m[2]
      }
    } catch {
      abort('could not run `supabase status` — is the local stack running?')
    }
  }

  // Environment wins when set, so CI or a custom stack can point this elsewhere (still local).
  vars = {
    API_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? vars.API_URL,
    ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? vars.ANON_KEY,
    SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? vars.SERVICE_ROLE_KEY,
    DB_URL: process.env.SUPABASE_DB_URL ?? vars.DB_URL,
  }

  if (!vars.API_URL) abort('no API URL found')
  if (!vars.ANON_KEY || !vars.SERVICE_ROLE_KEY) abort('anon/service-role keys not found')

  const isLocal =
    vars.API_URL.startsWith('http://127.0.0.1') || vars.API_URL.startsWith('http://localhost')
  if (!isLocal) {
    abort(
      `API URL ${vars.API_URL} is not local. This suite seeds users and reads across tenants; ` +
        `it must never touch a shared or production project.`,
    )
  }

  // Suites also connect to Postgres directly with this URL, so it gets the same rule: a
  // production SUPABASE_DB_URL left in a shell must never receive raw SQL.
  const pgUrl = vars.DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
  let pgHost = ''
  try {
    pgHost = new URL(pgUrl).hostname
  } catch {
    abort('the database URL is not a URL')
  }
  if (pgHost !== '127.0.0.1' && pgHost !== 'localhost') {
    abort(`database host ${pgHost} is not local. This suite must never touch a shared or production database.`)
  }

  cached = {
    url: vars.API_URL,
    anonKey: vars.ANON_KEY,
    serviceKey: vars.SERVICE_ROLE_KEY,
    pgUrl,
  }
  return cached
}
