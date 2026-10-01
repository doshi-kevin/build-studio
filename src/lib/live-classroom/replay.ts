// Replay buffer reader. Returns every persisted lc_event for a room with
// seq > lastSeq, ordered by seq. Used by the resilient channel hook on
// every (re)subscribe and on every visibility-change → visible.
//
// Auth: caller must have access to the room (professor or enrolled
// student). Read goes through the admin client because the lc_events
// table has no client SELECT policy by design — clients always go
// through this server action.

'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import type { LcEvent } from './broadcast/types'

const inputSchema = z.object({
  roomId: z.string().uuid(),
  lastSeq: z.number().int().nonnegative(),
})

export interface GetEventsSinceResult {
  events?: LcEvent[]
  /** True when the result hit the row cap and may not include every
   *  event since lastSeq. The caller should treat this as a signal to
   *  drop local state and re-fetch a fresh snapshot. */
  truncated?: boolean
  error?: string
}

const REPLAY_LIMIT = 500

/**
 * Returns every event in lc_events for `roomId` with seq > lastSeq,
 * ordered ascending by seq. Pass lastSeq=0 to fetch everything still in
 * the replay window. Caller must be enrolled in the room's section or
 * be the room's professor.
 */
export async function getEventsSince(
  roomId: string,
  lastSeq: number,
): Promise<GetEventsSinceResult> {
  try {
    const parsed = inputSchema.safeParse({ roomId, lastSeq })
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Authorize: either prof of the room, or enrolled student in the section.
    const { data: room, error: roomError } = await adminDb
      .from('lc_rooms')
      .select('id, section_id, prof_id')
      .eq('id', roomId)
      .single()

    if (roomError || !room) return { error: 'Room not found' }

    const isProf = room.prof_id === user.id
    let isEnrolled = false
    if (!isProf) {
      const { data: enrollment } = await adminDb
        .from('enrollments')
        .select('id')
        .eq('section_id', room.section_id)
        .eq('student_id', user.id)
        .in('status', ['enrolled', 'completed'])
        .maybeSingle()
      isEnrolled = !!enrollment
    }

    if (!isProf && !isEnrolled) return { error: 'Forbidden' }

    const { data: rows, error } = await adminDb
      .from('lc_events')
      .select('seq, event_type, payload, created_at')
      .eq('room_id', roomId)
      .gt('seq', lastSeq)
      .order('seq', { ascending: true })
      .limit(REPLAY_LIMIT)

    if (error) {
      logger.error('getEventsSince: query failed', error, { roomId, lastSeq })
      return { error: 'Failed to load events' }
    }

    type Row = { seq: number; event_type: string; payload: Record<string, unknown>; created_at: string }
    const events: LcEvent[] = (rows ?? []).map((row: Row) => ({
      seq: row.seq,
      ts: row.created_at,
      type: row.event_type,
      data: row.payload,
    } as LcEvent))

    return { events, truncated: events.length === REPLAY_LIMIT }
  } catch (err) {
    logger.error('getEventsSince: unexpected error', err, { roomId, lastSeq })
    return { error: 'An unexpected error occurred' }
  }
}
