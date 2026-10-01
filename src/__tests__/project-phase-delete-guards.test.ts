/**
 * Deleting project structure must not destroy saved student grades (#814).
 *
 * `project_master_phases → project_phase_items → project_item_scores` is a cascade
 * chain, so one phase delete used to take every rubric row under it and every score
 * on those rows — permanently, with no warning. Worse, `project_grade_releases` is
 * keyed on the PROJECT, so it survived the delete and students kept seeing a grade
 * silently recomputed over whatever rows were left. Verified against local Postgres:
 * score saved (1) → phase deleted → score gone (0).
 *
 * These test the decision, including the fail-closed reads. A guard that opens when
 * its own lookup fails is not a guard — and what it is protecting here is a grade
 * nobody can get back.
 */
import { describe, it, expect } from 'vitest'
import { assertDeletableStructure } from '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'

/** Smallest PostgREST-shaped stub that answers the three reads the guard makes. */
function db(opts: {
  released?: boolean
  scoreCount?: number
  rows?: { id: string }[]
  releaseError?: boolean
  rowsError?: boolean
  scoreError?: boolean
}) {
  const { released = false, scoreCount = 0, rows = [{ id: 'row-1' }] } = opts
  return {
    from(table: string) {
      if (table === 'project_grade_releases') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: released ? { project_id: 'p1' } : null,
                  error: opts.releaseError ? { message: 'boom' } : null,
                }),
            }),
          }),
        }
      }
      if (table === 'project_phase_items') {
        return {
          select: () => ({
            eq: () => ({
              eq: () =>
                Promise.resolve({ data: rows, error: opts.rowsError ? { message: 'boom' } : null }),
            }),
          }),
        }
      }
      // project_item_scores — counted, never fetched
      const result = Promise.resolve({
        count: scoreCount,
        error: opts.scoreError ? { message: 'boom' } : null,
      })
      return {
        select: () => ({
          eq: () => ({ eq: () => result, in: () => result }),
        }),
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const PHASE = { phaseId: 'ph-1' } as const
const ROW = { itemRowId: 'row-1' } as const

describe('assertDeletableStructure', () => {
  it('allows deleting a phase that holds no saved grades', async () => {
    const res = await assertDeletableStructure(db({ scoreCount: 0 }), 'p1', PHASE)
    expect(res.ok).toBe(true)
  })

  it('allows deleting a phase with no rubric rows at all', async () => {
    // The mid-semester tidy-up case: an empty phase must stay deletable, which is
    // why this guard is scoped to the rows being deleted rather than the project.
    const res = await assertDeletableStructure(db({ rows: [], scoreCount: 5 }), 'p1', PHASE)
    expect(res.ok).toBe(true)
  })

  it('refuses a phase whose rows carry saved grades, and says how many', async () => {
    const res = await assertDeletableStructure(db({ scoreCount: 3 }), 'p1', PHASE)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('3 saved grades')
  })

  it('refuses a single rubric row that carries a saved grade, in the singular', async () => {
    const res = await assertDeletableStructure(db({ scoreCount: 1 }), 'p1', ROW)
    expect(res.ok).toBe(false)
    // Singular for the count. ("clear the grades first" later in the sentence is a
    // different, correct plural, so assert the counted phrase rather than the word.)
    expect(res.ok === false && res.error).toContain('1 saved grade.')
  })

  it('refuses ANY structural delete once grades are released, even with no scores', async () => {
    // Release is the one project-wide bar: students have already seen a number, and
    // grades recompute live on every read, so removing a row moves what they see.
    const res = await assertDeletableStructure(db({ released: true, scoreCount: 0 }), 'p1', PHASE)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('released')
  })

  it('fails CLOSED when the release lookup errors', async () => {
    const res = await assertDeletableStructure(db({ releaseError: true }), 'p1', PHASE)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('Nothing was removed')
  })

  it('fails CLOSED when the score count errors', async () => {
    const res = await assertDeletableStructure(db({ scoreError: true }), 'p1', ROW)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('Nothing was removed')
  })

  it('fails CLOSED when the phase-rows lookup errors', async () => {
    const res = await assertDeletableStructure(db({ rowsError: true }), 'p1', PHASE)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('Nothing was removed')
  })
})
