// getUpcomingScheduledRooms — derives the "Upcoming" list badge state
// (slidesState) by stitching three bounded queries in JS. The precedence is the
// load-bearing bit: ready → processing → failed → none. A failed render deletes
// its deck row but leaves the failed job, so a failure with NO deck falls through
// to 'failed'; but a re-upload (a fresh deck present) must show 'processing' even
// though the stale failed job still exists. This test pins that four-way
// derivation AND the re-upload case.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { liveClassroomQueries } from '@/lib/supabase/queries'

const SECTION = 'sec-1'

// A thenable query builder: every method returns `this`; awaiting it resolves to
// the canned result for the table it was opened on.
function makeSupabase(results: Record<string, { data: unknown }>) {
  function builder(table: string) {
    const result = results[table] ?? { data: [] }
    const b: Record<string, unknown> = {}
    const self = () => b
    Object.assign(b, {
      select: self,
      eq: self,
      in: self,
      order: self,
      then: (onOk: (v: unknown) => unknown) => Promise.resolve({ ...result, error: null }).then(onOk),
    })
    return b
  }
  return { from: (table: string) => builder(table) }
}

describe('getUpcomingScheduledRooms slidesState derivation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('derives ready / processing / failed / none, and a re-upload beats a stale failed job', async () => {
    const rooms = [
      { id: 'r-ready', name: null, scheduled_at: '2026-08-01T10:00:00Z', recurrence_group_id: null },
      { id: 'r-processing', name: null, scheduled_at: '2026-08-02T10:00:00Z', recurrence_group_id: null },
      { id: 'r-failed', name: null, scheduled_at: '2026-08-03T10:00:00Z', recurrence_group_id: 'g1' },
      { id: 'r-none', name: 'One-off', scheduled_at: '2026-08-04T10:00:00Z', recurrence_group_id: null },
      // Re-upload: a fresh (unrendered) deck exists AND a stale failed job lingers.
      { id: 'r-reupload', name: null, scheduled_at: '2026-08-05T10:00:00Z', recurrence_group_id: null },
    ]
    const decks = [
      { room_id: 'r-ready', deck_url: 'live-classroom-decks/x' }, // rendered → ready
      { room_id: 'r-processing', deck_url: null }, // uploaded, not yet rendered → processing
      { room_id: 'r-reupload', deck_url: null }, // fresh re-upload rendering → processing
      // r-failed has NO deck row (a failed render deleted it) but a failed job.
    ]
    // Failed render jobs keyed by roomId in params.
    const jobs = [
      { params: { roomId: 'r-failed' }, status: 'failed' },
      { params: { roomId: 'r-reupload' }, status: 'failed' }, // stale — a prior render failed
    ]

    const supabase = makeSupabase({
      lc_rooms: { data: rooms },
      lc_decks: { data: decks },
      background_jobs: { data: jobs },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await liveClassroomQueries.getUpcomingScheduledRooms(supabase as any, SECTION)

    const byId = Object.fromEntries(out.map((r) => [r.id, r.slidesState]))
    expect(byId['r-ready']).toBe('ready')
    expect(byId['r-processing']).toBe('processing')
    expect(byId['r-failed']).toBe('failed') // no deck → failed shows
    expect(byId['r-reupload']).toBe('processing') // fresh deck beats the stale failed job
    expect(byId['r-none']).toBe('none')

    // isRecurring derives from recurrence_group_id presence.
    expect(out.find((r) => r.id === 'r-failed')?.isRecurring).toBe(true)
    expect(out.find((r) => r.id === 'r-none')?.isRecurring).toBe(false)
  })

  it('returns [] when the section has no scheduled rooms (no follow-up queries needed)', async () => {
    const supabase = makeSupabase({ lc_rooms: { data: [] } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await liveClassroomQueries.getUpcomingScheduledRooms(supabase as any, SECTION)
    expect(out).toEqual([])
  })
})
