// Guards the `lc_rooms` column list in getRoomSnapshot against the one
// regression no other gate in this repo can catch.
//
// `getRoomSnapshot` used to `select('*')`; it now names 18 columns explicitly.
// That row is returned to the client as `snapshot.room` and cast `room as
// LcRoom`, so a column dropped from the list is a field every consumer of
// `snapshot.room` reads as `undefined` at runtime.
//
// Why nothing else catches it:
//   - TypeScript can't. The admin client is `as any`, so the cast to `LcRoom`
//     is unchecked — and `LcRoom` declares `[key: string]: unknown` (needed by
//     useRealtimeSubscription's `T extends Record<string, unknown>`), which
//     makes every property access legal regardless of the select list.
//   - snapshot.test.ts can't. Its `lc_rooms` stub is `select: () => ({...})` —
//     the arguments are discarded, so those 8 tests pass with any column list,
//     including an empty one.
//
// The assertion therefore compares the columns ACTUALLY requested at runtime
// against the fields the `LcRoom` contract DECLARES, parsed from its source.
// Runtime capture (rather than regexing snapshot.ts) means the guard survives
// the list being reformatted, concatenated, or hoisted into a constant.
//
// `lecture_summary` is deliberately absent from both sides: the cached
// "Catch me up" jsonb is not declared on `LcRoom` and is served by
// `getLectureSummary()`, which gates it on `lecture_summary_enabled` for
// students. Shipping it in the snapshot would route around that gate.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const SECTION_ID = '7f8d8c0e-1234-4abc-8def-0123456789ab'
const PROF_ID = '12345678-1234-4abc-89ef-0123456789ab'

// ── The declared contract ──────────────────────────────────────────
// Property names inside `export interface LcRoom { … }`, comments stripped
// first so the JSDoc prose between fields can't be mistaken for a field, and
// the `[key: string]` index signature excluded (it declares no column).

function declaredLcRoomFields(): string[] {
  const source = readFileSync(
    join(process.cwd(), 'src/lib/validations/live-classroom.ts'),
    'utf8',
  )
  const start = source.indexOf('export interface LcRoom {')
  expect(start, 'export interface LcRoom not found — did it move or get renamed?').toBeGreaterThan(-1)

  const bodyStart = source.indexOf('{', start) + 1
  const bodyEnd = source.indexOf('\n}', bodyStart)
  const body = source
    .slice(bodyStart, bodyEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '') // block + JSDoc comments
    .replace(/\/\/[^\n]*/g, '') // line comments

  const fields = Array.from(body.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*\??\s*:/gim)).map((m) => m[1])
  expect(fields.length, 'parsed no fields out of the LcRoom body').toBeGreaterThan(0)
  return fields
}

// ── The columns actually requested ─────────────────────────────────
// A stub that records the `select()` argument for lc_rooms and is otherwise
// just complete enough for a professor's snapshot call to succeed. `deck_url`
// is null and `active_deck_id` unset, so neither signed-URL minting nor the
// annotations read is reached.

function buildCapturingAdminDb(captured: { roomSelect?: string }) {
  const room = {
    id: ROOM_ID,
    section_id: SECTION_ID,
    prof_id: PROF_ID,
    status: 'live',
    current_slide: 0,
    deck_url: null,
  }

  const emptyInteractions = {
    select: () => emptyInteractions,
    eq: () => emptyInteractions,
    in: () => emptyInteractions,
    order: () => emptyInteractions,
    limit: () => emptyInteractions,
    then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null }),
  }

  return {
    from(table: string) {
      if (table === 'lc_rooms') {
        return {
          select: (columns: string) => {
            captured.roomSelect = columns
            return { eq: () => ({ single: async () => ({ data: room, error: null }) }) }
          },
        }
      }
      if (table === 'lc_events') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            }),
          }),
        }
      }
      if (table === 'lc_interactions') return emptyInteractions
      if (table === 'lc_decks') {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }
      }
      throw new Error(`Unexpected table ${table}`)
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getRoomSnapshot: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  const mod = await import('@/lib/live-classroom/snapshot')
  getRoomSnapshot = mod.getRoomSnapshot
})

describe('getRoomSnapshot — lc_rooms select list matches the LcRoom contract', () => {
  it('requests exactly the columns LcRoom declares — no dropped field, no undeclared extra', async () => {
    const captured: { roomSelect?: string } = {}
    mockGetUser.mockResolvedValue({ data: { user: { id: PROF_ID } } })
    mockAdminClient.mockReturnValue(buildCapturingAdminDb(captured))

    const result = await getRoomSnapshot(ROOM_ID)
    expect(result.snapshot, `snapshot call failed: ${result.error}`).toBeDefined()
    expect(captured.roomSelect, 'lc_rooms was queried with select() but no column list').toBeTruthy()

    const selected = captured.roomSelect!.split(',').map((c) => c.trim()).filter(Boolean)
    const declared = declaredLcRoomFields()

    // One assertion, both directions. A dropped column surfaces in `missing`
    // (silent `undefined` on the client); a column shipped without being part
    // of the contract surfaces in `extra` (the lecture_summary hazard).
    expect({
      missing: declared.filter((f) => !selected.includes(f)),
      extra: selected.filter((c) => !declared.includes(c)),
    }).toEqual({ missing: [], extra: [] })
  })
})
