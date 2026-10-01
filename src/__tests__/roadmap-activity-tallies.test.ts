/**
 * getProfessorActivitySignals — the submission tallies behind P7/P8/P9.
 *
 * The one line worth pinning here is `handedIn`. `finalize_overdue_assignments`
 * (pg_cron, every 15 min, mig 20260617044419) writes a **`graded`-0 row for every
 * enrolled non-submitter** the moment a deadline passes, so a status-based count of
 * "who turned something in" reports the entire roster — and P9's "N didn't turn
 * this in" is then permanently zero on every past-due assignment in production. A
 * submission timestamp is the only honest test, and these fix that:
 * the cron's rows and a student's own draft must both stay out of `handedIn`,
 * while the status tallies P7/P8 read keep counting them.
 *
 * The signals-level arithmetic (enrolled − handedIn) is covered in
 * roadmap-signals.test.ts; this is the layer underneath it, which that file mocks.
 */

import { describe, it, expect, vi } from 'vitest'
import { roadmapSignalQueries } from '@/lib/supabase/queries'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

type Res = { data?: unknown; error?: unknown }

/** A thenable per-table chain: every read here is `.select(...).eq/.in(...)`. */
function chainOf(result: Res) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order']) chain[m] = vi.fn().mockReturnValue(chain)
  chain.then = (res: (v: unknown) => void) => Promise.resolve(result).then(res)
  return chain
}
const db = (tables: Record<string, Res>) =>
  ({ from: vi.fn((t: string) => chainOf(tables[t] ?? { data: [], error: null })) }) as unknown as SupabaseClient

const ASSIGNMENT = { id: 'a1', title: 'Lab', status: 'published', due_at: '2026-01-01T00:00:00Z' }
const roster = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ student_id: `s${i}`, profiles: { name: `S${i}` } }))

describe('getProfessorActivitySignals', () => {
  it('counts only rows with a submission timestamp as handed in', async () => {
    const out = await roadmapSignalQueries.getProfessorActivitySignals(
      db({
        assignments: { data: [ASSIGNMENT], error: null },
        enrollments: { data: roster(4), error: null },
        assignment_submissions: {
          data: [
            // a real submission, still waiting to be marked
            { assignment_id: 'a1', status: 'submitted', submitted_at: '2025-12-30T10:00:00Z' },
            // graded work the student did hand in
            { assignment_id: 'a1', status: 'graded', submitted_at: '2025-12-29T10:00:00Z' },
            // the cron's auto-zero: 'graded', but nothing was ever turned in
            { assignment_id: 'a1', status: 'graded', submitted_at: null },
            // started and never turned in — P7's signal, not a submission
            { assignment_id: 'a1', status: 'draft', submitted_at: null },
          ],
          error: null,
        },
      }),
      'sec-1',
    )

    const t = out.tallies.a1
    expect(t.handedIn).toBe(2) // NOT 3 (cron row) and NOT 4 (draft)
    // the status tallies P7/P8 read are untouched by that distinction
    expect(t).toMatchObject({ submitted: 1, graded: 2, draft: 1, returned: 0 })
    expect(out.enrolled).toBe(4)
  })

  it('a re-opened (returned) submission still counts as handed in', async () => {
    const out = await roadmapSignalQueries.getProfessorActivitySignals(
      db({
        assignments: { data: [ASSIGNMENT], error: null },
        enrollments: { data: roster(1), error: null },
        assignment_submissions: {
          data: [{ assignment_id: 'a1', status: 'returned', submitted_at: '2025-12-28T10:00:00Z' }],
          error: null,
        },
      }),
      'sec-1',
    )
    expect(out.tallies.a1).toMatchObject({ returned: 1, handedIn: 1 })
  })

  /* queries.ts convention: a failed read must degrade to a safe empty shape, never
     throw — a broken tally has to leave the roadmap standing. */
  it('degrades to empty rather than throwing when the read fails', async () => {
    const out = await roadmapSignalQueries.getProfessorActivitySignals(
      db({ assignments: { data: null, error: { message: 'boom' } } }),
      'sec-1',
    )
    expect(out).toEqual({ assignments: [], tallies: {}, enrolled: 0 })
  })
})
