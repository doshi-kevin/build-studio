// The audience gate on the transcript read model (roadmap-engine.md §5.1).
//
// This reader runs on an ADMIN client — RLS is bypassed — so the conditions the
// migration's policies enforce in the database are re-applied here in plain JS.
// That makes them unit-testable at full fidelity: the student gate is a filter
// over rows the fake hands back, not a predicate the database applied for us.
//
// The rule these tests exist to pin: a professor who switched off "Catch me up"
// has declined to have their spoken words replayed to students EVERYWHERE
// (guardrail G14). Both the roadmap annotations and Athena's
// `get_what_was_said_in_class` now read through this one function, so a
// regression here leaks the professor's speech on two surfaces at once.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { fetchSectionTranscriptInsights } from '@/lib/live-classroom/insights/read'
import type { TranscriptInsights } from '@/lib/validations/lc-transcript-insights'

const SECTION = 'sec-1'

const insights = (over: Partial<TranscriptInsights> = {}): TranscriptInsights => ({
  version: 1,
  empty: false,
  droppedClaims: 0,
  claims: [
    {
      kind: 'commitment',
      summary: 'The deadline moved to Friday.',
      quote: 'I am pushing the deadline to Friday',
      deckId: 'deck-1',
      deckTitle: 'Lecture 6',
      pageNumber: 11,
    },
  ],
  depth: [{ deckId: 'deck-1', pageNumber: 8, words: 1800, minutes: 12 }],
  ...over,
})

interface Room {
  name: string | null
  status: string | null
  lecture_summary_enabled: boolean | null
  created_at: string | null
  ended_at: string | null
  section_id: string | null
}
const room = (over: Partial<Room> = {}): Room => ({
  name: 'Lecture 6 live',
  status: 'ended',
  // Null is the pre-toggle default and must read as ON, like getLectureSummary
  // and the policy's COALESCE.
  lecture_summary_enabled: null,
  created_at: '2026-03-01T09:00:00Z',
  ended_at: '2026-03-01T10:30:00Z',
  section_id: SECTION,
  ...over,
})

interface Row {
  room_id: string
  insights: unknown
  lc_rooms: Room | Room[] | null
}

/** Minimal PostgREST double: records the narrowing so the tenant scope can be
 *  asserted, and resolves the chain as a thenable (the reader has no terminal
 *  call — it awaits the builder itself). */
function makeDb(rows: Row[], error: { message: string } | null = null) {
  const calls = {
    table: '' as string,
    select: '' as string,
    filters: [] as { col: string; val: unknown }[],
    limit: null as number | null,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: (s: string) => {
      calls.select = s
      return chain
    },
    eq: (col: string, val: unknown) => {
      calls.filters.push({ col, val })
      return chain
    },
    order: () => chain,
    limit: (n: number) => {
      calls.limit = n
      return chain
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then: (res: any, rej: any) =>
      Promise.resolve({ data: error ? null : rows, error }).then(res, rej),
  }
  const db = {
    from: (table: string) => {
      calls.table = table
      return chain
    },
  }
  return { db, calls }
}

const read = (rows: Row[], audience: 'professor' | 'student', error: { message: string } | null = null) => {
  const { db, calls } = makeDb(rows, error)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { out: fetchSectionTranscriptInsights(db as any, SECTION, audience), calls }
}

describe('fetchSectionTranscriptInsights — the student gate (G14)', () => {
  const rows: Row[] = [
    { room_id: 'r-off', insights: insights(), lc_rooms: room({ lecture_summary_enabled: false }) },
    { room_id: 'r-on', insights: insights(), lc_rooms: room({ lecture_summary_enabled: true }) },
    { room_id: 'r-null', insights: insights(), lc_rooms: room({ lecture_summary_enabled: null }) },
  ]

  it('hides a room whose professor switched replay off, and keeps the pre-toggle default on', async () => {
    const { out } = read(rows, 'student')
    expect((await out).map((r) => r.roomId)).toEqual(['r-on', 'r-null'])
  })

  it('shows the professor every room of their own — including the one students cannot see', async () => {
    const { out } = read(rows, 'professor')
    expect((await out).map((r) => r.roomId)).toEqual(['r-off', 'r-on', 'r-null'])
  })
})

describe('fetchSectionTranscriptInsights — shaping and refusals', () => {
  it('skips a row whose stored blob no longer parses, and keeps its siblings', async () => {
    const { out } = read(
      [
        { room_id: 'r-old', insights: { version: 0, claims: 'nope' }, lc_rooms: room() },
        { room_id: 'r-ok', insights: insights(), lc_rooms: room() },
      ],
      'student',
    )
    const got = await out
    expect(got.map((r) => r.roomId)).toEqual(['r-ok'])
    expect(got[0].insights.claims[0].quote).toBe('I am pushing the deadline to Friday')
  })

  it('resolves the room join whether PostgREST hands back an object or an array', async () => {
    const { out } = read([{ room_id: 'r-1', insights: insights(), lc_rooms: [room()] }], 'student')
    expect((await out)[0].roomName).toBe('Lecture 6 live')
  })

  it('drops a row with no room at all rather than reading it unguarded', async () => {
    // No join row means no section, no status and no toggle to check — the gate
    // cannot be applied, so the row must not be returned.
    const { out } = read([{ room_id: 'r-1', insights: insights(), lc_rooms: null }], 'student')
    expect(await out).toEqual([])
  })

  it('normalises a blank room name to null and falls back to created_at for the date', async () => {
    const { out } = read(
      [{ room_id: 'r-1', insights: insights(), lc_rooms: room({ name: '   ', ended_at: null }) }],
      'student',
    )
    expect(await out).toMatchObject([{ roomName: null, endedAt: '2026-03-01T09:00:00Z' }])
  })

  it('returns [] on a read error instead of throwing at the caller', async () => {
    const { out } = read([], 'student', { message: 'boom' })
    expect(await out).toEqual([])
  })

  it('scopes the read to this section, ready extractions and ended rooms, and bounds it', async () => {
    const { out, calls } = read([], 'professor')
    await out
    expect(calls.table).toBe('lc_transcript_insights')
    expect(calls.filters).toEqual([
      { col: 'status', val: 'ready' },
      { col: 'lc_rooms.section_id', val: SECTION },
      { col: 'lc_rooms.status', val: 'ended' },
    ])
    expect(calls.limit).toBeGreaterThan(0)
  })
})
