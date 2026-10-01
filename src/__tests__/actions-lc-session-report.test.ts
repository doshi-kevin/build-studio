// Tests for the live-classroom session-report feature's server actions:
// getOrGenerateSessionReport (prof-only report + double-generation lock),
// getLectureSummary (student catch-up + 2-min shared cache), and
// markAttendance (enrollment-gated heartbeat). Mirrors the table-routed
// admin mock pattern from actions-live-classroom.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockSummarize = vi.fn()
const mockNarrative = vi.fn()

/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

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
vi.mock('@/lib/ai/llm-client', () => ({
  summarizeLectureContent: (...args: unknown[]) => mockSummarize(...args),
  generateSessionReportNarrative: (...args: unknown[]) => mockNarrative(...args),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getOrGenerateSessionReport: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getLectureSummary: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let markAttendance: any

const ROOM_ID = '3c92fdc2-5b86-428a-bb0c-20d4d47a6ef9'
const PROF = { id: 'prof-1' }
const STUDENT = { id: 'student-1' }
const DECK_ID = 'deck-1'

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockSummarize.mockReset()
  mockNarrative.mockReset()

  getOrGenerateSessionReport = (await import('@/lib/live-classroom/report/actions'))
    .getOrGenerateSessionReport
  getLectureSummary = (await import('@/lib/live-classroom/summary/actions')).getLectureSummary
  markAttendance = (await import('@/lib/live-classroom/attendance/actions')).markAttendance
})

function authAs(user: { id: string } | null) {
  mockGetUser.mockResolvedValue({ data: { user }, error: null })
}

/**
 * Table-routed admin DB mock covering every chain the three actions use.
 * Spies (`attendanceUpsert`, `reportUpsert`, `reportUpdate`, `roomUpdate`)
 * are exposed so tests can assert that guarded paths never write.
 */
function buildDb({
  room = {
    id: ROOM_ID,
    section_id: 'sec-1',
    prof_id: PROF.id,
    status: 'ended',
    created_at: '2026-06-12T10:00:00.000Z',
    ended_at: '2026-06-12T11:00:00.000Z',
    active_deck_id: DECK_ID,
    lecture_summary: null,
  } as Record<string, unknown> | null,
  enrolledAsStudent = true,
  enrollments = [{ student_id: STUDENT.id }],
  // Per-deck transcript rows (report path reads these via .in(deck_id)).
  deckTranscriptions = [{ deck_id: DECK_ID, page_number: 0, text: 'lecture speech' }],
  // Active-deck transcript rows (summary path reads these via .eq(deck_id)).
  transcriptions = [{ page_number: 0, text: 'lecture speech' }],
  decks = [{ id: DECK_ID, title: 'Deck 1', position: 1, page_count: 10 }],
  deckExtraction = null as unknown,
  interactions = [] as unknown[],
  responses = [] as unknown[],
  attendance = [] as unknown[],
  alreadyPresent = false,
  profiles = [{ id: STUDENT.id, name: 'Student One', email: 's1@x.edu' }],
  existingReport = null as { report: unknown; generated_at: string } | null,
  claimWon = true,
  reclaimWon = true,
} = {}) {
  const attendanceUpsert = vi.fn().mockResolvedValue({ error: null })
  const reportUpsert = vi.fn().mockReturnValue({
    select: vi.fn().mockResolvedValue({ data: claimWon ? [{ room_id: ROOM_ID }] : [] }),
  })
  // `update().eq(...)` is used two ways: the final store awaits `.eq('room_id')`
  // directly (→ { error }), while the crashed-placeholder CAS re-claim chains
  // `.eq('room_id').eq('generated_at').select('room_id')` (→ { data }). The
  // first .eq() returns a thenable that also exposes the CAS continuation.
  const reportUpdateEq = {
    then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
    eq: vi.fn().mockReturnValue({
      select: vi.fn().mockResolvedValue({ data: reclaimWon ? [{ room_id: ROOM_ID }] : [] }),
    }),
  }
  const reportUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue(reportUpdateEq),
  })
  const roomUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  })

  const db = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'lc_rooms') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: room,
                error: room ? null : { message: 'not found' },
              }),
            }),
          }),
          update: roomUpdate,
        }
      }
      if (table === 'enrollments') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              // isEnrolled: .eq().eq().in().maybeSingle()
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: enrolledAsStudent ? { id: 'enr-1' } : null,
                    error: null,
                  }),
                }),
              }),
              // report fetch: .eq().in() awaited directly
              in: vi.fn().mockResolvedValue({ data: enrollments, error: null }),
            }),
          }),
        }
      }
      if (table === 'lc_decks') {
        // Report path: .select().eq(room_id).order(position) → deck rows.
        // Summary path: .select('extraction').eq(id).maybeSingle() → extraction.
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: decks, error: null }),
              maybeSingle: vi.fn().mockResolvedValue({ data: { extraction: deckExtraction }, error: null }),
            }),
          }),
        }
      }
      if (table === 'lc_transcriptions') {
        return {
          select: vi.fn().mockReturnValue({
            // Summary path: .eq(deck_id).order(page_number)
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: transcriptions, error: null }),
            }),
            // Report path: .in(deck_id).order(page_number)
            in: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: deckTranscriptions, error: null }),
            }),
          }),
        }
      }
      if (table === 'lc_interactions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: interactions, error: null }),
            }),
          }),
        }
      }
      if (table === 'lc_responses') {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ data: responses, error: null }),
          }),
        }
      }
      if (table === 'lc_attendance') {
        /* Two shapes, same as reportUpdateEq above: the report path awaits `.eq('room_id')`
           for the whole roster, while markAttendance chains a second `.eq('student_id')` to
           ask whether THIS student is already present (#82). */
        const attendanceEq = {
          then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
            resolve({ data: attendance, error: null }),
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: alreadyPresent ? { student_id: STUDENT.id } : null,
            }),
          }),
        }
        return {
          select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue(attendanceEq) }),
          upsert: attendanceUpsert,
        }
      }
      if (table === 'lc_room_codes') {
        // No code row = a class that started before the feature, which keeps the old
        // behaviour. The code gate itself is covered in lc-join-code.test.ts.
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }
      }
      if (table === 'profiles') {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ data: profiles, error: null }),
          }),
        }
      }
      if (table === 'lc_session_reports') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: existingReport, error: null }),
            }),
          }),
          upsert: reportUpsert,
          update: reportUpdate,
        }
      }
      throw new Error(`buildDb: unexpected table ${table}`)
    }),
  }

  mockAdminClient.mockReturnValue(db)
  return { db, attendanceUpsert, reportUpsert, reportUpdate, roomUpdate }
}

