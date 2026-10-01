/**
 * `itemInSection` — the authorization boundary on the roadmap's node checks.
 *
 * `getMyNodeCheck` and `submitMyNodeCheck` are `'use server'` exports, so both are
 * reachable POST endpoints taking a client-supplied `moduleItemId` and running with
 * the service role. Passing an item the caller shouldn't have is not a read-only
 * mistake: `getNodeCheckForStudent` flips `module_items.node_check_state` to
 * 'pending', enqueues a paid LLM job over that item's content, and hands back
 * questions generated FROM it — a paraphrase of the material, a write, and spend.
 *
 * Enrolment is not the boundary (every classmate is enrolled); the item's own
 * module is. These pin each clause of that join, including the `unlock_date` one:
 * a week the professor hasn't opened is not checkable, and the roadmap having
 * stopped shipping its ids is not a substitute — a professor pushing an already-open
 * week's date back leaves students holding ids that were legitimate a moment ago.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockGetNodeCheckForStudent = vi.fn()
const mockGradeNodeCheck = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/roadmap/node-check', () => ({
  getNodeCheckForStudent: (...a: unknown[]) => mockGetNodeCheckForStudent(...a),
  gradeNodeCheck: (...a: unknown[]) => mockGradeNodeCheck(...a),
  getNodeCheckForProfessor: vi.fn(),
}))
const mockApplyBoost = vi.fn()
vi.mock('@/lib/skills/grade-hook', () => ({
  applyNodeCheckPassToSkillMastery: (...a: unknown[]) => mockApplyBoost(...a),
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let getMyNodeCheck: any
let submitMyNodeCheck: any
/* eslint-enable @typescript-eslint/no-explicit-any */

const SECTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
const PAST = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString()

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER } }, error: null })
  mockAdminClient.mockReset()
  mockGetNodeCheckForStudent.mockReset().mockResolvedValue({ state: 'ready', questions: [] })
  mockGradeNodeCheck.mockReset().mockResolvedValue({ passed: true, correct: 4, total: 5, firstPass: false })
  mockApplyBoost.mockReset().mockResolvedValue(undefined)
  const mod = await import('@/app/(dashboard)/student/courses/[sectionId]/roadmap/actions')
  getMyNodeCheck = mod.getMyNodeCheck
  submitMyNodeCheck = mod.submitMyNodeCheck
})

/** `item` is the row `itemInSection` reads; null models "no predicate matched". */
function db(item: unknown) {
  const chains = {
    enrollments: buildFullChain({ data: { id: 'enr-1' }, error: null }),
    course_sections: buildFullChain({ data: { institution_id: 'inst-1' }, error: null }),
    module_items: buildFullChain({ data: item, error: null }),
  } as Record<string, ReturnType<typeof buildFullChain>>
  mockAdminClient.mockReturnValue({
    from: vi.fn((t: string) => chains[t] ?? buildFullChain({ data: null, error: null })),
  })
  return chains
}

const openItem = { id: ITEM, modules: { unlock_date: null } }

