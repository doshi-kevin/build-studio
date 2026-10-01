// Guard tests for the journey server actions (PR #199 review ask): the
// RLS-bypassing (admin-client) paths must refuse before any DB op when the
// caller is unauthenticated / not the section owner / not enrolled, and
// setMyNodeCheckedOff must reject a bad nodeId.
//
// getMyJourney / setMyNodePinnedPage / getMyItemPages retired with the old
// student roadmap (their features — the 4-state personal journey and pin-to-page
// — were not carried over), so only the surviving actions are covered here.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFullChain } from './helpers/mock-supabase'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockRpc = vi.fn()

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

/* eslint-disable @typescript-eslint/no-explicit-any */
let getStudentJourneys: any
let setMyNodeCheckedOff: any
let getMyConceptScores: any
let getMyRoadmapArtifacts: any
let saveMyArtifactState: any
let setMyArtifactArchived: any
let deleteMyArtifact: any
/* eslint-enable @typescript-eslint/no-explicit-any */

const SECTION = 'sec-1'
const USER = 'user-1'

/** A chain whose terminal reads (single/maybeSingle) resolve to `result`. */
function adminWith(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order']) chain[m] = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(result)
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  return { from: vi.fn().mockReturnValue(chain), rpc: mockRpc }
}

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockRpc.mockReset().mockResolvedValue({ data: null, error: null })

  const prof = await import('@/app/(dashboard)/professor/courses/[sectionId]/roadmap/actions')
  const stu = await import('@/app/(dashboard)/student/courses/[sectionId]/roadmap/actions')
  getStudentJourneys = prof.getStudentJourneys
  setMyNodeCheckedOff = stu.setMyNodeCheckedOff
  getMyConceptScores = stu.getMyConceptScores
  getMyRoadmapArtifacts = stu.getMyRoadmapArtifacts
  saveMyArtifactState = stu.saveMyArtifactState
  setMyArtifactArchived = stu.setMyArtifactArchived
  deleteMyArtifact = stu.deleteMyArtifact
})

function authed() {
  mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null })
}
function unauthed() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