// ── getOrGenerateSessionReport ───────────────────────────────────────

describe('getOrGenerateSessionReport', () => {
  it('rejects unauthenticated callers', async () => {
    authAs(null)
    const result = await getOrGenerateSessionReport(ROOM_ID)
    expect(result.error).toBe('Not authenticated')
  })

  it('does not leak existence or data to a non-owner professor', async () => {
    authAs({ id: 'other-prof' })
    const { reportUpsert, reportUpdate } = buildDb()

    const result = await getOrGenerateSessionReport(ROOM_ID)

    // Same message as a missing room — no enumeration — and no writes.
    expect(result.error).toBe('Session not found')
    expect(result.report).toBeUndefined()
    expect(reportUpsert).not.toHaveBeenCalled()
    expect(reportUpdate).not.toHaveBeenCalled()
    expect(mockNarrative).not.toHaveBeenCalled()
  })

  it('refuses to generate while the room is still live', async () => {
    authAs(PROF)
    buildDb({ room: { id: ROOM_ID, section_id: 'sec-1', prof_id: PROF.id, status: 'live' } })

    const result = await getOrGenerateSessionReport(ROOM_ID)
    expect(result.error).toContain('still live')
  })

  it('returns the stored report without recomputing or calling the LLM', async () => {
    authAs(PROF)
    const stored = { version: 1, empty: false, aiNarrative: 'done', narrativeFailed: false }
    const { reportUpsert, reportUpdate } = buildDb({
      existingReport: { report: stored, generated_at: new Date().toISOString() },
    })

    const result = await getOrGenerateSessionReport(ROOM_ID)

    expect(result.report).toEqual(stored)
    expect(mockNarrative).not.toHaveBeenCalled()
    expect(reportUpsert).not.toHaveBeenCalled()
    expect(reportUpdate).not.toHaveBeenCalled()
  })

  it('returns { generating: true } when another request holds a fresh placeholder', async () => {
    authAs(PROF)
    buildDb({
      existingReport: {
        report: { status: 'generating' },
        generated_at: new Date().toISOString(), // fresh — within takeover window
      },
    })

    const result = await getOrGenerateSessionReport(ROOM_ID)
    expect(result.generating).toBe(true)
    expect(result.report).toBeUndefined()
    expect(mockNarrative).not.toHaveBeenCalled()
  })

  it('takes over a crashed placeholder older than the takeover window', async () => {
    authAs(PROF)
    mockNarrative.mockResolvedValue({ narrative: 'recovered narrative' })
    const { reportUpdate } = buildDb({
      existingReport: {
        report: { status: 'generating' },
        generated_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(), // stale (> 2 min)
      },
    })

    const result = await getOrGenerateSessionReport(ROOM_ID)

    expect(result.generating).toBeUndefined()
    expect(result.report).toBeDefined()
    expect(reportUpdate).toHaveBeenCalled()
  })

  it('does not double-generate when two requests race to take over a crashed placeholder', async () => {
    authAs(PROF)
    // Stale placeholder (> 2 min) but the CAS re-claim loses — another request
    // already grabbed the takeover. Must poll, not fire the paid LLM call.
    buildDb({
      existingReport: {
        report: { status: 'generating' },
        generated_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      },
      reclaimWon: false,
    })

    const result = await getOrGenerateSessionReport(ROOM_ID)

    expect(result.generating).toBe(true)
    expect(result.report).toBeUndefined()
    expect(mockNarrative).not.toHaveBeenCalled()
  })

  it('returns { generating: true } without generating when the claim race is lost', async () => {
    authAs(PROF)
    const { reportUpdate } = buildDb({ claimWon: false })

    const result = await getOrGenerateSessionReport(ROOM_ID)

    expect(result.generating).toBe(true)
    expect(mockNarrative).not.toHaveBeenCalled()
    expect(reportUpdate).not.toHaveBeenCalled()
  })

  it('generates, stores, and returns the report on a clean first run', async () => {
    authAs(PROF)
    mockNarrative.mockResolvedValue({ narrative: '## What was taught\nGood class.' })
    const { reportUpsert, reportUpdate } = buildDb({
      attendance: [
        {
          student_id: STUDENT.id,
          joined_at: '2026-06-12T10:01:00.000Z',
          last_seen_at: '2026-06-12T10:55:00.000Z',
        },
      ],
    })

    const result = await getOrGenerateSessionReport(ROOM_ID)

    expect(result.error).toBeUndefined()
    expect(reportUpsert).toHaveBeenCalled() // placeholder claim
    expect(reportUpdate).toHaveBeenCalled() // final store
    expect(result.report.aiNarrative).toBe('## What was taught\nGood class.')
    expect(result.report.narrativeFailed).toBe(false)
    expect(result.report.attendance.attendedCount).toBe(1)
  })

  it('still returns the report (narrativeFailed) when the LLM call fails', async () => {
    authAs(PROF)
    mockNarrative.mockResolvedValue({ narrative: '', error: 'model exploded' })
    buildDb()

    const result = await getOrGenerateSessionReport(ROOM_ID)

    expect(result.error).toBeUndefined()
    expect(result.report.aiNarrative).toBeNull()
    expect(result.report.narrativeFailed).toBe(true)
  })
})

