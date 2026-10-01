/**
 * Team Meeting Hub — unit tests for the pure logic: link/input validation,
 * group-availability overlap, and the reminder sweep's claim-then-emit
 * idempotency.
 */

import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  meetRoomSchema,
  attachNotesSchema,
  logMeetingSchema,
  availabilitySchema,
} from '@/lib/validations/team-meeting'
import { slotUserSets, bestCommonTimes } from '@/lib/meetings/overlap'

// emitEvent is mocked so the sweep test asserts *when* we notify, without a DB.
vi.mock('@/lib/events/emit', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
import { emitEvent } from '@/lib/events/emit'
import { runMeetingReminderSweep } from '@/lib/notifications/meeting-reminder-sweep'

describe('validation', () => {
  it('accepts an https meeting link and rejects non-https / junk', () => {
    expect(meetRoomSchema.safeParse({ meetUrl: 'https://meet.google.com/abc-defg-hij' }).success).toBe(true)
    expect(meetRoomSchema.safeParse({ meetUrl: 'http://meet.google.com/x' }).success).toBe(false)
    expect(meetRoomSchema.safeParse({ meetUrl: 'not a url' }).success).toBe(false)
  })

  it('validates notes links and optional label', () => {
    expect(attachNotesSchema.safeParse({ notesUrl: 'https://fathom.video/share/x' }).success).toBe(true)
    expect(attachNotesSchema.safeParse({ notesUrl: 'javascript:alert(1)' }).success).toBe(false)
  })

  it('requires a meeting title; scheduledStart is optional ISO', () => {
    expect(logMeetingSchema.safeParse({ title: '' }).success).toBe(false)
    expect(logMeetingSchema.safeParse({ title: 'Kickoff' }).success).toBe(true)
    expect(
      logMeetingSchema.safeParse({ title: 'Kickoff', scheduledStart: '2026-07-28T14:00:00.000Z' }).success,
    ).toBe(true)
    expect(logMeetingSchema.safeParse({ title: 'Kickoff', scheduledStart: 'soon' }).success).toBe(false)
  })

  it('bounds the availability selection', () => {
    expect(availabilitySchema.safeParse({ slotStarts: [] }).success).toBe(true)
    const tooMany = Array.from({ length: 1001 }, () => '2026-07-28T14:00:00.000Z')
    expect(availabilitySchema.safeParse({ slotStarts: tooMany }).success).toBe(false)
  })
})

describe('availability overlap', () => {
  it('groups users per slot and canonicalises timezone-varying ISO', () => {
    const sets = slotUserSets([
      { slot_start: '2026-07-28T14:00:00+00:00', user_id: 'u1' },
      { slot_start: '2026-07-28T14:00:00.000Z', user_id: 'u2' }, // same instant, different form
      { slot_start: '2026-07-28T15:00:00Z', user_id: 'u1' },
    ])
    expect(sets.get('2026-07-28T14:00:00.000Z')?.size).toBe(2)
    expect(sets.get('2026-07-28T15:00:00.000Z')?.size).toBe(1)
  })

  it('ranks future slots ≥2 people can do, factoring my selection; excludes past + solo', () => {
    const now = Date.parse('2026-07-27T00:00:00Z')
    const counts = slotUserSets([
      { slot_start: '2026-07-28T14:00:00Z', user_id: 'u2' }, // teammate free
      { slot_start: '2026-07-29T09:00:00Z', user_id: 'u2' }, // only teammate → solo unless I pick
      { slot_start: '2026-07-01T09:00:00Z', user_id: 'u2' }, // past
      { slot_start: '2026-07-01T09:00:00Z', user_id: 'u1' },
    ])
    const mySelection = new Set(['2026-07-28T14:00:00.000Z']) // I also pick the first
    const best = bestCommonTimes(counts, mySelection, 'u1', now)
    expect(best).toEqual([{ iso: '2026-07-28T14:00:00.000Z', count: 2 }])
  })
})

describe('runMeetingReminderSweep', () => {
  // Chainable Supabase mock: every builder method returns the builder; each
  // awaited chain resolves the next queued result (in call order).
  function mockAdminDb(results: unknown[]): SupabaseClient {
    let i = 0
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(results[i++])
        return () => proxy
      },
    }
    const proxy = new Proxy({}, handler)
    return proxy as unknown as SupabaseClient
  }

  const meeting = {
    id: 'm1',
    team_id: 't1',
    project_id: 'p1',
    section_id: 's1',
    title: 'Sync',
    scheduled_start: '2026-07-28T14:00:00Z',
  }

  it('dryRun reports due count without notifying', async () => {
    ;(emitEvent as ReturnType<typeof vi.fn>).mockClear()
    const db = mockAdminDb([{ data: [meeting], error: null }])
    const res = await runMeetingReminderSweep(db, { force: true, dryRun: true })
    expect(res).toEqual({ due: 1, reminded: 0 })
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('claims then emits once for a due meeting', async () => {
    ;(emitEvent as ReturnType<typeof vi.fn>).mockClear()
    const db = mockAdminDb([
      { data: [meeting], error: null }, // select due
      { data: { id: 'm1' }, error: null }, // claim succeeds
      { data: [{ user_id: 'a' }, { user_id: 'b' }], error: null }, // members
    ])
    const res = await runMeetingReminderSweep(db, { force: true })
    expect(res).toEqual({ due: 1, reminded: 1 })
    expect(emitEvent).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — a row already claimed is skipped (no emit)', async () => {
    ;(emitEvent as ReturnType<typeof vi.fn>).mockClear()
    const db = mockAdminDb([
      { data: [meeting], error: null }, // select due
      { data: null, error: null }, // claim returns nothing → another run took it
    ])
    const res = await runMeetingReminderSweep(db, { force: true })
    expect(res).toEqual({ due: 1, reminded: 0 })
    expect(emitEvent).not.toHaveBeenCalled()
  })
})
