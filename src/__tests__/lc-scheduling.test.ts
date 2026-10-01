// Tests for the Schedule Live Classrooms feature:
//  C3a — scheduleLiveClass rejects past scheduled times
//  C3b — expandWeeklyOccurrences produces the right count and enforces the cap
//  C3c — startLiveClass transitions a scheduled room to live (guarded/idempotent)
//  C3d — the render core derives the source path server-side (a mismatched
//        stored path cannot redirect the render — IDOR guard)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isWellFormedJoinCode } from '@/lib/live-classroom/join-code'

// ── C3b: pure recurrence expansion (no mocks) ────────────────────
import { expandWeeklyOccurrences, MAX_SCHEDULE_OCCURRENCES } from '@/lib/live-classroom/recurrence'

describe('expandWeeklyOccurrences (C3b)', () => {
  it('expands weekly MWF across two weeks to the right count and days', () => {
    // Mon 2026-07-13 09:00 local → repeat Mon/Wed/Fri until Fri 2026-07-24.
    const start = new Date(2026, 6, 13, 9, 0) // month is 0-based (6 = July)
    const until = new Date(2026, 6, 24)
    const weekdays = [1, 3, 5] // Mon, Wed, Fri
    const out = expandWeeklyOccurrences(start, weekdays, until)

    // 2 weeks × 3 days = 6 occurrences.
    expect(out).toHaveLength(6)
    // Every occurrence falls on a selected weekday, at 09:00, ascending.
    expect(out.every((d) => weekdays.includes(d.getDay()))).toBe(true)
    expect(out.every((d) => d.getHours() === 9 && d.getMinutes() === 0)).toBe(true)
    for (let i = 1; i < out.length; i++) expect(out[i].getTime()).toBeGreaterThan(out[i - 1].getTime())
  })

  it('enforces the occurrence cap over a long range', () => {
    const start = new Date(2026, 0, 1, 10, 0)
    const until = new Date(2027, 0, 1) // a full year of daily occurrences
    const out = expandWeeklyOccurrences(start, [0, 1, 2, 3, 4, 5, 6], until)
    expect(out).toHaveLength(MAX_SCHEDULE_OCCURRENCES)
  })

  it('returns nothing when no weekdays are selected', () => {
    const out = expandWeeklyOccurrences(new Date(2026, 6, 13, 9, 0), [], new Date(2026, 6, 24))
    expect(out).toHaveLength(0)
  })
})

// ── Chainable Supabase mock for the server-action tests ──────────

const mockGetUser = vi.fn()
const mockEnqueueJob = vi.fn()
const mockEmitEvent = vi.fn()

// Per-table canned results + captured update payloads, reset each test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tableResults: Record<string, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let capturedUpdates: Array<{ table: string; payload: any; filters: Record<string, unknown>; options?: unknown }>

function makeBuilder(table: string) {
  const filters: Record<string, unknown> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let updatePayload: any = null
  let upsertOptions: unknown = undefined
  let op: 'select' | 'update' | 'insert' = 'select'
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  Object.assign(builder, {
    select: () => chain(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert: (p: any) => {
      op = 'insert'
      updatePayload = p
      return chain()
    },
    upsert: (p: unknown, o?: unknown) => {
      op = 'insert'
      updatePayload = p
      upsertOptions = o
      return chain()
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: (p: any) => {
      op = 'update'
      updatePayload = p
      return chain()
    },
    eq: (col: string, val: unknown) => {
      filters[col] = val
      return chain()
    },
    in: (col: string, val: unknown) => {
      filters[col] = val
      return chain()
    },
    order: () => chain(),
    limit: () => chain(),
    single: async () => resolve(),
    maybeSingle: async () => resolve(),
    then: (onOk: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onOk),
  })
  function resolve() {
    if (op === 'update' || op === 'insert') {
      capturedUpdates.push({
        table,
        payload: updatePayload,
        filters: { ...filters },
        options: upsertOptions,
      })
      const canned = tableResults[`${table}:${op}`] as { throws?: boolean } | undefined
      if (canned?.throws) throw new Error('client blew up')
      return canned ?? { data: updatePayload, error: null }
    }
    // A select filtered by recurrence_group_id is the sibling lookup (series
    // scope) — let a test give it its own canned result distinct from the
    // single-room ownership read.
    if (filters.recurrence_group_id !== undefined && tableResults[`${table}:select:group`] !== undefined) {
      return tableResults[`${table}:select:group`]
    }
    return tableResults[`${table}:select`] ?? { data: null, error: null }
  }
  return builder
}

const mockAdminClient = () => ({
  from: (table: string) => makeBuilder(table),
})

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/server', () => ({ after: (fn: () => void | Promise<void>) => fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mockAdminClient() }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
vi.mock('@/lib/events/emit', () => ({ emitEvent: (...a: unknown[]) => mockEmitEvent(...a) }))
vi.mock('@/lib/jobs/enqueue', () => ({ enqueueJob: (...a: unknown[]) => mockEnqueueJob(...a) }))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: vi.fn(async () => ({ ok: true, role: 'professor', adminDb: mockAdminClient() })),
  canWriteAsProfessor: (role: string) => role === 'professor',
}))
vi.mock('@/lib/live-classroom/deck-converter', () => ({ isPptxEnabled: () => true }))
vi.mock('@/lib/extraction/enqueue', () => ({ enqueueMasteryRecompute: vi.fn() }))

