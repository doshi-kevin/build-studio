// Guard + wiring tests for getRoadmapData, the RLS-bypassing (admin-client) read
// behind the whole roadmap page — one copy per role.
//
// Why wiring is worth a test: both copies hand-assemble a POSITIONAL argument
// list for assembleRoadmapData (modules, items, edges, resources, topicPageHits,
// moduleDividers) out of `adminDb` results that are all typed `any`. Swapping two
// of those positions compiles clean and silently empties a whole layer of the
// canvas, so tsc cannot be the safety net here. Retiring the old roadmap removed
// two arguments from the middle of that list (statuses, manualNodes), which is
// exactly when a shuffle happens.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

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
vi.mock('@/lib/supabase/signed-urls', () => ({ signModuleItemContent: vi.fn(async (x) => x) }))
vi.mock('@/lib/supabase/queries', () => ({
  roadmapQueries: {
    // No resources — the wiring under test is the module/item/edge/divider
    // ordering; resource passthrough is covered by roadmap-resource-nodes.test.ts.
    getSectionResources: vi.fn(async () => ({
      quizzes: [], quizSkillNames: new Map(), assignments: [], sessions: [], polls: [], liveQuizzes: [],
    })),
  },
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let profGetRoadmapData: any
let stuGetRoadmapData: any
/* eslint-enable @typescript-eslint/no-explicit-any */

const SECTION = 'sec-1'
const USER = 'user-1'

const MODULES = [{ id: 'M1', title: 'Week 1', description: '', week_number: 1, position: 0 }]
const ITEMS = [{
  id: 'I1', module_id: 'M1', item_type: 'lecture', title: 'Intro',
  description: '', position: 0, content: {},
}]
const EDGES = [{
  id: 'e1', from_node_type: 'module', from_node_id: 'M1',
  to_node_type: 'module_item', to_node_id: 'I1', edge_type: 'related', position: 0,
}]
const DIVIDERS = [{ id: 'MD1', title: 'Midterm', position: 1 }]

/**
 * A query chain that is BOTH awaitable (`await from(...).select(...).eq(...)`)
 * and terminal-readable (`.single()`), so one builder serves the section lookup
 * and the four parallel list queries.
 */
function chainFor(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'is', 'neq', 'order', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain.single = vi.fn().mockResolvedValue(result)
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  chain.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(ok, err)
  return chain
}

/** Route `from()` by table so each query resolves independently. */
function adminFor(byTable: Record<string, { data: unknown; error: unknown }>) {
  return {
    from: vi.fn((table: string) => chainFor(byTable[table] ?? { data: [], error: null })),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }
}

/** Every table the happy path reads, with one of each row kind. */
function fullRoadmap(gate: Record<string, { data: unknown; error: unknown }>) {
  return adminFor({
    ...gate,
    modules: { data: MODULES, error: null },
    module_items: { data: ITEMS, error: null },
    roadmap_edges: { data: EDGES, error: null },
    module_dividers: { data: DIVIDERS, error: null },
  })
}

const OWNED = { course_sections: { data: { id: SECTION, professor_id: USER }, error: null } }
const ENROLLED = { enrollments: { data: { id: 'enr-1' }, error: null } }

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()

  const prof = await import('@/app/(dashboard)/professor/courses/[sectionId]/roadmap/actions')
  const stu = await import('@/app/(dashboard)/student/courses/[sectionId]/roadmap/actions')
  profGetRoadmapData = prof.getRoadmapData
  stuGetRoadmapData = stu.getRoadmapData
})

function authed() {
  mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null })
}
function unauthed() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

