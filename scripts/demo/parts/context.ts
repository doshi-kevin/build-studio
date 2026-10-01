// Shared state for the demo seed: the admin client, the target gate, deterministic
// ids, the term clock, and the insert helper every other part uses.
//
// Read scripts/demo/CONTEXT.md before changing anything in here.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { v5 as uuidv5 } from 'uuid'

// ── Target ────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

export function abort(msg: string): never {
  console.error(`\n\x1b[41m\x1b[37m ✗ DEMO SEED ABORTED \x1b[0m ${msg}\n`)
  process.exit(1)
}

if (!SUPABASE_URL) abort('NEXT_PUBLIC_SUPABASE_URL is not set. Run via scripts/demo/seed-demo.sh.')
if (!SERVICE_KEY) abort('SUPABASE_SERVICE_ROLE_KEY is not set. Run via scripts/demo/seed-demo.sh.')

export const isLocalTarget =
  SUPABASE_URL.startsWith('http://127.0.0.1') || SUPABASE_URL.startsWith('http://localhost')

export const targetRef = isLocalTarget
  ? 'local'
  : (SUPABASE_URL.match(/^https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? '')

// A remote target needs its own ref echoed back. An allowlist, not a denylist:
// adding an environment can never silently re-enable an old one. seed-demo.sh
// layers a typed institution-name confirmation on top of this for production.
if (!isLocalTarget) {
  if (!targetRef) abort(`Could not parse a project ref from NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL}`)
  if ((process.env.DEMO_CONFIRM_REF ?? '') !== targetRef) {
    abort(
      `Remote seeding needs explicit confirmation. Set DEMO_CONFIRM_REF=${targetRef} ` +
        `(got "${process.env.DEMO_CONFIRM_REF ?? ''}").`,
    )
  }
}

export const db: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

export const targetLabel = isLocalTarget ? `${SUPABASE_URL} (local)` : `${SUPABASE_URL} (${targetRef})`

// ── Deterministic ids ─────────────────────────────────────────────────
// Namespaced so a demo row can never collide with a real one, and so a re-run
// lands on the same ids (which is what makes the seed idempotent).
const NS = uuidv5('scholera-demo-seed', uuidv5.DNS)
export const det = (key: string): string => uuidv5(key, NS)

export const INSTITUTION_ID = det('institution')
export const INSTITUTION_NAME = 'Northcrest University'
export const INSTITUTION_SLUG = 'northcrest'
export const EMAIL_DOMAIN = 'northcrest.edu'
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo1234!'

// Tenants the demo must never write to or delete, whatever the ids compute to.
// Belt and braces on top of the institution_id scoping in every query.
const PROTECTED_INSTITUTION_IDS = new Set([
  '00000000-0000-0000-0000-000000000001', // Stevens (real customer)
  '00000000-0000-0000-0000-000000000002', // Scholera Dev (intern sandbox)
])
if (PROTECTED_INSTITUTION_IDS.has(INSTITUTION_ID)) {
  abort(`The demo institution id collided with a protected tenant (${INSTITUTION_ID}).`)
}

// ── Term clock ────────────────────────────────────────────────────────
// Every date in the seed derives from these two anchors, so the tenant reads as
// mid-semester on whatever day it is run. Both are overridable for a fixed demo.
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

const WEEKS_ELAPSED = Number(process.env.DEMO_WEEKS_ELAPSED ?? 9)
const TERM_WEEKS = Number(process.env.DEMO_TERM_WEEKS ?? 15)

export const NOW = process.env.DEMO_NOW ? new Date(process.env.DEMO_NOW) : new Date()
export const TERM_START = process.env.DEMO_TERM_START
  ? new Date(process.env.DEMO_TERM_START)
  : new Date(NOW.getTime() - WEEKS_ELAPSED * WEEK_MS)
export const TERM_END = new Date(TERM_START.getTime() + TERM_WEEKS * WEEK_MS)
export const WEEKS_IN = Math.max(1, Math.floor((NOW.getTime() - TERM_START.getTime()) / WEEK_MS))

/** Semester label from the term's midpoint, so a term straddling two seasons
 *  gets the one it mostly sits in rather than the one it happened to start in. */
function semesterOf(d: Date): 'spring' | 'summer' | 'fall' | 'winter' {
  const m = d.getUTCMonth() // 0-11
  if (m <= 3) return 'spring'
  if (m <= 6) return 'summer'
  if (m <= 10) return 'fall'
  return 'winter'
}
const MIDPOINT = new Date((TERM_START.getTime() + TERM_END.getTime()) / 2)
export const SEMESTER = semesterOf(MIDPOINT)
export const TERM_YEAR = MIDPOINT.getUTCFullYear()
export const TERM_LABEL = `${SEMESTER[0].toUpperCase()}${SEMESTER.slice(1)} ${TERM_YEAR}`

/**
 * Every hour in this file means an hour in the INSTITUTION'S timezone, not UTC.
 *
 * The tenant is set to America/New_York and the app renders timestamps in the
 * viewer's zone, so writing 14:00 UTC put a 2 PM class on screen at 10:00 AM —
 * contradicting the "Mon/Wed 2:00 PM" on the syllabus page next to it. The
 * offset is computed per date rather than hard-coded, so a term that crosses a
 * daylight-saving boundary still lands on the right local hour.
 */
export const INSTITUTION_TZ = 'America/New_York'

function tzOffsetHours(d: Date): number {
  const asUtc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }))
  const asLocal = new Date(d.toLocaleString('en-US', { timeZone: INSTITUTION_TZ }))
  return Math.round((asUtc.getTime() - asLocal.getTime()) / 3_600_000)
}