describe('node checks — the item must be in an OPEN module of this section', () => {
  it('serves the check for an item in an open week', async () => {
    db(openItem)
    const res = await getMyNodeCheck(SECTION, ITEM)
    expect(res.error).toBeUndefined()
    expect(mockGetNodeCheckForStudent).toHaveBeenCalledTimes(1)
  })

  /* The expensive half: refusing must happen BEFORE the generator runs, or the
     refusal still costs an LLM call and still flips node_check_state. */
  it('refuses an item whose week has not opened yet, without generating anything', async () => {
    db({ id: ITEM, modules: { unlock_date: FUTURE() } })
    const res = await getMyNodeCheck(SECTION, ITEM)
    expect(res.error).toBe('Item not found in this course')
    expect(mockGetNodeCheckForStudent).not.toHaveBeenCalled()
  })

  // Submitting is a write plus a grade — the same gate, not just the read path.
  it('refuses a submission against a week that has not opened yet', async () => {
    db({ id: ITEM, modules: { unlock_date: FUTURE() } })
    const res = await submitMyNodeCheck(SECTION, ITEM, [0, 1, 2, 3, 0])
    expect(res.error).toBe('Item not found in this course')
    expect(mockGradeNodeCheck).not.toHaveBeenCalled()
  })

  it('allows it once the open date has passed', async () => {
    db({ id: ITEM, modules: { unlock_date: PAST() } })
    const res = await submitMyNodeCheck(SECTION, ITEM, [0, 1, 2, 3, 0])
    expect(res.error).toBeUndefined()
    expect(mockGradeNodeCheck).toHaveBeenCalledTimes(1)
  })

  it('applies the mastery boost on a FIRST pass only, and never leaks firstPass to the client', async () => {
    // First pass: the boost hook fires, but the response stays the tally the
    // panel renders — `firstPass` is server bookkeeping. A future
    // `return { data: result }` would silently undo this narrowing.
    mockGradeNodeCheck.mockResolvedValue({ passed: true, correct: 5, total: 5, firstPass: true })
    db({ id: ITEM, modules: { unlock_date: PAST() } })
    const res = await submitMyNodeCheck(SECTION, ITEM, [0, 1, 2, 3, 0])
    expect(res.data).toEqual({ passed: true, correct: 5, total: 5 })
    expect(res.data).not.toHaveProperty('firstPass')
    expect(mockApplyBoost).toHaveBeenCalledExactlyOnceWith({ sectionId: SECTION, studentId: USER, moduleItemId: ITEM })

    // Re-submit after passing: still passed, but no second boost.
    mockApplyBoost.mockClear()
    mockGradeNodeCheck.mockResolvedValue({ passed: true, correct: 5, total: 5, firstPass: false })
    db({ id: ITEM, modules: { unlock_date: PAST() } })
    await submitMyNodeCheck(SECTION, ITEM, [0, 1, 2, 3, 0])
    expect(mockApplyBoost).not.toHaveBeenCalled()
  })

  it('refuses an item that matches no row (foreign section, hidden, or wrong type)', async () => {
    db(null)
    const res = await getMyNodeCheck(SECTION, ITEM)
    expect(res.error).toBe('Item not found in this course')
    expect(mockGetNodeCheckForStudent).not.toHaveBeenCalled()
  })

  it('constrains the lookup by section, published module, visibility and item type', async () => {
    const chains = db(openItem)
    await getMyNodeCheck(SECTION, ITEM)
    const items = chains.module_items
    expect(items.eq).toHaveBeenCalledWith('id', ITEM)
    expect(items.eq).toHaveBeenCalledWith('modules.section_id', SECTION)
    expect(items.eq).toHaveBeenCalledWith('modules.is_published', true)
    expect(items.eq).toHaveBeenCalledWith('is_visible', true)
    expect(items.in).toHaveBeenCalledWith('item_type', expect.any(Array))
    // unlock_date has to be SELECTED, or the JS-side check reads undefined and
    // silently passes every locked week.
    expect(items.select).toHaveBeenCalledWith(expect.stringContaining('unlock_date'))
    // An inner join — a LEFT join would return the item with a null module.
    expect(items.select).toHaveBeenCalledWith(expect.stringContaining('modules!inner'))
  })

  it('refuses a caller who is not enrolled', async () => {
    mockAdminClient.mockReturnValue({
      from: vi.fn(() => buildFullChain({ data: null, error: null })),
    })
    const res = await getMyNodeCheck(SECTION, ITEM)
    expect(res.error).toBe('Not enrolled in this course')
    expect(mockGetNodeCheckForStudent).not.toHaveBeenCalled()
  })

  it('never reaches the database for an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
    const res = await getMyNodeCheck(SECTION, ITEM)
    expect(res.error).toBe('Not authenticated')
    expect(mockAdminClient).not.toHaveBeenCalled()
  })
})
