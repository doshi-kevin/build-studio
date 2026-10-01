// Student notetaker for the live classroom. Each student has one freeform
// notes document per room (lc_notes, PK room_id+student_id). The client
// autosaves while typing (debounced) and reads the doc on join + on the
// post-session insights page.
//
// Security: authenticates, verifies enrollment in the room's section (section
// derived from the admin-fetched room row, never from input), and only ever
// reads/writes the caller's own (room_id, student_id) row. Mirrors
// markAttendance — writes go through the admin client because lc_notes has no
// INSERT/UPDATE RLS policy. Unlike attendance, saving is allowed after the
// room ends so students can extend their notes during review.

'use server'

import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { getAuthUser, loadRoom, isEnrolled } from '@/lib/live-classroom/room-auth'

const roomIdSchema = z.string().uuid()
// Cap guards against unbounded writes. Content is stringified TipTap JSON, which
// is far more verbose than the visible text (every node/mark adds overhead), so
// the limit is generous — a long formatted lecture's notes stay well under it.
const saveSchema = z.object({
  roomId: z.string().uuid(),
  content: z.string().max(500_000),
})

export async function getNotes(
  roomId: string,
): Promise<{ content?: string; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = roomIdSchema.safeParse(roomId)
    if (!parsed.success) return { error: 'Invalid room ID' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const room = await loadRoom(adminDb, parsed.data)
    if (!room) return { error: 'Room not found' }

    const enrolled = await isEnrolled(adminDb, room.section_id, user.id)
    if (!enrolled) return { error: 'You are not enrolled in this section' }

    const { data, error } = await adminDb
      .from('lc_notes')
      .select('content')
      .eq('room_id', parsed.data)
      .eq('student_id', user.id)
      .maybeSingle()

    if (error) {
      logger.error('getNotes: select failed', error, { roomId: parsed.data })
      return { error: 'Failed to load notes' }
    }

    return { content: (data?.content as string | undefined) ?? '' }
  } catch (error) {
    logger.error('getNotes: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

export async function saveNotes(
  roomId: string,
  content: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = saveSchema.safeParse({ roomId, content })
    if (!parsed.success) return { error: 'Invalid input' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const room = await loadRoom(adminDb, parsed.data.roomId)
    if (!room) return { error: 'Room not found' }

    const enrolled = await isEnrolled(adminDb, room.section_id, user.id)
    if (!enrolled) return { error: 'You are not enrolled in this section' }

    // First save inserts (created_at defaults to now); later ones refresh
    // content + updated_at. student_id is the authenticated caller — never
    // taken from input — so a student can only write their own row.
    const { error } = await adminDb
      .from('lc_notes')
      .upsert(
        {
          room_id: parsed.data.roomId,
          student_id: user.id,
          content: parsed.data.content,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'room_id,student_id' },
      )

    if (error) {
      logger.error('saveNotes: upsert failed', error, { roomId: parsed.data.roomId })
      return { error: 'Failed to save notes' }
    }

    // No logEvent: autosave fires on every debounce window — too chatty (same
    // rationale as markAttendance / advanceSlide).
    return { success: true }
  } catch (error) {
    logger.error('saveNotes: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}
