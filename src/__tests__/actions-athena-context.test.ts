// Guard + document-filter tests for getAthenaContext — the Athena shell's
// first-open bootstrap. It reads via the RLS-bypassing admin client, so the
// auth/enrollment guards must refuse before any DB op, and the citable-doc
// list must expose only preview-able file types. Mirrors the mocking style of
// actions-roadmap-journeys.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let getAthenaContext: any
let hasActiveQuizAttempt: any
/* eslint-enable @typescript-eslint/no-explicit-any */

const SECTION = 'sec-1'
const USER = 'user-1'

/**
 * A per-table admin client. `tables` maps a table name to the result its
 * query resolves to. getAthenaContext's list queries are awaited directly
 * (…eq/…limit/…in), so each chain must be thenable; the enrollment probe
 * ends in .single(), which resolves independently.
 */
function adminWith(tables: Record<string, { data: unknown; error?: unknown }>) {
  const fromSpy = vi.fn((table: string) => {
    const result = tables[table] ?? { data: null }
    const chain: Record<string, unknown> = {}
    // `or` carries the module-unlock gate (openModuleFilter) — drifted in when
    // main's unlock port landed; without it the action's catch-all eats a
    // TypeError and every assertion sees "An unexpected error occurred". `lt` is
    // here for the same reason for `getMessages`, so this helper stays reusable.
    for (const m of ['select', 'eq', 'in', 'or', 'lt', 'order', 'limit']) {
      chain[m] = vi.fn().mockReturnValue(chain)
    }
    chain.single = vi.fn().mockResolvedValue(result)
    // thenable: `await adminDb.from(t).select()...` resolves to `result`
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
    return chain
  })
  return { from: fromSpy, __fromSpy: fromSpy }
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  const mod = await import(
    '@/app/(dashboard)/student/courses/[sectionId]/ai-tutor/actions'
  )
  getAthenaContext = mod.getAthenaContext
  hasActiveQuizAttempt = mod.hasActiveQuizAttempt
})

function authed() {
  mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null })
}
function unauthed() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

describe('getAthenaContext — authz guards', () => {
  it('refuses unauthenticated callers without touching the admin DB', async () => {
    unauthed()
    const res = await getAthenaContext(SECTION)
    expect(res.data).toBeNull()
    expect(res.error).toBeTruthy()
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('refuses a student not enrolled in the section', async () => {
    authed()
    mockAdminClient.mockReturnValue(adminWith({ enrollments: { data: null } }))
    const res = await getAthenaContext(SECTION)
    expect(res.data).toBeNull()
    expect(res.error).toMatch(/not enrolled/i)
  })
})

// The shell's half of the quiz lock. Note the deliberate asymmetry with
// /api/chat: the send path fails CLOSED on a bad read (423/503), this one fails
// OPEN — it only decides whether a button renders, and failing closed here would
// hide Athena for the rest of the term. That asymmetry is easy to "tidy up" into
// a rethrow, which would take the whole course page down, so it is pinned here.
describe('hasActiveQuizAttempt — the shell-side lock signal', () => {
  const liveAttempt = {
    data: [
      {
        id: 'att-1',
        started_at: new Date(Date.now() - 60_000).toISOString(),
        quiz: { title: 'Midterm Quiz', due_date: null, time_limit_minutes: 60 },
      },
    ],
  }

  it('reports the lock while an attempt is live', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({ enrollments: { data: { id: 'e1' } }, quiz_attempts: liveAttempt }),
    )
    expect(await hasActiveQuizAttempt(SECTION)).toBe(true)
  })

  it('returns false rather than throwing when the read fails', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({
        enrollments: { data: { id: 'e1' } },
        quiz_attempts: { data: null, error: { message: 'connection reset' } },
      }),
    )
    await expect(hasActiveQuizAttempt(SECTION)).resolves.toBe(false)
  })

  it('refuses unauthenticated callers without touching the admin DB', async () => {
    unauthed()
    expect(await hasActiveQuizAttempt(SECTION)).toBe(false)
    expect(mockAdminClient).not.toHaveBeenCalled()
  })
})

describe('getAthenaContext — citable document filter', () => {
  it('exposes only preview-able file types (pdf/pptx/ppt) and falls back to "Untitled"', async () => {
    authed()
    const admin = adminWith({
      enrollments: { data: { id: 'e1' } },
      athena_conversations: { data: [{ id: 'c1', title: 'Thread' }] },
      modules: { data: [{ id: 'm1' }] },
      module_items: {
        data: [
          { id: 'i1', title: 'Lecture 1', content: { fileType: 'pdf' } },
          { id: 'i2', title: 'Slides', content: { fileType: 'pptx' } },
          { id: 'i3', title: null, content: { fileType: 'ppt' } },
          { id: 'i4', title: 'A Video', content: { fileType: 'mp4' } },
          { id: 'i5', title: 'A Doc', content: { fileType: 'docx' } },
          { id: 'i6', title: 'No content', content: null },
        ],
      },
    })
    mockAdminClient.mockReturnValue(admin)

    const res = await getAthenaContext(SECTION)
    expect(res.error).toBeUndefined()
    expect(res.data.conversations).toEqual([{ id: 'c1', title: 'Thread' }])
    expect(res.data.documents).toEqual([
      { id: 'i1', title: 'Lecture 1', fileType: 'pdf' },
      { id: 'i2', title: 'Slides', fileType: 'pptx' },
      { id: 'i3', title: 'Untitled', fileType: 'ppt' },
    ])
  })

  it('skips the module_items query and returns no documents when no modules are published', async () => {
    authed()
    const admin = adminWith({
      enrollments: { data: { id: 'e1' } },
      athena_conversations: { data: [] },
      modules: { data: [] },
    })
    mockAdminClient.mockReturnValue(admin)

    const res = await getAthenaContext(SECTION)
    expect(res.error).toBeUndefined()
    expect(res.data.documents).toEqual([])
    // no published modules → the item lookup must be short-circuited
    const queried = admin.__fromSpy.mock.calls.map((c: unknown[]) => c[0])
    expect(queried).not.toContain('module_items')
  })
})