// ── getLectureSummary ────────────────────────────────────────────────

describe('getLectureSummary', () => {
  const liveRoom = (lectureSummary: unknown = null) => ({
    id: ROOM_ID,
    section_id: 'sec-1',
    prof_id: PROF.id,
    status: 'live',
    active_deck_id: DECK_ID,
    lecture_summary: lectureSummary,
  })

  it('rejects a non-enrolled, non-professor caller', async () => {
    authAs({ id: 'outsider' })
    buildDb({ room: liveRoom(), enrolledAsStudent: false })

    const result = await getLectureSummary(ROOM_ID)
    expect(result.error).toBe('You are not enrolled in this section')
    expect(mockSummarize).not.toHaveBeenCalled()
  })

  it('serves a fresh cache without a new AI call (the cost-control contract)', async () => {
    authAs(STUDENT)
    const fresh = {
      text: 'cached summary',
      slidesCovered: 2,
      generatedAt: new Date(Date.now() - 30 * 1000).toISOString(), // 30s old
      deckId: DECK_ID, // matches the active deck → cache hit
    }
    const { roomUpdate } = buildDb({ room: liveRoom(fresh) })

    const result = await getLectureSummary(ROOM_ID)

    expect(result.summary).toBe('cached summary')
    expect(result.cached).toBe(true)
    expect(mockSummarize).not.toHaveBeenCalled()
    expect(roomUpdate).not.toHaveBeenCalled()
  })

  it('regenerates and re-caches when the cache is older than the window', async () => {
    authAs(STUDENT)
    mockSummarize.mockResolvedValue({ summary: 'fresh summary' })
    const stale = {
      text: 'old summary',
      slidesCovered: 1,
      generatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min old
    }
    const { roomUpdate } = buildDb({ room: liveRoom(stale) })

    const result = await getLectureSummary(ROOM_ID)

    expect(result.summary).toBe('fresh summary')
    expect(result.cached).toBe(false)
    expect(mockSummarize).toHaveBeenCalledTimes(1)
    expect(roomUpdate).toHaveBeenCalled()
  })

  it('invalidates a fresh cache from a DIFFERENT deck (deck switch) and regenerates for the active deck', async () => {
    // The cost-control cache is keyed to the deck. A summary cached <2 min ago
    // but for a previous deck must NOT be served after a switch — otherwise a
    // student on deck B would see deck A's summary (the cross-deck-bleed class).
    authAs(STUDENT)
    mockSummarize.mockResolvedValue({ summary: 'deck-B summary' })
    const freshButOtherDeck = {
      text: 'deck-A summary',
      slidesCovered: 2,
      generatedAt: new Date(Date.now() - 20 * 1000).toISOString(), // fresh
      deckId: 'a-different-deck', // ≠ active DECK_ID
    }
    const { roomUpdate } = buildDb({ room: liveRoom(freshButOtherDeck) })

    const result = await getLectureSummary(ROOM_ID)

    expect(result.cached).toBe(false)
    expect(result.summary).toBe('deck-B summary')
    expect(mockSummarize).toHaveBeenCalledTimes(1)
    expect(roomUpdate).toHaveBeenCalled()
  })

  it('returns nothing-to-summarize when the live room has no active deck yet', async () => {
    authAs(STUDENT)
    const { roomUpdate } = buildDb({ room: { ...liveRoom(null), active_deck_id: null } })

    const result = await getLectureSummary(ROOM_ID)

    expect(result.error).toContain('Nothing to summarize yet')
    expect(mockSummarize).not.toHaveBeenCalled()
    expect(roomUpdate).not.toHaveBeenCalled()
  })

  it('serves the cached summary read-only after the room ends', async () => {
    authAs(STUDENT)
    const old = {
      text: 'final summary',
      slidesCovered: 3,
      generatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // way past the window
    }
    buildDb({
      room: { ...liveRoom(old), status: 'ended' },
    })

    const result = await getLectureSummary(ROOM_ID)

    expect(result.summary).toBe('final summary')
    expect(result.cached).toBe(true)
    expect(mockSummarize).not.toHaveBeenCalled()
  })

  it('returns a friendly error for an ended room with no summary', async () => {
    authAs(STUDENT)
    buildDb({ room: { ...liveRoom(null), status: 'ended' } })

    const result = await getLectureSummary(ROOM_ID)
    expect(result.error).toBe('This class has ended')
  })

  it('never calls the AI or caches when there is no transcription yet', async () => {
    authAs(STUDENT)
    const { roomUpdate } = buildDb({ room: liveRoom(), transcriptions: [] })

    const result = await getLectureSummary(ROOM_ID)

    expect(result.error).toContain('Nothing to summarize yet')
    expect(mockSummarize).not.toHaveBeenCalled()
    expect(roomUpdate).not.toHaveBeenCalled()
  })
})