/** Set `d` to the UTC instant that reads as `hour:minute` in the tenant's zone. */
function setLocalHours(d: Date, hour: number, minute = 0): void {
  d.setUTCHours(hour, minute, 0, 0)
  d.setUTCHours(hour + tzOffsetHours(d), minute, 0, 0)
}

/** ISO timestamp `weeks` weeks and `days` days after the term started, at local `hour`. */
export function atTerm(weeks: number, days = 0, hour = 14, minute = 0): string {
  const d = new Date(TERM_START.getTime() + weeks * WEEK_MS + days * DAY_MS)
  setLocalHours(d, hour, minute)
  return d.toISOString()
}

/** ISO timestamp `days` days before now (negative = future), at local `hour`. */
export function daysAgo(days: number, hour?: number): string {
  const d = new Date(NOW.getTime() - days * DAY_MS)
  if (hour !== undefined) setLocalHours(d, hour)
  return d.toISOString()
}

export function isoDate(iso: string): string {
  return iso.slice(0, 10)
}

/** The real weekday name for an ISO timestamp — narrative copy that names a due
 *  date's weekday ("Due Sunday") must derive it from here, not hardcode one:
 *  the term clock is relative to whenever the seed runs, so a fixed day name
 *  agrees with the real due date only 1 run in 7. */
export function weekdayName(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
}

/**
 * The next occurrence of `weekday` (0=Sun) on or after `from`, at local `hour`.
 * Past live classes have to land on the days the syllabus actually lists, or the
 * session list contradicts the schedule shown beside it.
 */
export function onWeekday(from: Date, weekday: number, hour: number, minute = 0): Date {
  const d = new Date(from)
  setLocalHours(d, hour, minute)
  const shift = (weekday - d.getUTCDay() + 7) % 7
  d.setUTCDate(d.getUTCDate() + shift)
  setLocalHours(d, hour, minute)
  return d
}

// ── Deterministic randomness ──────────────────────────────────────────
// Same seed key → same "random" run to run, so scores and timings are stable
// across re-runs. Mulberry32 on a hashed key; boring and dependency-free.
export function rng(key: string): () => number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length) % arr.length]
}

// ── Writing ───────────────────────────────────────────────────────────
export const rowCounts = new Map<string, number>()

/**
 * Upsert rows in chunks. `conflict` names the conflict target — 'id' for the
 * tables that have a surrogate key, the natural composite key for the ones that
 * don't (lc_attendance, lc_session_reports, dm_read_cursors, …).
 */
/**
 * Does this database have that column? Schemas drift between a local stack and
 * production, and a demo seed that dies because one optional column is missing
 * is worse than one that seeds without it. Used for genuinely optional fields
 * only — never to paper over a column the data depends on.
 */
export async function columnExists(table: string, column: string): Promise<boolean> {
  const { error } = await db.from(table).select(column).limit(0)
  return !error
}

/**
 * Upsert rows, grouped so that every request carries a uniform set of columns.
 *
 * PostgREST builds ONE INSERT statement per request, with a single column list
 * taken from the union of the keys it is given. A row that omits a key another
 * row in the same batch has does not fall back to the column DEFAULT — it is
 * sent an explicit NULL, which then fails any NOT NULL column. So a batch of
 * "mostly the same" rows where a few carry an extra optional field breaks in a
 * way that looks nothing like its cause.
 *
 * Grouping by key signature makes the shape of the data irrelevant to the
 * caller: build rows naturally, omit what does not apply, and let this sort it.
 */
export async function up(
  table: string,
  rows: Record<string, unknown>[],
  conflict = 'id',
): Promise<void> {
  if (rows.length === 0) return

  const groups = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    const signature = Object.keys(row).sort().join('\u0000')
    const group = groups.get(signature)
    if (group) group.push(row)
    else groups.set(signature, [row])
  }

  const CHUNK = 400
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += CHUNK) {
      const slice = group.slice(i, i + CHUNK)
      const { error } = await db.from(table).upsert(slice, { onConflict: conflict })
      if (error) {
        throw new Error(
          `upsert ${table} (${slice.length} rows, onConflict=${conflict}): ` +
            `${error.message}${error.details ? ` — ${error.details}` : ''}`,
        )
      }
    }
  }
  rowCounts.set(table, (rowCounts.get(table) ?? 0) + rows.length)
}

// ── Logging ───────────────────────────────────────────────────────────
export const log = (msg: string) => console.log(`  ${msg}`)
export const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
export const warn = (msg: string) => console.log(`  \x1b[33m!\x1b[0m ${msg}`)
export const phase = (msg: string) => console.log(`\n\x1b[1m━━━ ${msg}\x1b[0m`)