describe('getStudentJourneys (professor) — authz guard', () => {
  it('refuses unauthenticated callers without touching the DB', async () => {
    unauthed()
    const res = await getStudentJourneys(SECTION)
    expect(res.error).toBeTruthy()
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('refuses a professor who does not own the section', async () => {
    authed()
    mockAdminClient.mockReturnValue(adminWith({ data: { id: SECTION, professor_id: 'other-prof' }, error: null }))
    const res = await getStudentJourneys(SECTION)
    expect(res.error).toMatch(/do not own/i)
    expect(res.data).toBeUndefined()
  })
})

describe('setMyNodeCheckedOff (student) — guards + atomic write', () => {
  it('refuses unauthenticated callers without touching the DB', async () => {
    unauthed()
    const res = await setMyNodeCheckedOff(SECTION, 'node-1', true)
    expect(res.error).toBeTruthy()
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('rejects an empty or oversized nodeId before any enrollment check', async () => {
    authed()
    expect((await setMyNodeCheckedOff(SECTION, '', true)).error).toMatch(/invalid node/i)
    expect((await setMyNodeCheckedOff(SECTION, 'x'.repeat(201), true)).error).toMatch(/invalid node/i)
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('refuses a student not enrolled in the section', async () => {
    authed()
    mockAdminClient.mockReturnValue(adminWith({ data: null, error: null }))
    const res = await setMyNodeCheckedOff(SECTION, 'node-1', true)
    expect(res.error).toMatch(/not enrolled/i)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('writes via the atomic RPC for an enrolled student', async () => {
    authed()
    mockAdminClient.mockReturnValue(adminWith({ data: { id: 'enr-1' }, error: null }))
    const res = await setMyNodeCheckedOff(SECTION, 'node-1', true)
    expect(res.success).toBe(true)
    expect(mockRpc).toHaveBeenCalledWith('roadmap_set_node_checkoff', expect.objectContaining({
      p_section_id: SECTION, p_student_id: USER, p_node_id: 'node-1', p_checked_off: true,
    }))
  })
})

/* Un-ticking has to undo BOTH halves of "done". getStudentCoverage unions
   roadmap_progress.checkedOff with getPassedNodeChecks, so clearing only the flag
   left the node complete via the other source — the week's percentage and the
   headline never moved, and a reload still offered "Undo". Undo doing nothing at
   all is the worst version of this: the student is told it worked. */
describe('setMyNodeCheckedOff — Undo also clears a passed quick check', () => {
  const ITEM = '11111111-1111-4111-8111-111111111111'

  /** Enrolled student, plus a capturable chain for the attempts table. */
  function enrolledWithAttempts(attemptsResult: { data: unknown; error: unknown } = { data: null, error: null }) {
    const attempts = buildFullChain(attemptsResult)
    const enrollments = buildFullChain({ data: { id: 'enr-1' }, error: null })
    const tables: string[] = []
    const admin = {
      from: vi.fn((table: string) => {
        tables.push(table)
        return table === 'node_check_attempts' ? attempts : enrollments
      }),
      rpc: mockRpc,
    }
    mockAdminClient.mockReturnValue(admin)
    return { attempts, tables }
  }

  it('resets `passed` on un-tick, scoped to this section, student and item', async () => {
    authed()
    const { attempts } = enrolledWithAttempts()
    const res = await setMyNodeCheckedOff(SECTION, ITEM, false)
    expect(res.success).toBe(true)
    expect(attempts.update).toHaveBeenCalledWith(expect.objectContaining({ passed: false }))
    // All three predicates: without section_id + student_id this would reach
    // another student's attempt on the same item.
    expect(attempts.eq).toHaveBeenCalledWith('section_id', SECTION)
    expect(attempts.eq).toHaveBeenCalledWith('student_id', USER)
    expect(attempts.eq).toHaveBeenCalledWith('module_item_id', ITEM)
    /* `answers` and `tries` deliberately survive: the professor's per-student
       review still shows what the student picked, and the check is answerable
       again — which is what Undo claims. */
    const written = attempts.update.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual(['passed', 'updated_at'])
  })

  it('leaves the attempt alone when TICKING a node on', async () => {
    authed()
    const { tables } = enrolledWithAttempts()
    expect((await setMyNodeCheckedOff(SECTION, ITEM, true)).success).toBe(true)
    expect(tables).not.toContain('node_check_attempts')
  })

  it('skips the clear for a non-uuid node key rather than erroring the query', async () => {
    // Roadmap node ids are free-form JSONB keys (a `quiz:<id>` key, a topic key);
    // only a module-item node has a real uuid, and a non-uuid sent at a uuid
    // column makes Postgres reject the whole statement.
    authed()
    const { tables } = enrolledWithAttempts()
    expect((await setMyNodeCheckedOff(SECTION, 'topic:transformers', false)).success).toBe(true)
    expect(tables).not.toContain('node_check_attempts')
  })

  it('still reports success when the clear fails — the tick itself already landed', async () => {
    authed()
    enrolledWithAttempts({ data: null, error: { message: 'boom' } })
    expect((await setMyNodeCheckedOff(SECTION, ITEM, false)).success).toBe(true)
  })
})

/* Athena's study artifacts. Two things here are not shared with the actions
   above: the row is the only place in the roadmap where a JSON blob the CLIENT
   composes reaches the database, and ownership lives inside the statement's own
   WHERE rather than in a prior read — so both the clamp and the predicates have
   to be asserted on the payload that was actually sent. */
describe('the Athena artifact actions', () => {
  const ARTIFACT = '22222222-2222-4222-8222-222222222222'

  /** Enrolled student + a capturable chain for the artifacts table. */
  function enrolledWithArtifacts(result: { data: unknown; error: unknown } = { data: [{ id: ARTIFACT }], error: null }) {
    const artifacts = buildFullChain(result)
    const enrollments = buildFullChain({ data: { id: 'enr-1' }, error: null })
    mockAdminClient.mockReturnValue({
      from: vi.fn((table: string) => (table === 'athena_artifacts' ? artifacts : enrollments)),
      rpc: mockRpc,
    })
    return artifacts
  }

  it('clamps the state blob to indexes and small answers before it is written', async () => {
    // The widget posts this; a page in the browser console can post anything.
    // Nothing about the shape is enforced by the column (plain jsonb), so this
    // clamp is the only thing between a tick-box and an unbounded row.
    authed()
    const artifacts = enrolledWithArtifacts()

    const res = await saveMyArtifactState(SECTION, ARTIFACT, {
      done: [0, 2, -1, 3.5, 100, 'x' as unknown as number],
      answers: { '0': 1, '7': 9, '99': 0, bad: 2, '3': 10, '4': -1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      note: 'x'.repeat(5000) as any,
    })

    expect(res.success).toBe(true)
    const written = artifacts.update.mock.calls[0][0] as { state: Record<string, unknown> }
    // Out-of-range indexes, a float, a string, a non-numeric key, an option
    // index past any real question, and the unknown fat field are all dropped.
    expect(written.state).toEqual({ done: [0, 2], answers: { '0': 1, '7': 9, '99': 0 } })
  })

  it('scopes the write to this student, and calls a miss a miss', async () => {
    authed()
    const artifacts = enrolledWithArtifacts({ data: [], error: null })

    const res = await saveMyArtifactState(SECTION, ARTIFACT, { done: [1] })

    // Zero rows means the id belongs to someone else (or nothing) — enrollment
    // alone would have happily written to a classmate's note.
    expect(res.error).toMatch(/not found/i)
    expect(artifacts.eq).toHaveBeenCalledWith('id', ARTIFACT)
    expect(artifacts.eq).toHaveBeenCalledWith('section_id', SECTION)
    expect(artifacts.eq).toHaveBeenCalledWith('student_id', USER)
  })

  it('rejects a non-uuid artifact id before any DB work', async () => {
    authed()
    expect((await saveMyArtifactState(SECTION, 'not-a-uuid', { done: [] })).error).toMatch(/invalid/i)
    expect((await deleteMyArtifact(SECTION, '1; drop table')).error).toMatch(/invalid/i)
    expect((await setMyArtifactArchived(SECTION, '1; drop table', true)).error).toMatch(/invalid/i)
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('archives (and restores) only the caller\'s own artifact, never deleting it', async () => {
    authed()
    const artifacts = enrolledWithArtifacts()

    expect((await setMyArtifactArchived(SECTION, ARTIFACT, true)).success).toBe(true)
    // Archiving is an UPDATE that stamps archived_at — a delete here would
    // destroy the note the Archive tray exists to preserve.
    expect(artifacts.update).toHaveBeenCalledWith(expect.objectContaining({ archived_at: expect.any(String) }))
    expect(artifacts.delete).not.toHaveBeenCalled()
    expect(artifacts.eq).toHaveBeenCalledWith('student_id', USER)
    expect(artifacts.eq).toHaveBeenCalledWith('section_id', SECTION)

    expect((await setMyArtifactArchived(SECTION, ARTIFACT, false)).success).toBe(true)
    expect(artifacts.update).toHaveBeenCalledWith(expect.objectContaining({ archived_at: null }))
  })

  it('deletes only the caller\'s own artifact', async () => {
    authed()
    const artifacts = enrolledWithArtifacts()

    expect((await deleteMyArtifact(SECTION, ARTIFACT)).success).toBe(true)
    expect(artifacts.delete).toHaveBeenCalled()
    expect(artifacts.eq).toHaveBeenCalledWith('student_id', USER)
    expect(artifacts.eq).toHaveBeenCalledWith('section_id', SECTION)
  })

  it('refuses an unauthenticated caller without touching the DB', async () => {
    unauthed()
    expect((await deleteMyArtifact(SECTION, ARTIFACT)).error).toBeTruthy()
    expect((await getMyRoadmapArtifacts(SECTION)).error).toBeTruthy()
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('drops a row whose kind this build cannot render, rather than shipping it to the canvas', async () => {
    // Forward compatibility runs the other way too: an older bundle reading a
    // kind added later would look up no widget and render an empty modal.
    authed()
    enrolledWithArtifacts({
      data: [
        { id: ARTIFACT, kind: 'flashcards', title: 'Deck', module_id: 'm-1', payload: { cards: [] }, state: null, created_at: 't' },
        { id: 'x', kind: 'hologram', title: 'From the future', module_id: 'm-1', payload: {}, state: null, created_at: 't' },
      ],
      error: null,
    })

    const res = await getMyRoadmapArtifacts(SECTION)

    expect(res.data.map((a: { kind: string }) => a.kind)).toEqual(['flashcards'])
    // A null `state` column must arrive as an object — the widgets read
    // `artifact.state.done` unguarded.
    expect(res.data[0].state).toEqual({})
  })
})

describe('getMyConceptScores (student) — enrollment guard', () => {
  // RLS-bypassing admin-client read: must refuse before any DB op when the
  // caller is unauthenticated or not enrolled. (Mapping logic is covered by the
  // topic-scoring / queries collaborators, not re-asserted here.)
  it('refuses unauthenticated callers without touching the DB', async () => {
    unauthed()
    const res = await getMyConceptScores(SECTION)
    expect(res.error).toBeTruthy()
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('refuses a student not enrolled in the section', async () => {
    authed()
    mockAdminClient.mockReturnValue(adminWith({ data: null, error: null })) // enrollment lookup → none
    const res = await getMyConceptScores(SECTION)
    expect(res.error).toMatch(/not enrolled/i)
    expect(res.data).toBeUndefined()
  })
})
