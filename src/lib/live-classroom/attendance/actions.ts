// Attendance heartbeat for live classroom. The student client calls
// markAttendance on join and every ~3 min while in class; one row per
// (room, student) records joined_at (first heartbeat) and last_seen_at
// (latest heartbeat). Feeds the professor's post-session report —
// presence on the realtime topic is ephemeral and never persisted.
//
// Since #82 the FIRST heartbeat needs the join code the professor is showing on the
// projector, so opening the room URL from a dorm no longer counts as being in class.
// Three things about that are deliberate:
//
//   * It gates ATTENDANCE, not the room. A student without the code still watches the
//     slides and answers polls. Gating the room would turn a dropped connection into a
//     lost lecture, which is worse than an unearned tick.
//   * Once a student is present, later heartbeats never re-ask. A browser crash 20
//     minutes in must not cost them the code prompt again.
//   * Attempts are rate-limited. A 4-character code is short enough to read from the
//     back of a hall, which also makes it short enough to script, and the limit rather
//     than the length is what makes that pointless.
//
// Security: authenticates, verifies enrollment in the room's section
// (section derived from the admin-fetched room row, never from input),
// and only ever writes the caller's own (room_id, student_id) row.

'use server'

import { z } from 'zod'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { getAuthUser, loadRoom, isEnrolled } from '@/lib/live-classroom/room-auth'
import { normalizeJoinCode } from '@/lib/live-classroom/join-code'

const roomIdSchema = z.string().uuid()

export async function markAttendance(
  roomId: string,
  /** The projector code. Only consulted on a student's FIRST heartbeat for a room. */
  code?: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = roomIdSchema.safeParse(roomId)
    if (!parsed.success) return { error: 'Invalid room ID' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const room = await loadRoom(adminDb, parsed.data)
    if (!room) return { error: 'Room not found' }
    if (room.status !== 'live') return { error: 'Room has ended' }

    /* A "start now" room is INSERTed already live, minutes before the professor finishes
       uploading a deck and presses Start — and the section hub advertises it as joinable that
       whole time. The code is minted at Start, so without this a student at home could join
       during the upload and be ticked present having never seen the projector, which is the
       exact thing the code exists to stop. Nothing is recorded until the class has begun. */
    if (!room.setup_completed) return { error: 'This class has not started yet' }

    const enrolled = await isEnrolled(adminDb, room.section_id, user.id)
    if (!enrolled) return { error: 'You are not enrolled in this section' }

    const entitlement = await checkEntitlementBySection(adminDb, room.section_id, 'live-classroom')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('live-classroom') }

    /* Already present? Then this is a later heartbeat and the code is not asked for again
       (#82). Checked BEFORE the code branch so a reconnect is free. */
    const { data: existing } = await adminDb
      .from('lc_attendance')
      .select('student_id')
      .eq('room_id', parsed.data)
      .eq('student_id', user.id)
      .maybeSingle()

    if (!existing) {
      /* Read the code with the ADMIN client. lc_room_codes has a professor-only SELECT
         policy and no student policy at all, which is the point — a student's own session
         cannot read the value it is being asked for. */
      const { data: codeRow } = await adminDb
        .from('lc_room_codes')
        .select('code')
        .eq('room_id', parsed.data)
        .maybeSingle()

      /* A class already running when this shipped has no code row, and keeps the old
         behaviour rather than being locked out of its own roster mid-lecture. */
      if (codeRow?.code) {
        const supplied = normalizeJoinCode(code ?? '')
        if (!supplied) return { error: 'NEEDS_CODE' }

        /* Rate-limit per (room, student) BEFORE comparing, so a wrong guess costs an
           attempt whether or not it was well-formed. Reuses the limiter the login path
           uses. 10 tries per 10 minutes leaves a student who is fumbling a projector code
           plenty of room while making 923,521 combinations unreachable. */
        const { data: limit, error: limitError } = await adminDb.rpc('increment_auth_rate_limit', {
          p_key: `lc_join:${parsed.data}:${user.id}`,
          p_cap: 10,
          p_window_minutes: 10,
        })
        /* FAIL CLOSED, exactly as claimAuthAttempt does on the login path. A 4-character code
           is only safe because attempts are counted; if the counter is unreachable the code is
           four characters and nothing else, so an unanswered limiter has to refuse rather than
           wave the attempt through. Refusing costs a present student one retry. */
        if (limitError) {
          logger.error('markAttendance: limiter rpc failed, refusing attempt', limitError, {
            roomId: parsed.data,
          })
          return { error: 'Could not check you in. Try again.' }
        }
        // The first row, not the last: the RPC has appended a contradictory second row on the
        // rejected path before (see 20260807153351_auth_rate_limits_and_extraction_job_tenancy).
        const limitRow = Array.isArray(limit) ? limit[0] : limit
        if (!limitRow?.accepted) {
          return { error: 'Too many attempts. Ask your professor for the code.' }
        }

        if (supplied !== codeRow.code) {
          return { error: "That code isn't right. Check the screen and try again." }
        }

        // Correct: clear the bucket so a student who mistypes once then succeeds is not
        // walking toward a lockout for the rest of class.
        await adminDb.rpc('clear_auth_rate_limit', { p_key: `lc_join:${parsed.data}:${user.id}` })
      }
    }

    // First heartbeat inserts (joined_at defaults to now); later ones only
    // refresh last_seen_at — joined_at is preserved by the conflict path.
    const { error } = await adminDb
      .from('lc_attendance')
      .upsert(
        {
          room_id: parsed.data,
          student_id: user.id,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'room_id,student_id' },
      )

    if (error) {
      logger.error('markAttendance: upsert failed', error, { roomId: parsed.data })
      return { error: 'Failed to record attendance' }
    }

    // No logEvent: this fires every ~3 min per student — too chatty (same
    // rationale as advanceSlide).
    return { success: true }
  } catch (error) {
    logger.error('markAttendance: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}
