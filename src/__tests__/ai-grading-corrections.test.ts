// captureGradingCorrections — the calibration flywheel's write path (phase 1a).
//
// Load-bearing behaviours:
//  - Ghost-diff guard: capture happens ONLY when the live suggestion's updated_at matches
//    the version the grader's page rendered (compared as instants — PostgREST serializes
//    the same timestamptz differently from an RPC return vs a table select).
//  - The diff itself: one row per AI-judged criterion, professor_tick from the committed
//    keys, upserted on (submission_id, criterion_key).
//  - Best-effort: read errors, upsert errors, and thrown exceptions never propagate —
//    a capture failure must never fail the grade save it rides on.

import { describe, it, expect, vi } from 'vitest'
import { captureGradingCorrections } from '@/lib/assignments/ai-grading/corrections'
import type { SupabaseClient } from '@supabase/supabase-js'

const SUGG_ROW = {
  institution_id: 'inst-1',
  section_id: 'sec-1',
  assignment_id: 'asn-1',
  student_id: 'stu-1',
  confidence: 'medium',
  model: 'gemini-3-flash-preview',
  updated_at: '2026-09-07T17:00:00.000+00:00',
  rationale: [
    { key: '0:0', tick: true, suggestedPoints: 2, rationale: 'ok', flagged: false, evidence: 'quote a', similarity: null },
    { key: '0:1', tick: false, suggestedPoints: 0, rationale: 'missing', flagged: true, evidence: '', similarity: 0.4 },
  ],
}

/**
 * Admin-client double. The suggestion read now carries the version match as a WHERE
 * clause, so the double records every .eq() filter and only returns `row` when the
 * requested updated_at equals the row's — i.e. it stands in for Postgres doing the
 * comparison, which is where that check now lives.
 */
