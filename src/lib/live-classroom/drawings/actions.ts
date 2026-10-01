// Persistence path for drawing strokes.
//
// Live strokes go straight over the ephemeral channel via channel.send()
// (no server hop, <100ms latency). This server action handles the
// permanent storage layer: every batch of completed strokes is bulk
// inserted into `lc_slide_annotations` so they survive page reloads,
// late joiners, and post-class review.
//
// Per-user rate limit: 1 batch / sec / user / room, enforced via
// pg_try_advisory_xact_lock so it survives multi-instance deployments.
//
// Security: every stroke's authorId is OVERWRITTEN with the authenticated
// user's id, regardless of what the client sent. Without this, a
// malicious client could attribute strokes to other users.

'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { MAX_STROKES_PER_BATCH } from './types'

const strokePointSchema = z.object({
  x: z.number(),
  y: z.number(),
  t: z.number(),
})

const strokeSchema = z.object({
  id: z.string().min(1),
  slideIndex: z.number().int().nonnegative(),
  points: z.array(strokePointSchema).min(1).max(2000),
  color: z.string().min(1).max(64),
  width: z.number().min(0.1).max(64),
  authorId: z.string().uuid(),
})

const persistInputSchema = z.object({
  roomId: z.string().uuid(),
  // Deck active when these strokes were drawn (may differ from the room's
  // current active deck if a switch happened mid-batch). Server validates
  // it belongs to the room.
  deckId: z.string().uuid(),
  strokes: z.array(strokeSchema).min(1).max(MAX_STROKES_PER_BATCH),
})

const clearInputSchema = z.object({
  roomId: z.string().uuid(),
  deckId: z.string().uuid(),
  slideIndex: z.number().int().nonnegative(),
})

// Confirm a deck belongs to the room — keeps per-slide writes bound to a
// deck of the caller's own room (IDOR-safe) while still accepting delayed
// writes to a now-inactive deck.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deckBelongsToRoom(adminDb: any, deckId: string, roomId: string): Promise<boolean> {
  const { data } = await adminDb
    .from('lc_decks')
    .select('id')
    .eq('id', deckId)
    .eq('room_id', roomId)
    .maybeSingle()
  return !!data
}

/**
 * Append a batch of strokes to permanent storage.
 *
 * Called by the client every ~2s with whatever strokes the user drew in
 * that window. Strokes are also live-broadcast separately on the
 * ephemeral topic for sub-100ms peer-to-peer rendering — this action only
 * handles durability.
 */
export async function persistStrokes(
  roomId: string,
  deckId: string,
  strokes: Array<{
    id: string
    slideIndex: number
    points: Array<{ x: number; y: number; t: number }>
    color: string
    width: number
    authorId: string
  }>,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = persistInputSchema.safeParse({ roomId, deckId, strokes })
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Authorize: caller must be prof or enrolled student.
    const { data: room } = await adminDb
      .from('lc_rooms')
      .select('section_id, prof_id')
      .eq('id', roomId)
      .single()
    if (!room) return { error: 'Room not found' }

    if (room.prof_id !== user.id) {
      const { data: enrollment } = await adminDb
        .from('enrollments')
        .select('id')
        .eq('section_id', room.section_id)
        .eq('student_id', user.id)
        .in('status', ['enrolled', 'completed'])
        .maybeSingle()
      if (!enrollment) return { error: 'Forbidden' }
    }

    // Bind to a deck of this room (accepts a now-inactive deck for in-flight
    // batches drawn just before a switch).
    if (!(await deckBelongsToRoom(adminDb, parsed.data.deckId, roomId))) {
      return { error: 'Deck not found' }
    }

    // Distributed rate limit: 1 batch/sec/user/room via
    // pg_try_advisory_xact_lock. Drops silently if exceeded — client
    // shouldn't surface a toast, the next batch will succeed.
    const { data: rate } = await adminDb.rpc('lc_try_drawings_lock', {
      p_user_id: user.id,
      p_room_id: roomId,
    })
    if (rate === false) {
      return { success: true }
    }

    // Security: overwrite every stroke's authorId with the authenticated
    // user. Otherwise a malicious client could attribute strokes to others.
    const safeStrokes = parsed.data.strokes.map((s) => ({ ...s, authorId: user.id }))

    // Bulk insert as one row per stroke.
    const rows = safeStrokes.map((s) => ({
      room_id: roomId,
      deck_id: parsed.data.deckId,
      slide_index: s.slideIndex,
      stroke: s,
      author_id: user.id,
    }))
    const { error } = await adminDb.from('lc_slide_annotations').insert(rows)
    if (error) {
      logger.error('persistStrokes: insert failed', error, { roomId, count: rows.length })
      return { error: 'Failed to persist strokes' }
    }

    return { success: true }
  } catch (err) {
    logger.error('persistStrokes: unexpected', err, { roomId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Permanently delete all annotations for a slide. Only the room's
 * professor may call this — students don't have INSERT-from-clear power.
 *
 * Pairs with the live `drawing_clear` ephemeral broadcast: prof clicks
 * Clear → broadcast wipes everyone's local canvas instantly → this
 * action removes the rows so reloads stay clean.
 */
export async function clearSlideAnnotations(
  roomId: string,
  deckId: string,
  slideIndex: number,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = clearInputSchema.safeParse({ roomId, deckId, slideIndex })
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Authorize: only the room's professor.
    const { data: room } = await adminDb
      .from('lc_rooms')
      .select('prof_id')
      .eq('id', roomId)
      .single()
    if (!room) return { error: 'Room not found' }
    if (room.prof_id !== user.id) return { error: 'Only the professor can clear annotations' }

    if (!(await deckBelongsToRoom(adminDb, parsed.data.deckId, roomId))) {
      return { error: 'Deck not found' }
    }

    // Scope the clear to this deck's slide so it never wipes another deck's
    // strokes that share the same slide index.
    const { error } = await adminDb
      .from('lc_slide_annotations')
      .delete()
      .eq('deck_id', parsed.data.deckId)
      .eq('slide_index', slideIndex)

    if (error) {
      logger.error('clearSlideAnnotations: delete failed', error, { roomId, deckId, slideIndex })
      return { error: 'Failed to clear annotations' }
    }

    return { success: true }
  } catch (err) {
    logger.error('clearSlideAnnotations: unexpected', err, { roomId, deckId, slideIndex })
    return { error: 'An unexpected error occurred' }
  }
}