const UID = '11111111-1111-4111-8111-111111111111'
const SECTION = '22222222-2222-4222-8222-222222222222'
const ROOM = '33333333-3333-4333-8333-333333333333'
const DECK = '44444444-4444-4444-8444-444444444444'
const INSTITUTION = '66666666-6666-4666-8666-666666666666'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let actions: any

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  // enqueueJob always resolves an EnqueueJobResult; the caller reads `alreadyActive`
  // to report an in-flight render instead of enqueueing a duplicate. A bare
  // mockReset() left it returning undefined, which the caller never sees in
  // production.
  mockEnqueueJob.mockReset().mockResolvedValue({ jobId: 'job-1', alreadyActive: false })
  mockEmitEvent.mockReset()
  tableResults = {}
  capturedUpdates = []
  /* verifyRoomOwnership re-checks that the room's section really belongs to the
     caller — a forged row can pair the attacker's prof_id with a victim's
     section_id. Default it to "yes, yours" so each test only has to describe
     the tables its own action touches; the test that asserts the institution is
     resolved from the section overrides this with its own row. */
  tableResults['course_sections:select'] = { data: { id: SECTION, institution_id: INSTITUTION }, error: null }
  mockGetUser.mockResolvedValue({ data: { user: { id: UID } }, error: null })
  actions = await import('@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions')
})

describe('scheduleLiveClass (C3a)', () => {
  it('rejects a past scheduled time before touching the DB', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const res = await actions.scheduleLiveClass({ sectionId: SECTION, occurrences: [past], recurring: false })
    expect(res.error).toMatch(/future/i)
    expect(capturedUpdates.find((u) => u.table === 'lc_rooms')).toBeUndefined()
  })

  it('inserts scheduled rooms for valid future occurrences', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    tableResults['lc_rooms:insert'] = { data: [{ id: ROOM, scheduled_at: future }], error: null }
    const res = await actions.scheduleLiveClass({ sectionId: SECTION, occurrences: [future], recurring: false })
    expect(res.error).toBeUndefined()
    expect(res.roomIds).toEqual([ROOM])
    const insert = capturedUpdates.find((u) => u.table === 'lc_rooms')
    expect(insert?.payload[0]).toMatchObject({ status: 'scheduled', scheduled_at: future, section_id: SECTION })
  })
})

