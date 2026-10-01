// `readAllPages` is the only thing standing between PostgREST's silent 1000-row
// cap and a class median computed over a fraction of the class. It had no test
// of its own while four call sites — engagement, item-stats, dossier facts, and
// now `skillQueries.getSectionMasteryRows` (the number Athena quotes to a
// professor) — stake their correctness on it.
//
// The failures that matter are the quiet ones: a boundary that repeats or drops
// rows, and a partial read that comes back looking exactly like a complete one.

import { describe, it, expect, vi } from 'vitest'

const warn = vi.fn()
const error = vi.fn()
vi.mock('@/lib/logger', () => ({
  logger: { error: (...a: unknown[]) => error(...a), warn: (...a: unknown[]) => warn(...a), info: vi.fn(), debug: vi.fn() },
}))

const { readAllPages } = await import('@/lib/supabase/paged-read')

type Row = { id: number }

/** A PostgREST-shaped stub: `.order().range(from, to)` over a fixed table, plus
 *  a record of the ranges asked for so an extra round-trip is visible. */
function table(rows: Row[], opts: { failAtPage?: number } = {}) {
  const ranges: Array<[number, number]> = []
  const build = () => ({
    order: () => ({
      range: async (from: number, to: number) => {
        ranges.push([from, to])
        if (opts.failAtPage != null && ranges.length - 1 === opts.failAtPage) {
          return { data: null, error: { message: 'connection reset' } }
        }
        return { data: rows.slice(from, to + 1), error: null }
      },
    }),
  })
  return { build, ranges }
}

const rowsOfLength = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: i }))

describe('readAllPages — the rows an aggregate is computed over', () => {
  it('returns every row exactly once across a page boundary', async () => {
    // 2500 rows = two full pages plus a remainder. An off-by-one in `.range()`
    // would repeat or drop the row on each seam, and a median over it would be
    // wrong with nothing in the result saying so.
    const { build, ranges } = table(rowsOfLength(2500))

    const out = await readAllPages<Row>(build, 'id')

    expect(out).toHaveLength(2500)
    expect(new Set(out.map((r) => r.id)).size).toBe(2500)
    expect(out[999].id).toBe(999)
    expect(out[1000].id).toBe(1000)
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('stops on a short page instead of paying for an empty round-trip', async () => {
    const { build, ranges } = table(rowsOfLength(400))

    expect(await readAllPages<Row>(build, 'id')).toHaveLength(400)
    expect(ranges).toHaveLength(1)
  })

  it('returns the rows it got when a page fails — partial, and only the log says so', async () => {
    // Worth pinning because it is the sharp edge for callers: the caller sees a
    // plain array and cannot tell a complete read from a truncated one. Anything
    // computing a class-wide number off this is quoting a confident wrong answer
    // on a mid-read failure; the guard is the logged error, not the return value.
    const { build } = table(rowsOfLength(2500), { failAtPage: 1 })

    const out = await readAllPages<Row>(build, 'id', 'skillQueries.getSectionMasteryRows')

    expect(out).toHaveLength(1000)
    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls.at(-1)?.[0])).toContain('skillQueries.getSectionMasteryRows')
  })

  it('cannot spin forever, and says out loud that it gave up', async () => {
    // Every page comes back full, so only the ceiling ends the loop.
    const { build, ranges } = table(rowsOfLength(1000 * 60))

    const out = await readAllPages<Row>(build, 'id')

    expect(ranges).toHaveLength(50)
    expect(out).toHaveLength(50_000)
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(/truncated/i)
  })
})
