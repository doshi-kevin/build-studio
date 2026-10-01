// Guards the column list of the three `liveClassroomQueries` lc_rooms readers.
//
// Issue #550: `anon`/`authenticated` no longer hold a table-level SELECT on
// `lc_rooms` — the `lc_rooms_revoke_lecture_summary_select` migration re-grants
// SELECT column by column, everything except `lecture_summary`. Every call site
// of these three readers passes the *user* client (`createClient()`), so they run
// as `authenticated`: a regression back to `select('*')` does not degrade, it
// throws `permission denied for table lc_rooms` and takes Live Classroom down for
// students mid-class. Hence a test rather than a comment.
//
// The complementary direction (`lecture_summary` must not be shipped to the
// client) is guarded for the snapshot path in `snapshot-room-columns.test.ts`.

import { describe, it, expect, vi } from 'vitest'

import { liveClassroomQueries } from '@/lib/supabase/queries'

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const SECTION_ID = '7f8d8c0e-1234-4abc-8def-0123456789ab'

/** A SupabaseClient stub that records the `select()` argument and satisfies
 *  every terminator the three readers use (`single`, `maybeSingle`, and a bare
 *  await on the builder). */
function capturingClient(captured: { select?: string }) {
  const result = { data: null, error: null }
  const builder = {
    select: vi.fn((cols: string) => {
      captured.select = cols
      return builder
    }),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: vi.fn(() => builder) } as any
}

/** Columns the pages rendering these rows actually read (professor + student
 *  Live Classroom hubs, presenter, projector, viewer, report, insights). */
const CONSUMED_COLUMNS = [
  'id',
  'section_id',
  'prof_id',
  'status',
  'name',
  'created_at',
  'setup_completed',
  'deck_page_count',
  'current_slide',
]

const READERS: Array<[string, (client: unknown) => Promise<unknown>]> = [
  ['getRoomById', (c) => liveClassroomQueries.getRoomById(c as never, ROOM_ID)],
  ['getActiveRoomForSection', (c) => liveClassroomQueries.getActiveRoomForSection(c as never, SECTION_ID)],
  ['listRoomsForSection', (c) => liveClassroomQueries.listRoomsForSection(c as never, SECTION_ID)],
]

describe.each(READERS)('liveClassroomQueries.%s lc_rooms columns', (_name, call) => {
  it('names explicit columns, omits lecture_summary, and keeps what consumers read', async () => {
    const captured: { select?: string } = {}
    await call(capturingClient(captured))

    expect(captured.select, 'lc_rooms was not queried with select()').toBeTruthy()
    const columns = captured.select!.split(',').map((c) => c.trim())

    // A `select('*')` regression is the outage: it asks for lecture_summary,
    // which authenticated may no longer read.
    expect(columns).not.toContain('*')
    expect(columns).not.toContain('lecture_summary')

    for (const column of CONSUMED_COLUMNS) {
      expect(columns, `${column} is read by a consumer but not selected`).toContain(column)
    }
  })
})
