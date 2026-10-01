// @vitest-environment node
//
// persistGeneratedBatch is the route-side path that saves each generated batch
// to the draft quiz AS IT STREAMS (docs/designs/quizzes/quiz-generation-v2.md). The
// live e2e (tmp/verify-gen-ownership.mjs) only ever feeds it well-formed AI
// output where every question passes strict validation and both inserts
// succeed — so these branches are UNTESTED by e2e and are exactly where a
// subtle bug lands the wrong dbId on a question (→ studio autosave re-creates
// or mis-assigns) or leaks orphan bank rows:
//   1. id ALIGNMENT across a validation skip — the returned ids[] must map to
//      ORIGINAL input positions, not to compacted row positions.
//   2. all-invalid short-circuit — no DB write, position unchanged.
//   3. question-insert failure — all-null, position unchanged, no assignment.
//   4. assignment-insert failure — cleanup DELETE removes the just-inserted
//      bank rows (or they become invisible orphans in "Pick from bank").
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import { persistGeneratedBatch, nextAssignmentPosition } from '@/lib/quiz/ai-generation'
import type { GeneratedQuestion } from '@/lib/ai/llm-client'

const SECTION = 'section-1'
const QUIZ = 'quiz-1'

// A GeneratedQuestion that PASSES createQuestionServerSchema (valid MC content).
const validQ = (text: string): GeneratedQuestion =>
  ({
    questionText: text,
    content: {
      questionType: 'multiple_choice',
      choices: [
        { id: 'a', text: 'right', isCorrect: true },
        { id: 'b', text: 'wrong', isCorrect: false },
      ],
      allowMultiple: false,
    },
    difficulty: 'easy',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

// FAILS the strict schema — empty stem violates questionText.min(1).
const invalidQ = (): GeneratedQuestion =>
  ({
    questionText: '',
    content: {
      questionType: 'multiple_choice',
      choices: [
        { id: 'a', text: 'right', isCorrect: true },
        { id: 'b', text: 'wrong', isCorrect: false },
      ],
      allowMultiple: false,
    },
    difficulty: 'easy',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

type Row = { id: string }

/** Minimal admin-client double. Question insert / assignment insert are awaited
 *  directly (no .single()), so they must be thenables; the cleanup delete chains
 *  .delete().in().eq() then awaits. Captures what each op received. */
function makeAdminDb(opts: {
  questionInsertError?: unknown
  assignmentInsertError?: unknown
} = {}) {
  const captured = {
    insertedQuestions: null as Row[] | null,
    insertedAssignments: null as { quiz_id: string; question_id: string; position: number }[] | null,
    deletedIds: null as string[] | null,
    deletedSection: null as string | null,
  }
  const questionInsert = vi.fn((rows: Row[]) => {
    captured.insertedQuestions = rows
    return Promise.resolve({ error: opts.questionInsertError ?? null })
  })
  const assignmentInsert = vi.fn(
    (rows: { quiz_id: string; question_id: string; position: number }[]) => {
      captured.insertedAssignments = rows
      return Promise.resolve({ error: opts.assignmentInsertError ?? null })
    },
  )
  const db = {
    from(table: string) {
      if (table === 'quiz_questions') {
        return {
          insert: questionInsert,
          delete: () => ({
            in: (_col: string, ids: string[]) => ({
              eq: (_c: string, section: string) => {
                captured.deletedIds = ids
                captured.deletedSection = section
                return Promise.resolve({ error: null })
              },
            }),
          }),
        }
      }
      if (table === 'quiz_question_assignments') {
        return { insert: assignmentInsert }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }
  return { db: db as unknown as SupabaseClient<Database>, captured, questionInsert, assignmentInsert }
}

describe('persistGeneratedBatch', () => {
  it('happy path — ids align to input, positions are contiguous from startPosition', async () => {
    const { db, captured } = makeAdminDb()
    const res = await persistGeneratedBatch(db, SECTION, QUIZ, [validQ('Q1'), validQ('Q2')], 5)

    expect(res.ids).toHaveLength(2)
    expect(res.ids.every((id) => typeof id === 'string')).toBe(true)
    expect(res.nextPosition).toBe(7)
    // Assignment rows point at the SAME ids returned, at positions 5,6.
    expect(captured.insertedAssignments).toEqual([
      { quiz_id: QUIZ, question_id: res.ids[0], position: 5 },
      { quiz_id: QUIZ, question_id: res.ids[1], position: 6 },
    ])
  })

  it('validation skip — the skipped slot returns null and the rest keep their INPUT index', async () => {
    const { db, captured } = makeAdminDb()
    // [valid, INVALID, valid] — the middle one fails strict validation.
    const res = await persistGeneratedBatch(
      db,
      SECTION,
      QUIZ,
      [validQ('Q0'), invalidQ(), validQ('Q2')],
      0,
    )

    // The critical assertion: ids map to ORIGINAL positions, not row positions.
    // A naive implementation would return [id, id, null] and mis-tag Q2.
    expect(res.ids[1]).toBeNull()
    expect(res.ids[0]).toBe(captured.insertedQuestions![0].id)
    expect(res.ids[2]).toBe(captured.insertedQuestions![1].id)
    expect(res.nextPosition).toBe(2) // only 2 rows persisted
    // Only the two valid rows were inserted, at contiguous positions 0,1.
    expect(captured.insertedQuestions).toHaveLength(2)
    expect(captured.insertedAssignments!.map((a) => a.position)).toEqual([0, 1])
  })

  it('all invalid — no DB write, position unchanged, all-null ids', async () => {
    const { db, questionInsert, assignmentInsert } = makeAdminDb()
    const res = await persistGeneratedBatch(db, SECTION, QUIZ, [invalidQ(), invalidQ()], 3)

    expect(res.ids).toEqual([null, null])
    expect(res.nextPosition).toBe(3)
    expect(questionInsert).not.toHaveBeenCalled()
    expect(assignmentInsert).not.toHaveBeenCalled()
  })

  it('question insert fails — all-null, position unchanged, no assignment attempted', async () => {
    const { db, assignmentInsert } = makeAdminDb({ questionInsertError: { message: 'boom' } })
    const res = await persistGeneratedBatch(db, SECTION, QUIZ, [validQ('Q1'), validQ('Q2')], 4)

    expect(res.ids).toEqual([null, null])
    expect(res.nextPosition).toBe(4)
    expect(assignmentInsert).not.toHaveBeenCalled()
  })

  it('assignment insert fails — cleanup deletes the just-inserted bank rows (no orphans)', async () => {
    const { db, captured } = makeAdminDb({ assignmentInsertError: { message: 'fk violation' } })
    const res = await persistGeneratedBatch(db, SECTION, QUIZ, [validQ('Q1'), validQ('Q2')], 0)

    expect(res.ids).toEqual([null, null]) // batch reported unpersisted
    expect(res.nextPosition).toBe(0)
    // The two orphaned bank rows are cleaned up, scoped to the section.
    expect(captured.deletedIds).toEqual(captured.insertedQuestions!.map((r) => r.id))
    expect(captured.deletedSection).toBe(SECTION)
  })
})

describe('nextAssignmentPosition', () => {
  it('returns 0 when the quiz has no assignments', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [] }) }) }),
        }),
      }),
    } as unknown as SupabaseClient<Database>
    expect(await nextAssignmentPosition(db, QUIZ)).toBe(0)
  })

  it('returns max position + 1', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [{ position: 4 }] }) }) }),
        }),
      }),
    } as unknown as SupabaseClient<Database>
    expect(await nextAssignmentPosition(db, QUIZ)).toBe(5)
  })
})
