/**
 * getCoverageSignals — the `degraded` flag.
 *
 * Every read in this function is best-effort by design: it follows the queries.ts
 * convention and returns a safe empty shape rather than throwing, so a broken
 * signal degrades the percentages instead of breaking the page. The problem that
 * creates is that "nothing has happened in this course" and "we could not read
 * what happened" produce the SAME zero-filled shape — and downstream that derives
 * as "nothing delivered, 0% covered". Silence there means the roadmap confidently
 * understates a professor's whole term with nothing on screen to qualify it.
 *
 * So the flag is the only thing separating a real number from a wrong one, and
 * these pin both ways it can be raised (a failed read, a truncated read) plus the
 * clean case where it must stay off.
 */

import { describe, it, expect, vi } from 'vitest'
import { getCoverageSignals } from '@/lib/roadmap/coverage-signals'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const SECTION = 'sec-1'

type Res = { data?: unknown; error?: unknown; count?: number }

/**
 * A thenable chain per table. Every read is `.select(...)…` with no terminal
 * `.single()`, so awaiting the builder itself is what resolves it.
 */
function chainOf(result: Res) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain.then = (res: (v: unknown) => void) => Promise.resolve(result).then(res)
  return chain
}

/** `tables` maps a table name to its result; anything unnamed reads clean+empty. */
function db(tables: Record<string, Res>, rpc: Res = { data: [] }) {
  return {
    from: vi.fn((table: string) => chainOf(tables[table] ?? { data: [], error: null })),
    rpc: vi.fn(async () => rpc),
  } as unknown as SupabaseClient
}

/** n rows of whatever shape — only the LENGTH matters to cap detection. */
const rows = (n: number, make: (i: number) => unknown = (i) => ({ id: `r${i}` })) =>
  Array.from({ length: n }, (_, i) => make(i))

describe('getCoverageSignals — degraded', () => {
  it('stays off on a clean read, so the surface says nothing when nothing is wrong', async () => {
    const out = await getCoverageSignals(
      db({
        modules: { data: [{ id: 'm1', coverage_state: 'active' }], error: null },
        module_items: { data: [{ id: 'i1', module_id: 'm1' }], error: null },
        enrollments: { data: null, error: null, count: 12 },
      }),
      SECTION,
    )
    // Absent, not `false` — callers spread this into a `!!coverage?.degraded`.
    expect(out.degraded).toBeUndefined()
    expect(out.enrolledCount).toBe(12)
  })

  /* A failed read yields `data: null`, which flows on as an empty list. Every
     module then looks undelivered, which is the exact shape of a course nobody
     has taught — so without the flag this is a confident wrong answer. */
  it('is raised when a read fails, on the reads whose absence LOWERS the number', async () => {
    const failed = { data: null, error: { message: 'boom' } }
    for (const table of ['modules', 'lc_rooms', 'quizzes', 'assignments']) {
      const out = await getCoverageSignals(
        db({ modules: { data: [{ id: 'm1', coverage_state: 'active' }], error: null }, [table]: failed }),
        SECTION,
      )
      expect(out.degraded, `${table} read failure must degrade`).toBe(true)
    }
  })

  it('is raised when the module_items read fails — items are what rooms map to modules through', async () => {
    const out = await getCoverageSignals(
      db({
        modules: { data: [{ id: 'm1', coverage_state: 'active' }], error: null },
        module_items: { data: null, error: { message: 'boom' } },
      }),
      SECTION,
    )
    expect(out.degraded).toBe(true)
  })

  /* Truncation is the quiet one: no error at all, just a page that stopped at the
     cap. A course sitting exactly at the limit is reporting partial numbers, so
     hitting the cap counts as degraded even though every read "succeeded". */
  it('is raised when a bounded read comes back exactly at its row cap', async () => {
    const out = await getCoverageSignals(
      db({ modules: { data: rows(500, (i) => ({ id: `m${i}`, coverage_state: 'active' })), error: null } }),
      SECTION,
    )
    expect(out.degraded).toBe(true)
  })

  it('is not raised by a read that merely came back large but under its cap', async () => {
    const out = await getCoverageSignals(
      db({ modules: { data: rows(499, (i) => ({ id: `m${i}`, coverage_state: 'active' })), error: null } }),
      SECTION,
    )
    expect(out.degraded).toBeUndefined()
  })

  /* The decks read is the one behind a conditional — it only runs when there are
     rooms — so it is the easiest to leave unchecked. Slide progress is what a
     deck's covered/total fraction is derived from, so losing it silently reports
     a mid-delivery week as untouched. */
  it('is raised when the decks read fails, even though it sits behind the rooms read', async () => {
    const out = await getCoverageSignals(
      db({
        modules: { data: [{ id: 'm1', coverage_state: 'active' }], error: null },
        module_items: { data: [{ id: 'i1', module_id: 'm1' }], error: null },
        lc_rooms: { data: [{ id: 'room-1', status: 'ended', module_item_id: 'i1' }], error: null },
        lc_decks: { data: null, error: { message: 'boom' } },
      }),
      SECTION,
    )
    expect(out.degraded).toBe(true)
    // The rest of the derivation still stands on what it did read.
    expect(out.roomsByModule.m1).toEqual({ hasEndedClass: true })
  })

  /* The `catch` fallback returns a fully zeroed shape. That is the single most
     misleading value this module can produce, so it must never be handed over
     unflagged. */
  it('is raised on the empty shape returned when the reads throw outright', async () => {
    const thrower = {
      from: vi.fn(() => { throw new Error('connection reset') }),
      rpc: vi.fn(),
    } as unknown as SupabaseClient
    const out = await getCoverageSignals(thrower, SECTION)
    expect(out).toEqual({
      enrolledCount: 0,
      skippedModules: [],
      decksByItem: {},
      roomsByModule: {},
      quizzes: {},
      assignments: {},
      degraded: true,
    })
  })
})