describe('startLiveClass (C3c)', () => {
  /* The class is already live in the database by the time the code is minted, and students
     are about to be notified. So minting is allowed to fail; STARTING is not. Both shapes of
     failure are covered because they take different paths out of the client library: an
     error object, and a throw. */
  const startInput = { roomId: ROOM, deckId: DECK, name: 'Lecture 1', lectureSummaryEnabled: true }
  function primeStart() {
    tableResults['lc_rooms:select'] = {
      data: { id: ROOM, prof_id: UID, section_id: SECTION, status: 'scheduled', setup_completed: false },
      error: null,
    }
    tableResults['lc_decks:select'] = { data: { id: DECK, deck_url: 'live-classroom-decks/x', page_count: 3 }, error: null }
    tableResults['lc_rooms:update'] = { data: [{ id: ROOM }], error: null }
  }

  it('still starts the class when the code cannot be minted', async () => {
    primeStart()
    tableResults['lc_room_codes:insert'] = { data: null, error: { code: '42501', message: 'denied' } }

    const res = await actions.startLiveClass(startInput)

    expect(res.success).toBe(true)
    expect(mockEmitEvent).toHaveBeenCalledTimes(1) // students still hear the class started
  })

  it('still starts the class when minting throws outright', async () => {
    primeStart()
    tableResults['lc_room_codes:insert'] = { throws: true }

    const res = await actions.startLiveClass(startInput)

    expect(res.success).toBe(true)
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
  })

  it('flips a scheduled room to live and clears scheduled_at', async () => {
    tableResults['lc_rooms:select'] = {
      data: { id: ROOM, prof_id: UID, section_id: SECTION, status: 'scheduled', setup_completed: false },
      error: null,
    }
    tableResults['lc_decks:select'] = { data: { id: DECK, deck_url: 'live-classroom-decks/x', page_count: 3 }, error: null }
    tableResults['lc_rooms:update'] = { data: [{ id: ROOM }], error: null } // 1 row flipped → notify fires

    const res = await actions.startLiveClass({ roomId: ROOM, deckId: DECK, name: 'Lecture 1', lectureSummaryEnabled: true })
    expect(res.success).toBe(true)

    /* Starting the class mints the attendance code (#82) — one, well-formed, for THIS room.
       Minted here rather than at room creation so a draft nobody starts never holds a code. */
    const codes = capturedUpdates.filter((u) => u.table === 'lc_room_codes')
    expect(codes).toHaveLength(1)
    expect(codes[0].payload).toMatchObject({ room_id: ROOM })
    expect(isWellFormedJoinCode((codes[0].payload as { code: string }).code)).toBe(true)
    /* The conflict TARGET is what makes the retry loop work, and dropping it looks harmless.
       `on conflict (room_id) do nothing` still raises 23505 for a duplicate CODE, so a
       collision is caught and re-rolled. A bare `on conflict do nothing` would swallow the
       code collision too: no error, the loop breaks reporting success, and the class runs
       with no code at all. */
    expect(codes[0].options).toEqual({ onConflict: 'room_id', ignoreDuplicates: true })

    const update = capturedUpdates.find((u) => u.table === 'lc_rooms' && u.payload?.status === 'live')
    expect(update).toBeDefined()
    expect(update?.payload).toMatchObject({ status: 'live', scheduled_at: null, setup_completed: true, active_deck_id: DECK })
    // Idempotency guard: the transition is scoped to setup_completed=false, so a
    // double-click updates 0 rows the second time.
    expect(update?.filters).toMatchObject({ id: ROOM, setup_completed: false })
    // Students are notified exactly once when it goes live.
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
  })
})

describe('cancelScheduledSession', () => {
  it('refuses to cancel a session that is not scheduled (status guard)', async () => {
    tableResults['lc_rooms:select'] = {
      data: { id: ROOM, prof_id: UID, section_id: SECTION, status: 'live', recurrence_group_id: null },
      error: null,
    }
    const res = await actions.cancelScheduledSession({ roomId: ROOM, scope: 'one' })
    expect(res.error).toMatch(/only scheduled/i)
    // No end-update was attempted.
    expect(capturedUpdates.find((u) => u.table === 'lc_rooms' && u.payload?.status === 'ended')).toBeUndefined()
  })

  it("scope 'one' ends just this room with a status='scheduled' guard", async () => {
    tableResults['lc_rooms:select'] = {
      data: { id: ROOM, prof_id: UID, section_id: SECTION, status: 'scheduled', recurrence_group_id: 'grp-1' },
      error: null,
    }
    const res = await actions.cancelScheduledSession({ roomId: ROOM, scope: 'one' })
    expect(res.success).toBe(true)

    const end = capturedUpdates.find((u) => u.table === 'lc_rooms' && u.payload?.status === 'ended')
    expect(end?.payload).toMatchObject({ status: 'ended', scheduled_at: null })
    // Only this room; the WHERE keeps the guard so an already-started sibling is
    // never clobbered.
    expect(end?.filters).toMatchObject({ id: [ROOM], status: 'scheduled' })
  })

  it("scope 'series' ends every still-scheduled sibling in the group, scoped to the owner", async () => {
    const SIB = '55555555-5555-4555-8555-555555555555'
    tableResults['lc_rooms:select'] = {
      data: { id: ROOM, prof_id: UID, section_id: SECTION, status: 'scheduled', recurrence_group_id: 'grp-1' },
      error: null,
    }
    // The sibling lookup (filtered by recurrence_group_id) returns the group.
    tableResults['lc_rooms:select:group'] = { data: [{ id: ROOM }, { id: SIB }], error: null }

    const res = await actions.cancelScheduledSession({ roomId: ROOM, scope: 'series' })
    expect(res.success).toBe(true)

    const end = capturedUpdates.find((u) => u.table === 'lc_rooms' && u.payload?.status === 'ended')
    expect(end?.filters.id).toEqual([ROOM, SIB])
    expect(end?.filters).toMatchObject({ status: 'scheduled' })
  })
})