// ── markAttendance ───────────────────────────────────────────────────

describe('markAttendance', () => {
  /* setup_completed: a "start now" room is live from the moment it is created, minutes before
     the professor presses Start. markAttendance refuses until then, so a room that stands in
     for a class in progress has to say it has actually started (#82). */
  const liveRoom = {
    id: ROOM_ID, section_id: 'sec-1', prof_id: PROF.id, status: 'live', setup_completed: true,
  }

  it('never writes for a non-enrolled caller', async () => {
    authAs({ id: 'outsider' })
    const { attendanceUpsert } = buildDb({ room: liveRoom, enrolledAsStudent: false })

    const result = await markAttendance(ROOM_ID)

    expect(result.error).toBe('You are not enrolled in this section')
    expect(attendanceUpsert).not.toHaveBeenCalled()
  })

  it('never writes after the room has ended', async () => {
    authAs(STUDENT)
    const { attendanceUpsert } = buildDb({ room: { ...liveRoom, status: 'ended' } })

    const result = await markAttendance(ROOM_ID)

    expect(result.error).toBe('Room has ended')
    expect(attendanceUpsert).not.toHaveBeenCalled()
  })

  it("upserts the caller's own row, leaving joined_at to the conflict path", async () => {
    authAs(STUDENT)
    const { attendanceUpsert } = buildDb({ room: liveRoom })

    const result = await markAttendance(ROOM_ID)

    expect(result.success).toBe(true)
    expect(attendanceUpsert).toHaveBeenCalledTimes(1)
    const [row, opts] = attendanceUpsert.mock.calls[0]
    expect(row.room_id).toBe(ROOM_ID)
    expect(row.student_id).toBe(STUDENT.id)
    expect(row.joined_at).toBeUndefined() // preserved on conflict — late heartbeats must not reset it
    expect(opts).toEqual({ onConflict: 'room_id,student_id' })
  })
})
