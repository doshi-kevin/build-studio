// listEndedRoomsPage — the Class Insights gallery reads ONE page of a section's
// ended sessions (#185). The load-bearing bits are the offset math and the
// clamp: a stale or hand-typed `?reportsPage=` past the end must land on the
// last real page, not render an empty gallery with no way back. Also pins that
// the status / setup_completed filter and the ordering happen in SQL — if they
// drift back into JS the read is unbounded again.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { liveClassroomQueries } from '@/lib/supabase/queries'

const SECTION = 'sec-1'

interface Call {
  head: boolean
  filters: Record<string, unknown>
  order?: [string, { ascending: boolean }]
  range?: [number, number]
}

/** Thenable builder that records what was asked for, then resolves canned data. */
function makeSupabase(total: number, rows: Array<{ id: string }>) {
  const calls: Call[] = []
  function builder() {
    const call: Call = { head: false, filters: {} }
    calls.push(call)
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      select: (_cols: string, opts?: { head?: boolean }) => {
        call.head = opts?.head === true
        return b
      },
      eq: (col: string, val: unknown) => {
        call.filters[col] = val
        return b
      },
      order: (col: string, opts: { ascending: boolean }) => {
        call.order = [col, opts]
        return b
      },
      range: (from: number, to: number) => {
        call.range = [from, to]
        return b
      },
      then: (onOk: (v: unknown) => unknown) =>
        Promise.resolve(
          call.head ? { data: null, count: total, error: null } : { data: rows, error: null },
        ).then(onOk),
    })
    return b
  }
  return { supabase: { from: builder }, calls }
}

const room = (id: string) => ({ id })

describe('listEndedRoomsPage', () => {
  it('reads only the requested page, filtered and ordered in SQL', async () => {
    const { supabase, calls } = makeSupabase(25, [room('r1'), room('r2')])

    const out = await liveClassroomQueries.listEndedRoomsPage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      SECTION,
      2,
      10,
    )

    expect(out.total).toBe(25)
    expect(out.pageCount).toBe(3)
    expect(out.page).toBe(2)
    expect(out.rooms).toHaveLength(2)

    const read = calls.find((c) => !c.head)!
    expect(read.range).toEqual([10, 19]) // page 2 of 10
    expect(read.order).toEqual(['created_at', { ascending: false }])
    expect(read.filters).toEqual({
      section_id: SECTION,
      status: 'ended',
      setup_completed: true,
    })
  })

  it('clamps a page past the end to the last real page', async () => {
    const { supabase, calls } = makeSupabase(25, [room('r1')])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await liveClassroomQueries.listEndedRoomsPage(supabase as any, SECTION, 99, 10)

    expect(out.page).toBe(3)
    expect(calls.find((c) => !c.head)!.range).toEqual([20, 29])
  })

  it('treats a junk or zero page as page 1', async () => {
    const { supabase, calls } = makeSupabase(25, [room('r1')])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await liveClassroomQueries.listEndedRoomsPage(supabase as any, SECTION, NaN, 10)

    expect(out.page).toBe(1)
    expect(calls.find((c) => !c.head)!.range).toEqual([0, 9])
  })

  it('skips the row read entirely when the section has no ended sessions', async () => {
    const { supabase, calls } = makeSupabase(0, [])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await liveClassroomQueries.listEndedRoomsPage(supabase as any, SECTION, 1, 10)

    expect(out).toEqual({ rooms: [], page: 1, pageCount: 1, total: 0 })
    expect(calls.filter((c) => !c.head)).toHaveLength(0)
  })
})