describe('enqueueScheduledDeckRender', () => {
  function scheduledRoom() {
    return {
      data: { id: ROOM, prof_id: UID, section_id: SECTION, status: 'scheduled', recurrence_group_id: null },
      error: null,
    }
  }

  it('short-circuits without enqueuing when the deck is already rendered', async () => {
    tableResults['lc_rooms:select'] = scheduledRoom()
    tableResults['lc_decks:select'] = {
      data: { id: DECK, source_file_path: `${ROOM}/${DECK}/source.pdf`, deck_url: 'live-classroom-decks/x' },
      error: null,
    }
    const res = await actions.enqueueScheduledDeckRender({ roomId: ROOM, deckId: DECK })
    expect(res.success).toBe(true)
    expect(mockEnqueueJob).not.toHaveBeenCalled()
  })

  it('enqueues a render job with the institution resolved from the section', async () => {
    tableResults['lc_rooms:select'] = scheduledRoom()
    tableResults['lc_decks:select'] = {
      data: { id: DECK, source_file_path: `${ROOM}/${DECK}/source.pdf`, deck_url: null },
      error: null,
    }
    tableResults['course_sections:select'] = { data: { institution_id: INSTITUTION }, error: null }

    const res = await actions.enqueueScheduledDeckRender({ roomId: ROOM, deckId: DECK })
    expect(res.success).toBe(true)
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1)
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'render_scheduled_deck',
        params: { roomId: ROOM, deckId: DECK },
        institutionId: INSTITUTION,
        sectionId: SECTION,
        // Dedup subject is the DECK. Without it every deck in a section shares one
        // key, so the second upload's job collides with the first and never renders
        // — permanently, now that the unique index covers 'running' too (#630).
        subjectKey: DECK,
      }),
    )
  })

  it('reports success without enqueueing twice when this deck is already rendering', async () => {
    tableResults['lc_rooms:select'] = scheduledRoom()
    tableResults['lc_decks:select'] = {
      data: { id: DECK, source_file_path: `${ROOM}/${DECK}/source.pdf`, deck_url: null },
      error: null,
    }
    tableResults['course_sections:select'] = { data: { institution_id: INSTITUTION }, error: null }
    // The unique index rejected the insert; enqueueJob returns the in-flight job.
    mockEnqueueJob.mockResolvedValue({ jobId: 'job-existing', alreadyActive: true })

    const res = await actions.enqueueScheduledDeckRender({ roomId: ROOM, deckId: DECK })

    expect(res.success).toBe(true)
    expect(res.error).toBeUndefined()
  })

  it('rejects (no enqueue) when the deck has no server-authored source path', async () => {
    tableResults['lc_rooms:select'] = scheduledRoom()
    tableResults['lc_decks:select'] = { data: { id: DECK, source_file_path: null, deck_url: null }, error: null }
    const res = await actions.enqueueScheduledDeckRender({ roomId: ROOM, deckId: DECK })
    expect(res.error).toBeDefined()
    expect(mockEnqueueJob).not.toHaveBeenCalled()
  })
})
