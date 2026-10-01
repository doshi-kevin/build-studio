// Node checks — dealing and grading (docs/designs/roadmap-mastery/roadmap-engine.md §14.2).
//
// These four rules are pure logic that happens to sit between DB calls, so they
// are pinned here rather than left to e2e (same boundary as roadmap-signals):
//
//   - the five are dealt ONCE and stay dealt, so a retry is the same check
//     rather than a reroll until an easy draw appears;
//   - a regenerated pool re-deals but KEEPS a prior pass, so a student doesn't
//     lose a coverage tick because the professor replaced the file;
//   - once passed, stay passed;
//   - answers are scored positionally against `question_ids`, NOT against the
//     order Postgres happens to return `.in()` rows in.
//
// The last one is the reason this file exists: iterating the returned rows
// instead of the dealt ids is the obvious "simplification", it type-checks, and
// it silently scores every answer against the wrong question.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockEnqueue = vi.fn()
/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('@/lib/jobs/enqueue', () => ({ enqueueJob: (...a: unknown[]) => mockEnqueue(...a) }))
/* #730 — this file failed roughly one run in three, always the same case, always a 5s
   TIMEOUT rather than an assertion. logEvent was unmocked, and the 'none' branch is the only
   one that reaches it, so that single test was building a real Supabase client and awaiting a
   real network write. Hence load-sensitive: green on an idle machine, red under CI. A fully
   mocked unit test has no business doing I/O. */