describe('getRoadmapData (professor) — authz guard', () => {
  it('refuses unauthenticated callers without touching the DB', async () => {
    unauthed()
    const res = await profGetRoadmapData(SECTION)
    expect(res.error).toBeTruthy()
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('refuses a professor who does not own the section', async () => {
    authed()
    const admin = fullRoadmap({
      course_sections: { data: { id: SECTION, professor_id: 'other-prof' }, error: null },
    })
    mockAdminClient.mockReturnValue(admin)
    const res = await profGetRoadmapData(SECTION)
    expect(res.error).toMatch(/do not own/i)
    expect(res.data).toBeUndefined()
    /* The page 404s on `denied` and throws a retry surface on a bare `error`.
       A denial reaching the retry surface offers a TA/grader — who passes the
       course layout's looser verifySectionAccess gate — a "Try again" that can
       never succeed, and admits the section exists. */
    expect(res.denied).toBe(true)
    // Refused before reading any course content, not after.
    expect(admin.from).not.toHaveBeenCalledWith('modules')
  })

  it('does NOT mark a broken query as denied — that one belongs on the retry surface', async () => {
    authed()
    const admin = adminFor({
      ...OWNED,
      modules: { data: null, error: { message: 'connection reset' } },
    })
    mockAdminClient.mockReturnValue(admin)
    const res = await profGetRoadmapData(SECTION)
    expect(res.error).toBeTruthy()
    expect(res.denied).toBeUndefined()
  })
})

describe('getRoadmapData (student) — enrollment guard', () => {
  it('refuses unauthenticated callers without touching the DB', async () => {
    unauthed()
    const res = await stuGetRoadmapData(SECTION)
    expect(res.error).toBeTruthy()
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('refuses a student not enrolled in the section', async () => {
    authed()
    const admin = fullRoadmap({ enrollments: { data: null, error: null } })
    mockAdminClient.mockReturnValue(admin)
    const res = await stuGetRoadmapData(SECTION)
    expect(res.error).toMatch(/not enrolled/i)
    expect(res.data).toBeUndefined()
    // Same discrimination as the professor guard — the page 404s on this.
    expect(res.denied).toBe(true)
    expect(admin.from).not.toHaveBeenCalledWith('modules')
  })

  it('does NOT mark a broken query as denied', async () => {
    authed()
    const admin = adminFor({
      ...ENROLLED,
      modules: { data: null, error: { message: 'connection reset' } },
    })
    mockAdminClient.mockReturnValue(admin)
    const res = await stuGetRoadmapData(SECTION)
    expect(res.error).toBeTruthy()
    expect(res.denied).toBeUndefined()
  })
})

// Each role assembles its own copy of the positional argument list, so each is
// pinned separately — a shuffle in one is invisible from the other.
describe.each([
  ['professor', () => profGetRoadmapData, OWNED],
  ['student', () => stuGetRoadmapData, ENROLLED],
] as const)('getRoadmapData (%s) — DTO wiring', (_role, action, gate) => {
  it('lands modules, items, edges and dividers on their own DTO fields', async () => {
    authed()
    mockAdminClient.mockReturnValue(fullRoadmap(gate))
    const { data, error } = await action()(SECTION)

    expect(error).toBeUndefined()
    expect(data.weeks.map((w: { id: string }) => w.id)).toEqual(['M1'])
    expect(data.weeks[0].items.map((i: { id: string }) => i.id)).toEqual(['I1'])
    // roadmap_edges → edges (kept: both endpoints resolve to a live box above).
    expect(data.edges).toEqual([
      {
        id: 'e1', fromType: 'module', fromId: 'M1', toType: 'module_item', toId: 'I1',
        edgeType: 'related', position: 0,
      },
    ])
    // module_dividers → moduleDividers, NOT confused with the section_divider
    // items that live inside a module.
    expect(data.moduleDividers).toEqual([{ id: 'MD1', title: 'Midterm', position: 1 }])
  })
})

/* A week behind a future unlock_date is published but not open yet. The student
   loader is the gate: it must neither fetch nor return its contents — the map
   only gets the shell. The professor copy never selects unlock_date, so nothing
   locks there (covered in auto-roadmap-assembly.test.ts). */
describe('getRoadmapData (student) — locked weeks', () => {
  const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
  const TWO_MODULES = [
    { id: 'M1', title: 'Week 1', description: '', week_number: 1, position: 0, unlock_date: null },
    { id: 'M2', title: 'Week 8', description: '', week_number: 8, position: 1, unlock_date: FUTURE },
  ]
  // The mock ignores filters, so it hands back BOTH weeks' items — which is what
  // makes the assertions below meaningful: only the gate can drop I2.
  const BOTH_ITEMS = [
    ...ITEMS,
    { id: 'I2', module_id: 'M2', item_type: 'lecture', title: 'Unreleased', description: '', position: 0, content: {} },
  ]

  it('scopes the item fetch to open weeks and returns the locked one as a shell', async () => {
    authed()
    /* One chain per table so the module_items filter args can be read back. */
    const chains: Record<string, ReturnType<typeof chainFor>> = {
      enrollments: chainFor({ data: { id: 'enr-1' }, error: null }),
      modules: chainFor({ data: TWO_MODULES, error: null }),
      module_items: chainFor({ data: BOTH_ITEMS, error: null }),
      roadmap_edges: chainFor({ data: [], error: null }),
      module_dividers: chainFor({ data: [], error: null }),
    }
    mockAdminClient.mockReturnValue({
      from: vi.fn((t: string) => chains[t] ?? chainFor({ data: [], error: null })),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    })

    const { data, error } = await stuGetRoadmapData(SECTION)
    expect(error).toBeUndefined()

    // The locked week's items were never asked for — so no signed file URL is
    // minted for material the student can't open yet.
    expect(chains.module_items.in).toHaveBeenCalledWith('module_id', ['M1'])
    // It still renders (the road ahead), carrying its title and open date only.
    expect(data.weeks.map((w: { id: string }) => w.id)).toEqual(['M1', 'M2'])
    expect(data.weeks[1]).toMatchObject({ locked: true, unlockDate: FUTURE })
    expect(data.weeks[1].items).toEqual([])
    expect(data.weeks[0].items.map((i: { id: string }) => i.id)).toEqual(['I1'])
  })
})
