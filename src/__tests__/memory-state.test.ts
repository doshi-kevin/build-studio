/**
 * The two things `getUserStateBatch` does that nothing else covers: it splits a
 * long id list, and it stops handing the section's deadlines to people who are
 * not in the section.
 *
 * Both failures are silent. A regression in the split puts 400 uuids back in a
 * query string and the gateway answers 414, which every deriver catches and
 * turns into "this student has nothing". A regression in the gate blanks
 * deadlines for a whole roster and looks exactly like a quiet week. Neither
 * throws, neither logs, and the nudge sweep that calls this is the one caller
 * that would notice.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

type Row = Record<string, unknown>

interface Recorded {
  table: string
  column: string
  values: unknown[]
}

/**
 * A Supabase stand-in that filters, and records every `.in()` so a test can ask
 * how the id list was carved up. `failOn` names a table whose read comes back
 * as an error rather than data, which is how the fail-open path is driven.
 */
function fakeDb(tables: Record<string, Row[]>, opts: { failOn?: string } = {}) {
  const ins: Recorded[] = []

  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    const failed = opts.failOn === table

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const result = () =>
      failed
        ? { data: null, error: { message: `fakeDb: ${table} is down`, code: '500' } }
        : { data: rows, error: null }

    chain.select = () => chain
    chain.eq = (c: string, v: unknown) => {
      rows = rows.filter((r) => r[c] === v)
      return chain
    }
    chain.in = (c: string, vs: unknown[]) => {
      ins.push({ table, column: c, values: vs })
      rows = rows.filter((r) => vs.includes(r[c]))
      return chain
    }
    chain.gt = (c: string, v: string) => {
      rows = rows.filter((r) => String(r[c]) > v)
      return chain
    }
    chain.lte = (c: string, v: string) => {
      rows = rows.filter((r) => String(r[c]) <= v)
      return chain
    }
    chain.lt = () => chain
    chain.gte = () => chain
    chain.not = (c: string) => {
      rows = rows.filter((r) => r[c] != null)
      return chain
    }
    // Both `.or()` calls in readPreferences describe scope and expiry. Every
    // fixture here is a general, never-expiring row, so both are satisfied.
    chain.or = () => chain
    chain.order = () => chain
    chain.limit = (n: number) => {
      rows = rows.slice(0, n)
      return chain
    }
    chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    chain.then = (res: (v: unknown) => void) => Promise.resolve(result()).then(res)
    return chain
  }

  return { db: { from }, ins }
}

const SECTION = 'sec-1'
const INSTITUTION = 'inst-1'
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

const memoryRow = (userId: string, text: string): Row => ({
  id: `mem-${userId}`,
  user_id: userId,
  // readPreferences filters institution_id explicitly, because the admin client
  // bypasses row-level security and this is the first lock rather than the second.
  institution_id: INSTITUTION,
  kind: 'constraint',
  text,
  section_id: null,
  expires_at: null,
  observed_at: '2026-01-01T00:00:00Z',
})

/** One published assignment due inside the seven-day window. */
const assignments: Row[] = [
  { title: 'Attention write-up', due_at: iso(3), section_id: SECTION, status: 'published' },
]

describe('getUserStateBatch: who gets the section deadlines', () => {
  it('gives them to an enrolled student and withholds them from one who left', async () => {
    const { db } = fakeDb({
      assignments,
      enrollments: [{ student_id: 'stays', section_id: SECTION, status: 'enrolled' }],
    })
    const { getUserStateBatch } = await import('@/lib/memory/state')

    const byUser = await getUserStateBatch(db, {
      userIds: ['stays', 'left'],
      institutionId: INSTITUTION,
      sectionId: SECTION,
    })

    expect(byUser.get('stays')!.dueSoon).toHaveLength(1)
    /* The one that matters. A student who dropped in week six stays in a sweep's
       id list until somebody prunes it, and without this gate they keep being
       emailed about work in a course they left. */
    expect(byUser.get('left')!.dueSoon).toEqual([])
  })

  it('keeps everyone their deadlines when the roster lookup itself fails', async () => {
    const { db } = fakeDb({ assignments, enrollments: [] }, { failOn: 'enrollments' })
    const { getUserStateBatch } = await import('@/lib/memory/state')

    const byUser = await getUserStateBatch(db, {
      userIds: ['stays', 'left'],
      institutionId: INSTITUTION,
      sectionId: SECTION,
    })

    /* Failing closed here would be worse than the bug it fixes: one bad read
       would blank deadlines for every student in every section, and nothing
       would say so. The gate only ever narrows, so an unknown roster has to
       mean "do not narrow". */
    expect(byUser.get('stays')!.dueSoon).toHaveLength(1)
    expect(byUser.get('left')!.dueSoon).toHaveLength(1)
  })

  it('asks about only the users it was given, not the whole roster', async () => {
    const { db, ins } = fakeDb({
      assignments,
      enrollments: [{ student_id: 'a', section_id: SECTION, status: 'enrolled' }],
    })
    const { getUserStateBatch } = await import('@/lib/memory/state')
    await getUserStateBatch(db, {
      userIds: ['a'],
      institutionId: INSTITUTION,
      sectionId: SECTION,
    })

    /* A section-wide read would be capped at 1000 rows by PostgREST and report
       that as a success, so every student past the first thousand would drop out
       of the set and lose their deadlines. */
    const rosterRead = ins.find((i) => i.table === 'enrollments' && i.column === 'student_id')
    expect(rosterRead).toBeDefined()
    expect(rosterRead!.values).toEqual(['a'])
  })
})

describe('getUserStateBatch: splitting a long id list', () => {
  const roster = Array.from({ length: 250 }, (_, i) => `student-${String(i).padStart(3, '0')}`)

  it('never puts more than a hundred ids into one read', async () => {
    const { db, ins } = fakeDb({
      user_memory: roster.map((id) => memoryRow(id, `marker for ${id}`)),
      enrollments: roster.map((id) => ({ student_id: id, section_id: SECTION, status: 'enrolled' })),
    })
    const { getUserStateBatch } = await import('@/lib/memory/state')
    await getUserStateBatch(db, {
      userIds: roster,
      institutionId: INSTITUTION,
      sectionId: SECTION,
    })

    /* Measured, not guessed: 400 uuids produced a 15,963-character URL and a
       414, and the gateway gives up somewhere around eight kilobytes. */
    const idReads = ins.filter((i) => i.values.length > 0 && String(i.values[0]).startsWith('student-'))
    expect(idReads.length).toBeGreaterThan(0)
    for (const read of idReads) {
      expect(read.values.length, `${read.table}.${read.column} carried ${read.values.length} ids`).toBeLessThanOrEqual(100)
    }
  })

  it('still returns every user their own state', async () => {
    const { db } = fakeDb({
      user_memory: roster.map((id) => memoryRow(id, `marker for ${id}`)),
      enrollments: roster.map((id) => ({ student_id: id, section_id: SECTION, status: 'enrolled' })),
    })
    const { getUserStateBatch } = await import('@/lib/memory/state')
    const byUser = await getUserStateBatch(db, {
      userIds: roster,
      institutionId: INSTITUTION,
      sectionId: SECTION,
    })

    expect(byUser.size).toBe(250)
    // Splitting the list must not let one chunk's rows land on another's users.
    for (const id of roster) {
      expect(byUser.get(id)!.preferences.map((p) => p.text)).toEqual([`marker for ${id}`])
    }
  })
})