const mockLogEvent = vi.fn(async (..._a: unknown[]) => undefined)
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }))
// Stubbed so importing the module under test doesn't drag in the `ai` SDK.
vi.mock('@/lib/jobs/pipelines/node-check-pool', () => ({ NODE_CHECK_POOL_JOB_TYPE: 'node_check_pool' }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { getNodeCheckForStudent, gradeNodeCheck } from '@/lib/roadmap/node-check'
import { NODE_CHECK_DEAL, NODE_CHECK_PASS } from '@/lib/ai/config'

const SECTION = 'sec-1'
const INST = 'inst-1'
const ITEM = 'item-1'
const STUDENT = 'stu-1'

interface QRow {
  id: string
  prompt: string
  choices: string[]
  answer_index: number
}

/** A 15-question pool; question `q<i>` has its key at index i % 4. */
const POOL: QRow[] = Array.from({ length: 15 }, (_, i) => ({
  id: `q${i}`,
  prompt: `Question ${i}?`,
  choices: ['a', 'b', 'c', 'd'],
  answer_index: i % 4,
}))

/**
 * Minimal admin-client double. Every read for a table returns the same fixture
 * regardless of the select string — that is deliberate for the answer-key test:
 * a widened `.select()` would start leaking `answer_index`, and only a fake that
 * always hands back the full row can catch it.
 */
function makeDb(opts: {
  item?: Record<string, unknown> | null
  attempt?: Record<string, unknown> | null
  questions?: QRow[]
  /** Hand `.in()` rows back in reverse, as an unordered DB read may. */
  reverseRows?: boolean
}) {
  const questions = opts.questions ?? POOL
  const calls = {
    upserts: [] as Record<string, unknown>[],
    updates: [] as { table: string; patch: Record<string, unknown> }[],
    /** Every `.eq(col, val)` predicate, tagged with the table it narrowed. */
    filters: [] as { table: string; col: string; val: unknown }[],
  }

  const from = (table: string) => {
    let inIds: string[] | null = null
    const result = () => {
      if (table === 'node_check_questions') {
        const rows = inIds ? questions.filter((q) => inIds!.includes(q.id)) : questions
        return { data: opts.reverseRows ? [...rows].reverse() : rows, error: null }
      }
      if (table === 'module_items') return { data: opts.item ?? null, error: null }
      if (table === 'node_check_attempts') return { data: opts.attempt ?? null, error: null }
      return { data: null, error: null }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        calls.filters.push({ table, col, val })
        return chain
      },
      in: (_col: string, ids: string[]) => {
        inIds = ids
        return chain
      },
      maybeSingle: async () => result(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      upsert: (payload: any) => {
        calls.upserts.push(payload)
        return chain
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: (patch: any) => {
        calls.updates.push({ table, patch })
        return chain
      },
      // Thenable: the module awaits some chains without a terminal call.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (res: any, rej: any) => Promise.resolve(result()).then(res, rej),
    }
    return chain
  }

  return { db: { from }, calls }
}

const deal = (db: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNodeCheckForStudent(db as any, {
    sectionId: SECTION,
    institutionId: INST,
    moduleItemId: ITEM,
    studentId: STUDENT,
  })

const readyItem = (poolVersion = 1) => ({
  node_check_state: 'ready',
  node_check_pool_version: poolVersion,
})

describe('getNodeCheckForStudent — the deal', () => {
  beforeEach(() => {
    mockEnqueue.mockReset()
    mockEnqueue.mockResolvedValue({ jobId: 'j1', alreadyActive: false, kicked: true })
  })

  it('falls back to a self check-off when there is nothing worth testing', async () => {
    const { db } = makeDb({ item: { node_check_state: 'not_quizzable', node_check_pool_version: 0 } })
    expect(await deal(db)).toEqual({ kind: 'not_quizzable' })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('enqueues generation on the first open and reports preparing', async () => {
    const { db, calls } = makeDb({ item: { node_check_state: 'none', node_check_pool_version: 0 } })
    expect(await deal(db)).toEqual({ kind: 'preparing' })
    expect(calls.updates).toContainEqual({ table: 'module_items', patch: { node_check_state: 'pending' } })
    // subjectKey is what stops a whole class opening the node from queueing 60 jobs.
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ subjectKey: ITEM, institutionId: INST }))
    /* The spend audit. This path mutates state AND enqueues a paid model call, so the code
       treats this as the only record of who triggered it. */
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'roadmap.node_check_pool_requested' }),
    )
  })

  it('does not re-enqueue while generation is already running', async () => {
    const { db } = makeDb({ item: { node_check_state: 'pending', node_check_pool_version: 0 } })
    expect(await deal(db)).toEqual({ kind: 'preparing' })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('deals five and, on a second open, deals the SAME five', async () => {
    const first = makeDb({ item: readyItem(), attempt: null })
    const dealt = await deal(first.db)
    expect(dealt.kind).toBe('ready')
    if (dealt.kind !== 'ready') return
    expect(dealt.questions).toHaveLength(NODE_CHECK_DEAL)
    expect(first.calls.upserts).toHaveLength(1)

    // Re-open with the attempt the first deal wrote.
    const stored = first.calls.upserts[0].question_ids as string[]
    const second = makeDb({
      item: readyItem(),
      attempt: { question_ids: stored, answers: [], passed: false, tries: 0, pool_version: 1 },
    })
    const again = await deal(second.db)
    if (again.kind !== 'ready') throw new Error('expected ready')
    expect(again.questions.map((q) => q.id)).toEqual(stored)
    // No reroll — otherwise a student could reopen until they got an easy draw.
    expect(second.calls.upserts).toHaveLength(0)
  })

  it('re-deals against a regenerated pool but keeps a prior pass', async () => {
    const { db, calls } = makeDb({
      item: readyItem(2),
      attempt: { question_ids: ['q0', 'q1', 'q2', 'q3', 'q4'], answers: [0, 1, 2, 3, 0], passed: true, tries: 3, pool_version: 1 },
    })
    const res = await deal(db)
    expect(res.kind).toBe('ready')

    expect(calls.upserts).toHaveLength(1)
    const up = calls.upserts[0]
    expect(up.pool_version).toBe(2)
    expect(up.question_ids).toHaveLength(NODE_CHECK_DEAL)
    expect(up.answers).toEqual([])
    // The tick survives the professor replacing the file.
    expect(up.passed).toBe(true)
    expect(up.tries).toBe(3)
    // Tenant columns, or the row is unreachable by every scoped read.
    expect(up.institution_id).toBe(INST)
    expect(up.section_id).toBe(SECTION)
  })

  it('never hands the student an answer key', async () => {
    // The fake returns full pool rows including answer_index; nothing may survive.
    const { db } = makeDb({ item: readyItem(), attempt: null })
    const res = await deal(db)
    if (res.kind !== 'ready') throw new Error('expected ready')
    for (const q of res.questions) {
      expect(Object.keys(q).sort()).toEqual(['choices', 'id', 'prompt', 'selected'])
    }
    expect(JSON.stringify(res)).not.toMatch(/answer_?[iI]ndex/)
  })

  it('does not restore picks on a FAILED attempt — that would be a per-question oracle', async () => {
    /* Reopening a failed check with the previous picks restored lets a student
       flip exactly one answer and read the ±1 in the tally as that question's
       key — five rounds gives the whole set. The panel clears picks after a
       failed submit, but that is client-side and a card-close undid it. */
    const dealt = ['q0', 'q1', 'q2', 'q3', 'q4']
    const { db } = makeDb({
      item: readyItem(),
      attempt: { question_ids: dealt, answers: [0, 1, 2, 3, 0], passed: false, tries: 1, pool_version: 1 },
    })
    const res = await deal(db)
    if (res.kind !== 'ready') throw new Error('expected ready')
    expect(res.questions.map((q) => q.selected)).toEqual([null, null, null, null, null])
    expect(res.tries).toBe(1)
  })

  it('does restore picks once the attempt has PASSED — no retry left to exploit', async () => {
    const dealt = ['q0', 'q1', 'q2', 'q3', 'q4']
    const { db } = makeDb({
      item: readyItem(),
      attempt: { question_ids: dealt, answers: [0, 1, 2, 3, 0], passed: true, tries: 2, pool_version: 1 },
    })
    const res = await deal(db)
    if (res.kind !== 'ready') throw new Error('expected ready')
    expect(res.questions.map((q) => q.selected)).toEqual([0, 1, 2, 3, 0])
  })

  // Same defence-in-depth rule the grading path follows: the pool read and the
  // attempt read carry the section on the statement, not only in the caller.
  it('scopes the pool and attempt reads to the section it was called for', async () => {
    const { db, calls } = makeDb({ item: readyItem(), attempt: null })
    await deal(db)
    const scoped = (table: string) =>
      calls.filters.some((f) => f.table === table && f.col === 'section_id' && f.val === SECTION)
    expect(scoped('node_check_attempts')).toBe(true)
    expect(scoped('node_check_questions')).toBe(true)
  })
})

describe('gradeNodeCheck', () => {
  const dealt = ['q0', 'q1', 'q2', 'q3', 'q4']
  /** The key for each dealt question, in dealt order. */
  const keys = dealt.map((id) => POOL.find((q) => q.id === id)!.answer_index)
  const wrong = (i: number) => (keys[i] + 1) % 4

  const grade = (db: unknown, answers: (number | null)[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gradeNodeCheck(db as any, { sectionId: SECTION, moduleItemId: ITEM, studentId: STUDENT, answers })

  it(`passes on ${NODE_CHECK_PASS} of ${NODE_CHECK_DEAL} and bumps tries`, async () => {
    const { db, calls } = makeDb({ attempt: { question_ids: dealt, passed: false, tries: 2 } })
    const answers = [...keys]
    answers[4] = wrong(4)
    expect(await grade(db, answers)).toEqual({ passed: true, correct: 4, total: 5, firstPass: true })
    expect(calls.updates[0].patch).toMatchObject({ passed: true, tries: 3 })
  })

  it(`does not pass on ${NODE_CHECK_PASS - 1} of ${NODE_CHECK_DEAL}`, async () => {
    const { db } = makeDb({ attempt: { question_ids: dealt, passed: false, tries: 0 } })
    const answers = [...keys]
    answers[3] = wrong(3)
    answers[4] = wrong(4)
    expect(await grade(db, answers)).toEqual({ passed: false, correct: 3, total: 5, firstPass: false })
  })

  it('scores positionally against the dealt ids, not the order rows come back in', async () => {
    // q0..q4 have keys 0,1,2,3,0 — so a row-order mix-up changes the tally.
    const { db } = makeDb({ attempt: { question_ids: dealt, passed: false, tries: 0 }, reverseRows: true })
    expect(await grade(db, keys)).toEqual({ passed: true, correct: 5, total: 5, firstPass: true })
  })

  it('once passed, stays passed', async () => {
    const { db, calls } = makeDb({ attempt: { question_ids: dealt, passed: true, tries: 4 } })
    const allWrong = keys.map((_, i) => wrong(i))
    const res = await grade(db, allWrong)
    // firstPass false is what keeps the mastery boost single-shot: a
    // re-submit after passing must never read as a fresh pass.
    expect(res).toEqual({ passed: true, correct: 0, total: 5, firstPass: false })
    // The persisted row must not revoke the tick either — coverage reads `passed`.
    expect(calls.updates[0].patch).toMatchObject({ passed: true })
  })

  it('returns null when the student was never dealt anything', async () => {
    const { db, calls } = makeDb({ attempt: null })
    expect(await grade(db, [0, 0, 0, 0, 0])).toBeNull()
    expect(calls.updates).toHaveLength(0)
  })

  /* Defence in depth on the answer key. The calling action runs itemInSection
     first, so today the tenant boundary lives entirely in the caller — one
     refactor away from these statements addressing an attempt, or an answer key,
     in a different section. `node_check_questions.answer_index` is the one column
     in this feature where an over-broad read is a real leak rather than a
     nuisance, so the predicate belongs on the statement itself. */
  it('scopes every statement to the section it was called for', async () => {
    const { db, calls } = makeDb({ attempt: { question_ids: dealt, passed: false, tries: 0 } })
    await grade(db, keys)
    const scoped = (table: string) =>
      calls.filters.some((f) => f.table === table && f.col === 'section_id' && f.val === SECTION)
    expect(scoped('node_check_attempts')).toBe(true) // the read AND the write
    expect(scoped('node_check_questions')).toBe(true) // the answer key
    // The update is narrowed, not a blanket write across the table.
    expect(calls.filters.filter((f) => f.table === 'node_check_attempts' && f.col === 'section_id'))
      .toHaveLength(2)
  })
})