function makeAdminDb(
  row: Record<string, unknown> | null,
  opts?: { readError?: boolean; upsertError?: boolean },
) {
  const upsertCalls: { rows: Record<string, unknown>[]; onConflict?: string }[] = []
  const filters: Record<string, unknown> = {}
  const db = {
    from: (table: string) => {
      if (table === 'assignment_ai_grade_suggestions') {
        const chain: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            filters[col] = val
            return chain
          },
          maybeSingle: async () => {
            if (opts?.readError) return { data: null, error: { message: 'boom' } }
            // Every filter must be satisfied for a row to come back.
            const matches =
              row !== null &&
              Object.entries(filters).every(([col, val]) => {
                if (col === 'submission_id' || col === 'status') return true // fixture-implied
                return row[col] === val
              })
            return { data: matches ? row : null, error: null }
          },
        }
        return { select: () => chain }
      }
      if (table === 'assignment_grading_corrections') {
        return {
          upsert: async (rows: Record<string, unknown>[], o?: { onConflict?: string }) => {
            upsertCalls.push({ rows, onConflict: o?.onConflict })
            return { error: opts?.upsertError ? { message: 'nope' } : null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db: db as unknown as SupabaseClient, upsertCalls, filters }
}

const baseInput = {
  submissionId: 'sub-1',
  committedRubricScores: ['0:0'],
  graderId: 'prof-1',
  rubricVersion: '2026-09-01T00:00:00Z',
}

describe('captureGradingCorrections', () => {
  it('writes one row per AI criterion with the professor diff on a version match', async () => {
    const { db, upsertCalls } = makeAdminDb(SUGG_ROW)
    await captureGradingCorrections(db, {
      ...baseInput,
      reviewedSuggestionUpdatedAt: '2026-09-07T17:00:00.000+00:00',
    })
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].onConflict).toBe('submission_id,criterion_key')
    const rows = upsertCalls[0].rows
    expect(rows).toHaveLength(2)
    const byKey = Object.fromEntries(rows.map((r) => [r.criterion_key as string, r]))
    // AI ticked 0:0, professor kept it → agreement (agreed is DB-generated, not sent).
    expect(byKey['0:0']).toMatchObject({
      ai_tick: true,
      professor_tick: true,
      ai_points: 2,
      ai_flagged: false,
      ai_has_evidence: true,
      institution_id: 'inst-1',
      section_id: 'sec-1',
      grader_id: 'prof-1',
      rubric_version: '2026-09-01T00:00:00Z',
    })
    // AI rejected 0:1 and the professor also left it unticked.
    expect(byKey['0:1']).toMatchObject({ ai_tick: false, professor_tick: false, ai_has_evidence: false })
  })

  it('captures a professor OVERRIDE: committed tick differs from the AI verdict', async () => {
    const { db, upsertCalls } = makeAdminDb(SUGG_ROW)
    await captureGradingCorrections(db, {
      ...baseInput,
      committedRubricScores: ['0:1'], // professor overturned both of the AI's calls
      reviewedSuggestionUpdatedAt: '2026-09-07T17:00:00.000+00:00',
    })
    const byKey = Object.fromEntries(upsertCalls[0].rows.map((r) => [r.criterion_key as string, r]))
    expect(byKey['0:0']).toMatchObject({ ai_tick: true, professor_tick: false })
    expect(byKey['0:1']).toMatchObject({ ai_tick: false, professor_tick: true })
  })

  it('matches the reviewed version in the QUERY, not in JS', async () => {
    // The version check is a WHERE clause so Postgres compares at full microsecond
    // precision (Date.parse truncates to ms, which would let two drafts stamped inside
    // the same millisecond compare equal) and normalises the ISO form itself.
    const { db, filters } = makeAdminDb(SUGG_ROW)
    await captureGradingCorrections(db, {
      ...baseInput,
      reviewedSuggestionUpdatedAt: '2026-09-07T17:00:00.000+00:00',
    })
    expect(filters.updated_at).toBe('2026-09-07T17:00:00.000+00:00')
    expect(filters.status).toBe('suggested')
    expect(filters.submission_id).toBe('sub-1')
  })

  it('skips capture on a version mismatch (draft re-generated since the page rendered)', async () => {
    const { db, upsertCalls } = makeAdminDb(SUGG_ROW)
    await captureGradingCorrections(db, {
      ...baseInput,
      reviewedSuggestionUpdatedAt: '2026-09-07T16:00:00.000+00:00',
    })
    expect(upsertCalls).toHaveLength(0)
  })

  it('skips capture when no version was supplied, when no live suggestion exists, and on read error', async () => {
    const noVersion = makeAdminDb(SUGG_ROW)
    await captureGradingCorrections(noVersion.db, { ...baseInput, reviewedSuggestionUpdatedAt: undefined })
    expect(noVersion.upsertCalls).toHaveLength(0)

    const noRow = makeAdminDb(null)
    await captureGradingCorrections(noRow.db, {
      ...baseInput,
      reviewedSuggestionUpdatedAt: '2026-09-07T17:00:00.000+00:00',
    })
    expect(noRow.upsertCalls).toHaveLength(0)

    const readErr = makeAdminDb(SUGG_ROW, { readError: true })
    await captureGradingCorrections(readErr.db, {
      ...baseInput,
      reviewedSuggestionUpdatedAt: '2026-09-07T17:00:00.000+00:00',
    })
    expect(readErr.upsertCalls).toHaveLength(0)
  })

  it('never throws — upsert failure and a throwing client both resolve quietly', async () => {
    const upsertErr = makeAdminDb(SUGG_ROW, { upsertError: true })
    await expect(
      captureGradingCorrections(upsertErr.db, {
        ...baseInput,
        reviewedSuggestionUpdatedAt: '2026-09-07T17:00:00.000+00:00',
      }),
    ).resolves.toBeUndefined()

    const throwing = { from: vi.fn(() => { throw new Error('connection lost') }) } as unknown as SupabaseClient
    await expect(
      captureGradingCorrections(throwing, {
        ...baseInput,
        reviewedSuggestionUpdatedAt: '2026-09-07T17:00:00.000+00:00',
      }),
    ).resolves.toBeUndefined()
  })
})
