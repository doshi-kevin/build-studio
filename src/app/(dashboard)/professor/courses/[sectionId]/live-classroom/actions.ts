// Live Classroom Server Actions — room lifecycle, deck management,
// real-time transcription, and AI quiz generation. Handles creating
// rooms, advancing slides, ending sessions, the "Pick from Modules"
// flow, per-slide transcription append, and one-click Gemini-powered
// quiz generation with concept analytics. Only professors can manage rooms.

'use server'

import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/supabase/event-logger'
import { emitEvent } from '@/lib/events/emit'
import { logger } from '@/lib/logger'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { generateJoinCode, JOIN_CODE_MAX_ATTEMPTS } from '@/lib/live-classroom/join-code'
import { deleteTranscriptVectors } from '@/lib/pinecone/data'
import { verifySectionAccess, canWriteAsProfessor } from '@/lib/auth/section-access'
import {
  createRoomDraftSchema,
  advanceSlideSchema,
  setScreenBlankSchema,
  endRoomSchema,
  createDeckUploadUrlSchema,
  applyModuleItemAsDeckSchema,
  appendTranscriptionSchema,
  generateLiveQuizSchema,
  switchDeckSchema,
  removeDeckSchema,
  startLiveClassSchema,
  scheduleLiveClassSchema,
  enqueueScheduledDeckRenderSchema,
  cancelScheduledSessionSchema,
  roomIdSchema,
  interactionIdSchema,
  STALE_ROOM_THRESHOLD_MS,
  type CreateRoomDraftInput,
  type AdvanceSlideInput,
  type SetScreenBlankInput,
  type EndRoomInput,
  type CreateDeckUploadUrlInput,
  type ApplyModuleItemAsDeckInput,
  type AppendTranscriptionInput,
  type GenerateLiveQuizInput,
  type SwitchDeckInput,
  type RemoveDeckInput,
  type StartLiveClassInput,
  type ScheduleLiveClassInput,
  type EnqueueScheduledDeckRenderInput,
  type CancelScheduledSessionInput,
} from '@/lib/validations/live-classroom'
import { enqueueJob } from '@/lib/jobs/enqueue'
import { generateLiveQuizFromTranscription } from '@/lib/ai/llm-client'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { matchInPool, canonicalizeName } from '@/lib/skills/reconcile'
import { selectLeafSkills } from '@/lib/skills/tree'
import { triggerClassInsights } from '@/lib/live-classroom/insights/trigger'
import { buildLectureContext } from '@/lib/live-classroom/lecture-context'
import { enqueueMasteryRecompute } from '@/lib/extraction/enqueue'
import { writePlacementEdge } from '@/lib/roadmap/placement'
import { isPptxEnabled } from '@/lib/live-classroom/deck-converter'
import type { ExtractionPageData } from '@/lib/validations/document-extraction'

/** Room ids arrive from the client on a reachable POST endpoint; a non-uuid would
 *  make Postgres reject the comparison outright rather than simply not match. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const LIVE_CLASSROOM_BUCKET = 'live-classroom-decks'
const COURSE_MATERIALS_BUCKET = 'course-materials'

// ── Helper: Recursive storage delete ─────────────────────────────
// Supabase storage.list() doesn't recurse into subdirectories.
// This helper lists top-level entries, recurses into folders, then
// batch-deletes all collected file paths.

async function deleteStorageFolder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  bucket: string,
  folder: string,
): Promise<void> {
  const { data: entries } = await adminDb.storage.from(bucket).list(folder)
  if (!entries || entries.length === 0) return

  const filePaths: string[] = []
  for (const entry of entries as Array<{ name: string; id: string | null; metadata: unknown }>) {
    const fullPath = `${folder}/${entry.name}`
    if (entry.id === null) {
      await deleteStorageFolder(adminDb, bucket, fullPath)
    } else {
      filePaths.push(fullPath)
    }
  }
  if (filePaths.length > 0) {
    await adminDb.storage.from(bucket).remove(filePaths)
  }
}

// ── Helper: Get authenticated user ────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

// ── Helper: Verify room ownership ─────────────────────────────────

async function verifyRoomOwnership(
  roomId: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ ok: boolean; room: any; adminDb: any }> {
  const adminDb = createAdminClient()
  const { data: room, error } = await adminDb
    .from('lc_rooms')
    .select('*')
    .eq('id', roomId)
    .single()

  if (error || !room) {
    return { ok: false, room: null, adminDb }
  }

  if (room.prof_id !== userId) {
    return { ok: false, room: null, adminDb }
  }

  // The room's section must also be the caller's. prof_id alone would accept a
  // forged row inserted with the attacker's own id and a victim's section_id —
  // ending such a room feeds attacker-authored transcript into that section's
  // "the professor said" surfaces. The RLS WITH CHECK now forbids creating one
  // (20260806193123); this keeps any pre-existing row inert too.
  const { data: section } = await adminDb
    .from('course_sections')
    .select('id')
    .eq('id', room.section_id)
    .eq('professor_id', userId)
    .maybeSingle()
  if (!section) {
    return { ok: false, room: null, adminDb }
  }

  return { ok: true, room, adminDb }
}

// ── Helpers: decks ───────────────────────────────────────────────
// A room holds many decks (lc_decks). These support add/switch and bind
// per-slide writes to the right deck.

// Next position for a new deck in the room (1-based, append order).
// Read-then-insert with no UNIQUE(room_id, position): two concurrent adds can
// collide on the same position. Tolerated — position only drives switcher
// ordering and an arbitrary tiebreak; a dup just means two decks sort together.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function nextDeckPosition(adminDb: any, roomId: string): Promise<number> {
  const { data } = await adminDb
    .from('lc_decks')
    .select('position')
    .eq('room_id', roomId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()
  return ((data?.position as number | undefined) ?? 0) + 1
}

// Confirm a deck belongs to a room (IDOR-safe binding for per-slide writes;
// accepts a now-inactive deck for in-flight chunks captured before a switch).
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

// ── Helper: Clean up stale rooms ──────────────────────────────────

async function cleanupStaleRooms(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - STALE_ROOM_THRESHOLD_MS).toISOString()

    /* Measured from started_at, not created_at — the same correction the
       lc_auto_end_stale_rooms cron got. created_at is when the room SHELL was
       opened, which for a scheduled session is whenever the professor put it on
       the calendar, routinely days ahead. Keying the 12h window off that ended a
       scheduled class the moment it started. The null branch preserves the case
       this sweep exists for: a room shell opened and abandoned without ever
       starting still expires 12h after creation. */
    const { data: staleRooms } = await adminDb
      .from('lc_rooms')
      .select('id, deck_url')
      .eq('section_id', sectionId)
      .eq('status', 'live')
      .or(`started_at.lt.${cutoff},and(started_at.is.null,created_at.lt.${cutoff})`)

    if (!staleRooms || staleRooms.length === 0) return

    for (const staleRoom of staleRooms) {
      await adminDb
        .from('lc_rooms')
        .update({ status: 'ended', ended_at: new Date().toISOString() })
        .eq('id', staleRoom.id)

      /* Deliberately does NOT delete the deck folder. This used to call
         deleteStorageFolder here, which is the same thing #764 removed from the
         SQL sweep: it contradicts endRoom's retention policy (endRoom keeps the
         files) and destroys objects sitting behind material promoted into a
         module. lc_reap_orphan_decks runs daily and collects genuine orphans. */

      logger.info('cleanupStaleRooms: Ended stale room', { roomId: staleRoom.id, sectionId })
    }
  } catch (error) {
    logger.error('cleanupStaleRooms: Failed', error, { sectionId })
    // Non-critical — don't throw
  }
}

// ── Action: Create Room Draft ─────────────────────────────────────

export async function createRoomDraft(
  input: CreateRoomDraftInput,
): Promise<{ roomId?: string; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // Validate input
    const parsed = createRoomDraftSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { sectionId } = parsed.data

    // Verify professor access
    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsProfessor(access.role)) {
      return { error: 'Only professors can start live classroom sessions' }
    }

    const adminDb = access.adminDb

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'live-classroom')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('live-classroom') }

    // Passive cleanup of stale rooms before creating a new one
    await cleanupStaleRooms(adminDb, sectionId)

    const { data: room, error: insertError } = await adminDb
      .from('lc_rooms')
      .insert({
        section_id: sectionId,
        prof_id: user.id,
        status: 'live',
        current_slide: 0,
      })
      .select('id')
      .single()

    if (insertError || !room) {
      logger.error('createRoomDraft: Insert failed', insertError, { sectionId })
      return { error: 'Failed to create live classroom' }
    }

    // Log event (fire-and-forget). Note: this only creates the room shell for the
    // pre-class setup step — students aren't notified here. The "class started"
    // notification fires from startLiveClass, when the deck is activated and the
    // session actually goes live in front of students.
    logEvent({
      userId: user.id,
      eventType: 'lc_room.started',
      eventCategory: 'professor',
      metadata: { roomId: room.id },
      sectionId,
    })

    revalidatePath(`/professor/courses/${sectionId}/live-classroom`)
    return { roomId: room.id }
  } catch (error) {
    logger.error('createRoomDraft: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Schedule Live Class ───────────────────────────────────
// Creates one (one-off) or many (weekly series) 'scheduled' rooms. For a
// non-recurring session the client then uploads a deck via createDeckUploadUrl
// and calls enqueueScheduledDeckRender — the render runs in the background so
// the professor can leave immediately. Recurring series get no pre-uploaded
// deck (the professor attaches one at each occurrence's pre-class screen).
// Attended model: nothing goes live to students here — the professor still
// clicks "Start class" (startLiveClass) at/near the scheduled time.

export async function scheduleLiveClass(
  input: ScheduleLiveClassInput,
): Promise<{ roomIds?: string[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = scheduleLiveClassSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }
    const { sectionId, name, occurrences, recurring } = parsed.data

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsProfessor(access.role)) {
      return { error: 'Only professors can schedule live classrooms' }
    }
    const adminDb = access.adminDb

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'live-classroom')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('live-classroom') }

    // All occurrences must be valid, future instants. Dedupe + sort ascending
    // so the returned roomIds line up with chronological order.
    const now = Date.now()
    const unique = Array.from(new Set(occurrences)).sort()
    const dates = unique.map((iso) => new Date(iso))
    if (dates.some((d) => Number.isNaN(d.getTime()) || d.getTime() <= now)) {
      return { error: 'Scheduled times must be in the future' }
    }

    const trimmedName = (name ?? '').trim()
    const groupId = recurring && unique.length > 1 ? randomUUID() : null

    const rows = unique.map((iso) => ({
      section_id: sectionId,
      prof_id: user.id,
      status: 'scheduled' as const,
      current_slide: 0,
      scheduled_at: iso,
      name: trimmedName.length > 0 ? trimmedName : null,
      recurrence_group_id: groupId,
    }))

    const { data: inserted, error: insertError } = await adminDb
      .from('lc_rooms')
      .insert(rows)
      .select('id, scheduled_at')

    if (insertError || !inserted) {
      logger.error('scheduleLiveClass: insert failed', insertError, { sectionId })
      return { error: 'Failed to schedule the session' }
    }

    logEvent({
      userId: user.id,
      eventType: 'lc_room.scheduled',
      eventCategory: 'professor',
      metadata: { count: inserted.length, recurring, recurrenceGroupId: groupId },
      sectionId,
    })

    revalidatePath(`/professor/courses/${sectionId}/live-classroom`)
    // Scheduled sessions surface as nodes on the course roadmap (both views).
    revalidatePath(`/professor/courses/${sectionId}/roadmap`)
    revalidatePath(`/student/courses/${sectionId}/roadmap`)

    const roomIds = (inserted as Array<{ id: string; scheduled_at: string }>)
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
      .map((r) => r.id)
    return { roomIds }
  } catch (error) {
    logger.error('scheduleLiveClass: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Enqueue Scheduled Deck Render ─────────────────────────
// After the professor's slide file lands in storage (one-off scheduling),
// kick a durable background job to render it. The professor can leave — the
// render survives on the queue (retried by the */5 sweep if the kick is lost).

export async function enqueueScheduledDeckRender(
  input: EnqueueScheduledDeckRenderInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = enqueueScheduledDeckRenderSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }
    const { roomId, deckId } = parsed.data

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }
    if (room.status !== 'scheduled') {
      return { error: 'This session is not scheduled' }
    }

    // The deck must belong to this room and have a server-authored source path.
    const { data: deck } = await adminDb
      .from('lc_decks')
      .select('id, source_file_path, deck_url')
      .eq('id', deckId)
      .eq('room_id', roomId)
      .maybeSingle()
    if (!deck || !deck.source_file_path) {
      return { error: 'Upload a slide file before preparing it' }
    }
    if (deck.deck_url) {
      return { success: true } // already rendered
    }

    // Background jobs are tenant-scoped; resolve the institution from the section.
    const { data: section } = await adminDb
      .from('course_sections')
      .select('institution_id')
      .eq('id', room.section_id)
      .single()
    if (!section) {
      return { error: 'Section not found' }
    }

    /* subjectKey = deckId, so the dedup subject is the DECK, not the section.
       Without it every deck in a section shared one key and the second upload's
       job collided with the first — a comment here previously claimed this type was
       "exempt from the active-unique index", but the index has no type carve-out,
       so it never was. That made the collision brief under the old pending-only
       index and permanent once it covered 'running' too (#630).

       This also replaces a best-effort SELECT-then-decide guard that used to sit
       above: the unique index now dedups a double-submit for the SAME deck
       atomically, which a read-then-write cannot (two clicks both read "none
       queued" and both insert). Same outcome reported to the caller. */
    const { alreadyActive } = await enqueueJob({
      type: 'render_scheduled_deck',
      params: { roomId, deckId },
      institutionId: section.institution_id,
      sectionId: room.section_id,
      subjectKey: deckId,
      createdBy: user.id,
    })
    if (alreadyActive) {
      return { success: true } // this deck is already queued or rendering
    }

    logEvent({
      userId: user.id,
      eventType: 'lc_room.scheduled_deck_render_enqueued',
      eventCategory: 'professor',
      metadata: { roomId, deckId },
      sectionId: room.section_id,
    })

    return { success: true }
  } catch (error) {
    logger.error('enqueueScheduledDeckRender: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Cancel Scheduled Session ──────────────────────────────
// Soft-ends a scheduled session (or the whole series). The status='scheduled'
// guard in the UPDATE means a sibling occurrence the professor already started
// is never clobbered. Any in-flight background render aborts on its own
// cancel-guard once the room flips to 'ended'.

export async function cancelScheduledSession(
  input: CancelScheduledSessionInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = cancelScheduledSessionSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }
    const { roomId, scope } = parsed.data

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }
    if (room.status !== 'scheduled') {
      return { error: 'Only scheduled sessions can be cancelled' }
    }

    let targetIds: string[] = [roomId]
    if (scope === 'series' && room.recurrence_group_id) {
      const { data: siblings } = await adminDb
        .from('lc_rooms')
        .select('id')
        .eq('recurrence_group_id', room.recurrence_group_id)
        .eq('prof_id', user.id)
        .eq('status', 'scheduled')
      targetIds = (siblings as Array<{ id: string }> | null)?.map((r) => r.id) ?? [roomId]
    }

    /* Guarded on status='scheduled' — never ends an already-started occurrence.
       `.select('id')` is load-bearing, not decoration: it returns the rows this
       statement ACTUALLY transitioned, which is what the storage cleanup below
       iterates. */
    const { data: cancelledRows, error: updateError } = await adminDb
      .from('lc_rooms')
      .update({ status: 'ended', ended_at: new Date().toISOString(), scheduled_at: null })
      .in('id', targetIds)
      .eq('status', 'scheduled')
      .select('id')
    if (updateError) {
      logger.error('cancelScheduledSession: update failed', updateError, { roomId, scope })
      return { error: 'Failed to cancel the session' }
    }
    const cancelledIds = (cancelledRows as Array<{ id: string }> | null)?.map((r) => r.id) ?? []

    /* Best-effort storage cleanup, over what was cancelled rather than over what
       we intended to cancel. targetIds is read before the UPDATE, so an
       occurrence can go scheduled -> live in between: the guard above correctly
       refuses to end it, and iterating targetIds here would still delete its
       folder — source PDF and every rendered page — out from under a class that
       is at that moment being presented. Deleting only the rows the UPDATE
       returned closes that window.

       Safe to delete at all (unlike the stale-room sweep, which must not):
       promoting a deck COPIES it into the course-materials bucket, so a
       promoted module item never points back here. Verified against prod: zero
       module_items resolve to an object in live-classroom-decks. */
    for (const id of cancelledIds) {
      try {
        await deleteStorageFolder(adminDb, LIVE_CLASSROOM_BUCKET, id)
      } catch (err) {
        logger.warn('cancelScheduledSession: storage cleanup failed (non-fatal)', { roomId: id, err: String(err) })
      }
    }

    logEvent({
      userId: user.id,
      eventType: 'lc_room.scheduled_cancelled',
      eventCategory: 'professor',
      // What was cancelled, not what was attempted — the guard above can skip an
      // occurrence that went live, and an audit trail that overstates it is worse
      // than no count at all.
      metadata: { roomId, scope, count: cancelledIds.length },
      sectionId: room.section_id,
    })

    revalidatePath(`/professor/courses/${room.section_id}/live-classroom`)
    // A cancelled session drops off the roadmap too (both views).
    revalidatePath(`/professor/courses/${room.section_id}/roadmap`)
    revalidatePath(`/student/courses/${room.section_id}/roadmap`)
    return { success: true }
  } catch (error) {
    logger.error('cancelScheduledSession: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Advance Slide ─────────────────────────────────────────

export async function advanceSlide(
  input: AdvanceSlideInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // Validate input
    const parsed = advanceSlideSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { roomId, slideIndex } = parsed.data

    // Verify room ownership
    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }

    // Check if room is still live
    if (room.status !== 'live') {
      return { error: 'Room has ended' }
    }

    // Validate slide index is in range
    if (room.deck_page_count !== null && slideIndex >= room.deck_page_count) {
      return { error: 'Slide index out of range' }
    }

    if (slideIndex < 0) {
      return { error: 'Slide index cannot be negative' }
    }

    // Update current slide
    const { error: updateError } = await adminDb
      .from('lc_rooms')
      .update({ current_slide: slideIndex })
      .eq('id', roomId)

    if (updateError) {
      logger.error('advanceSlide: Update failed', updateError, { roomId, slideIndex })
      return { error: 'Failed to advance slide' }
    }

    // Note: No logEvent here — would be too chatty
    // Note: No revalidatePath — Realtime handles client updates

    return { success: true }
  } catch (error) {
    logger.error('advanceSlide: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Set Screen Blank ──────────────────────────────────────
// Blank/unblank the projector (presenter-remote "."). Same shape as
// advanceSlide: ownership-verified update; the lc_rooms_after_update
// trigger broadcasts screen_blank_changed to the room topic.

export async function setScreenBlank(
  input: SetScreenBlankInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = setScreenBlankSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { roomId, isBlanked } = parsed.data

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }

    if (room.status !== 'live') {
      return { error: 'Room has ended' }
    }

    const { error: updateError } = await adminDb
      .from('lc_rooms')
      .update({ is_blanked: isBlanked })
      .eq('id', roomId)

    if (updateError) {
      logger.error('setScreenBlank: Update failed', updateError, { roomId, isBlanked })
      return { error: 'Failed to update the projector screen' }
    }

    // Note: No logEvent (chatty, like advanceSlide) — no revalidatePath (realtime).

    return { success: true }
  } catch (error) {
    logger.error('setScreenBlank: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: End Room ──────────────────────────────────────────────

export async function endRoom(
  input: EndRoomInput,
): Promise<{ success?: boolean; error?: string; unsharedUploads?: number }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // Validate input
    const parsed = endRoomSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { roomId } = parsed.data

    // Verify room ownership
    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }

    // Check if room is still live
    if (room.status !== 'live') {
      return { error: 'Room has already ended' }
    }

    // Mark room as ended
    const { error: updateError } = await adminDb
      .from('lc_rooms')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', roomId)

    if (updateError) {
      logger.error('endRoom: Update failed', updateError, { roomId })
      return { error: 'Failed to end room' }
    }

    // Retention: deck images are deliberately NOT deleted on room end — Class
    // Insights (post-class report + study materials) is generated from this
    // session's data, and the student quiz review links back to slide images.
    // A TTL/cleanup job for old decks is a tracked follow-up. (Stale-room
    // cleanup on the next room start still prunes orphaned uploads.)

    // Kick off Class Insights generation (professor report + student study
    // pack). Fire-and-forget — if the kick fails, the lazy-on-view fallback /
    // GHA sweep regenerates it, so a failed kick never fails ending the class.
    await triggerClassInsights(roomId)

    // Recording finalize is NOT kicked here: it is client-stop-driven (stop()
    // finalizes each session row THEN kicks concat, so durations are accurate),
    // with a lazy-on-view backstop in getRecording if the kick was lost.

    // Log event
    logEvent({
      userId: user.id,
      eventType: 'lc_room.ended',
      eventCategory: 'professor',
      metadata: { roomId },
      sectionId: room.section_id,
    })

    revalidatePath(`/professor/courses/${room.section_id}/live-classroom`)

    /* Decks uploaded into this room become course material, but NOT student-visible
       until the professor says so (promoteUploadedDeckToModuleMaterial inserts
       is_visible: false). Report how many are waiting so the presenter can offer
       "share today's deck with the class?" at the one moment it is obviously
       relevant — the end of the class. Best-effort: a failed count must not fail
       ending the class. */
    const unsharedUploads = await countUnsharedRoomUploads(adminDb, roomId)
    return { success: true, unsharedUploads }
  } catch (error) {
    logger.error('endRoom: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * module_items promoted from THIS room's decks, in a given visibility state.
 * `{ visible: false }` = still unshared (what the end-of-class prompt counts and
 * shares); `{ visible: true }` = already shared (what Undo takes back).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function roomUploadIds(adminDb: any, roomId: string, opts: { visible: boolean }): Promise<string[]> {
  const { data: decks } = await adminDb
    .from('lc_decks')
    .select('module_item_id')
    .eq('room_id', roomId)
    .not('module_item_id', 'is', null)
  const ids = ((decks ?? []) as { module_item_id: string | null }[])
    .map((d) => d.module_item_id)
    .filter((id): id is string => !!id)
  if (!ids.length) return []

  /* Only the ones this room actually PROMOTED. A deck picked from an existing
     module also carries module_item_id, and that item is the professor's own
     published material — sharing (or counting) it here would be wrong. The
     promoted ones are stamped content.liveClassroom.deckId. */
  const { data: items } = await adminDb
    .from('module_items')
    .select('id, content')
    .in('id', ids)
    .eq('is_visible', opts.visible)
  return ((items ?? []) as { id: string; content: unknown }[])
    .filter((it) => {
      const c = (it.content ?? {}) as { liveClassroom?: { roomId?: string } }
      return c.liveClassroom?.roomId === roomId
    })
    .map((it) => it.id)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function countUnsharedRoomUploads(adminDb: any, roomId: string): Promise<number> {
  try {
    return (await roomUploadIds(adminDb, roomId, { visible: false })).length
  } catch (error) {
    logger.error('countUnsharedRoomUploads', error, { roomId })
    return 0
  }
}

// ── Action: Share this room's uploaded decks with the class ───────
//
// The consent step for promoteUploadedDeckToModuleMaterial. A deck uploaded to
// project in class is registered as course material but hidden; this is the
// professor saying "yes, students may have it". Offered when the class ends, and
// available afterwards from the roadmap card (which draws an unshared upload faded
// with an eye-off, so it is never mistaken for published).

export async function shareRoomUploads(
  roomId: string,
  /** `false` un-shares — the Undo behind the success toast. Sharing changes what
   *  students can see, so it needs a one-click way back; `is_visible` is trivially
   *  reversible, and the same ownership + provenance gate applies either way. */
  share = true,
): Promise<{ success?: boolean; error?: string; shared?: number }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    if (!UUID_RE.test(roomId)) return { error: 'Invalid room' }

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) return { error: 'Room not found or you do not own this room' }

    const ids = await roomUploadIds(adminDb, roomId, { visible: !share })
    if (!ids.length) return { success: true, shared: 0 }

    const { error: updateError } = await adminDb
      .from('module_items')
      .update({ is_visible: share })
      .in('id', ids)
      // Re-assert the gate: only ever flip rows still in the state we read.
      .eq('is_visible', !share)
    if (updateError) {
      logger.error('shareRoomUploads: update failed', updateError, { roomId, share })
      return { error: share ? 'Could not share the slides' : 'Could not undo that' }
    }

    await logEvent({
      userId: user.id,
      eventType: share ? 'lc_room.uploads_shared' : 'lc_room.uploads_unshared',
      eventCategory: 'professor',
      sectionId: room.section_id,
      metadata: { roomId, moduleItemIds: ids },
    })

    revalidatePath(`/professor/courses/${room.section_id}/modules`)
    revalidatePath(`/professor/courses/${room.section_id}/roadmap`)
    revalidatePath(`/student/courses/${room.section_id}/modules`)
    revalidatePath(`/student/courses/${room.section_id}/roadmap`)
    return { success: true, shared: ids.length }
  } catch (error) {
    logger.error('shareRoomUploads: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Start Live Class ──────────────────────────────────────
// Commits the pre-class setup step: saves the session name + "Catch me up"
// toggle, activates the chosen (already-rendered) deck on the room, and flips
// setup_completed. Activating the deck (setting deck_url) fires the deck_ready
// trigger, which is the moment students/projector load the slides — so nothing
// is shown to them until the professor explicitly starts the class.

export async function startLiveClass(
  input: StartLiveClassInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = startLiveClassSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }
    const { roomId, deckId, name, lectureSummaryEnabled } = parsed.data

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }
    // Start-now rooms are born 'live'; scheduled rooms flip 'scheduled' → 'live'
    // on this click (the attended start gate). Only an ended room is off-limits.
    if (room.status !== 'live' && room.status !== 'scheduled') {
      return { error: 'This class has already ended' }
    }

    // The chosen deck must belong to THIS room and be fully rendered. Binding
    // the client-supplied deckId to the room here prevents activating another
    // room's deck (IDOR).
    const { data: deck } = await adminDb
      .from('lc_decks')
      .select('id, deck_url, page_count')
      .eq('id', deckId)
      .eq('room_id', roomId)
      .maybeSingle()
    if (!deck || !deck.deck_url || deck.page_count == null) {
      return { error: 'Add slides before starting the class' }
    }

    // Persist the trimmed name, or null when blank — the UI renders a standard
    // "Class — <date>" fallback for unnamed sessions, so we don't synthesize a
    // name here (keeps the fallback consistent with older, unnamed rooms).
    const trimmed = (name ?? '').trim()

    // Activate the deck + persist config + complete setup in one update. The
    // setup_completed=false guard makes a double-clicked "Start class" activate
    // exactly once (concurrent second call updates 0 rows — still a success).
    // Guard on setup_completed=false (double-click idempotency) AND status IN
    // ('scheduled','live') so a start racing a cancel can't resurrect an already
    // -ended room. .select() returns the affected rows so we can tell a real
    // start from a no-op.
    const { data: updatedRooms, error: updateError } = await adminDb
      .from('lc_rooms')
      .update({
        name: trimmed.length > 0 ? trimmed : null,
        lecture_summary_enabled: lectureSummaryEnabled,
        setup_completed: true,
        // The real "class started" instant: setup is committed, the deck is
        // activated, students are about to be notified. created_at is when the
        // room shell was opened (often many minutes earlier, while the deck
        // uploaded), so attendance measures late joins from this instead (#186).
        // The setup_completed=false guard below makes this write once — a
        // double-clicked start can't push the baseline later.
        started_at: new Date().toISOString(),
        status: 'live', // scheduled → live (no-op for start-now rooms)
        scheduled_at: null, // clear the schedule marker once started
        active_deck_id: deck.id,
        deck_url: deck.deck_url,
        deck_page_count: deck.page_count,
        current_slide: 0,
      })
      .eq('id', roomId)
      .eq('setup_completed', false)
      .in('status', ['scheduled', 'live'])
      .select('id')

    if (updateError) {
      logger.error('startLiveClass: update failed', updateError, { roomId })
      return { error: 'Failed to start the class' }
    }

    // 0 rows = a concurrent start already flipped it, or the session was
    // cancelled between the ownership read and this write. Nothing more to do —
    // and we must NOT notify students of a class that isn't live.
    if (!updatedRooms || updatedRooms.length === 0) {
      return { success: true }
    }

    /* Minting can fail; starting the class cannot. The update above has already committed,
       so students are being notified of a live class no matter what happens here. Anything
       thrown is logged and swallowed, and markAttendance then finds no code row and falls
       back to marking attendance without one — a class with weaker attendance checking, not
       a class that failed to start. */
    try {
      /* Mint the attendance code (#82). Here rather than at room creation, so a code is only
         taken while a class is actually running and a draft nobody starts never holds one.
         Reached only when THIS call won the update above, so a double-clicked start does not
         mint twice.

         The retry loop is the uniqueness mechanism, not a safety net: idx_lc_room_codes_code
         makes two live classes sharing a code impossible, so a collision surfaces as a
         unique-violation (23505) and we roll again. `on conflict (room_id) do nothing` means a
         23505 that does reach us is always a CODE collision, never this room already having
         one. */
      let minted = false
      for (let attempt = 0; attempt < JOIN_CODE_MAX_ATTEMPTS; attempt++) {
        const { error: codeError } = await adminDb
          .from('lc_room_codes')
          .upsert(
            { room_id: roomId, code: generateJoinCode() },
            { onConflict: 'room_id', ignoreDuplicates: true },
          )
        if (!codeError) {
          minted = true
          break
        }
        if ((codeError as { code?: string }).code !== '23505') {
          // Not a collision. The class is already live and students are about to be notified,
          // so this is logged and swallowed: markAttendance falls back to marking attendance
          // without a code rather than locking a running class out of its own roster.
          logger.error('startLiveClass: could not mint join code', codeError, { roomId })
          break
        }
        logger.warn('startLiveClass: join code collided, retrying', { roomId, attempt })
      }
      if (!minted) {
        /* Attendance has quietly reverted to the old open behaviour for this class. Nothing
           on screen says so, so it has to be loud in the logs — a warn per attempt is easy to
           read as noise. */
        logger.error(
          'startLiveClass: no join code minted, attendance is ungated for this class',
          null,
          { roomId },
        )
      }
    } catch (codeError) {
      logger.error('startLiveClass: could not mint join code', codeError, { roomId })
    }


    logEvent({
      userId: user.id,
      eventType: 'lc_room.setup_completed',
      eventCategory: 'professor',
      metadata: { roomId, deckId: deck.id, lectureSummaryEnabled },
      sectionId: room.section_id,
    })

    // Class is now live in front of students — notify enrolled students with a
    // time-sensitive "join now" notice (not a to-do). Dedup keyed on the room id,
    // so a double-clicked start won't stack notifications.
    await emitEvent({
      type: 'classroom_started',
      sectionId: room.section_id,
      actorId: user.id,
      entity: { type: 'classroom', id: roomId },
      title: 'Live class has started',
      body: 'Your professor is live now — join to participate.',
      linkUrl: `/student/courses/${room.section_id}/live-classroom/${roomId}`,
    })

    revalidatePath(`/professor/courses/${room.section_id}/live-classroom`)
    return { success: true }
  } catch (error) {
    logger.error('startLiveClass: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Create Deck Upload URL ────────────────────────────────
// Mints a short-lived signed Supabase Storage URL the browser can PUT
// the source PDF to directly. Bypasses Cloud Run's 32 MiB GFE request
// cap that bites multipart uploads of large lecture decks.

export async function createDeckUploadUrl(
  input: CreateDeckUploadUrlInput,
): Promise<
  | { deckId: string; signedUrl: string; token: string; path: string; error?: undefined }
  | { error: string; deckId?: undefined; signedUrl?: undefined; token?: undefined; path?: undefined }
> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createDeckUploadUrlSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { roomId, extension, title } = parsed.data

    if (extension !== 'pdf' && !isPptxEnabled()) {
      return { error: 'PowerPoint upload is not available right now. Please upload a PDF.' }
    }

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }

    // Scheduled rooms may accept uploads too — slides are pre-rendered before
    // the class goes live. Only an ended room is off-limits.
    if (room.status !== 'live' && room.status !== 'scheduled') {
      return { error: 'Room has ended' }
    }

    // Create the deck row first so the source + render paths are deck-scoped
    // ({roomId}/{deckId}/…) and decks never overwrite each other. source_file_path
    // is the server-authored render source the render core derives from.
    const { data: deck, error: deckError } = await adminDb
      .from('lc_decks')
      .insert({ room_id: roomId, position: await nextDeckPosition(adminDb, roomId), title: title ?? null })
      .select('id')
      .single()

    if (deckError || !deck) {
      logger.error('createDeckUploadUrl: deck insert failed', deckError, { roomId })
      return { error: 'Failed to prepare upload' }
    }

    const path = `${roomId}/${deck.id}/source.${extension}`
    const { data, error } = await adminDb.storage
      .from(LIVE_CLASSROOM_BUCKET)
      .createSignedUploadUrl(path, { upsert: true })

    if (error || !data) {
      logger.error('createDeckUploadUrl: signed URL mint failed', error, { roomId, deckId: deck.id })
      return { error: 'Failed to prepare upload' }
    }

    // Record the render source path (deck-scoped) so the render core can derive
    // it server-side — never trusting a client-supplied path.
    await adminDb.from('lc_decks').update({ source_file_path: path }).eq('id', deck.id)

    return { deckId: deck.id, signedUrl: data.signedUrl, token: data.token, path: data.path }
  } catch (error) {
    logger.error('createDeckUploadUrl: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Get Deck Upload Config ───────────────────────────────
// Capability flag for the upload dialog: is PowerPoint upload available
// (i.e. the Gotenberg converter is wired up)? When false, the UI hides
// PPTX affordances and PDF-only behavior is unchanged. Returns only a
// non-sensitive feature flag, so no auth gate is required.

export async function getDeckUploadConfig(): Promise<{ pptxEnabled: boolean }> {
  return { pptxEnabled: isPptxEnabled() }
}

// ── Action: Get Module Deck Items ────────────────────────────────
// Returns PDF (and, when the converter is enabled, PowerPoint) lecture
// items from the section's published modules for the "Pick from Modules"
// picker in the live classroom upload dialog.

export interface ModuleDeckItem {
  id: string
  title: string
  moduleName: string
  fileName: string
  fileSize: string
  fileType: 'pdf' | 'ppt'
}

export async function getModuleDeckItems(
  sectionId: string,
): Promise<{ items: ModuleDeckItem[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { items: [], error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { items: [], error: 'You do not have access to this section' }
    if (!canWriteAsProfessor(access.role)) {
      return { items: [], error: 'Only professors can access this' }
    }

    const adminDb = access.adminDb

    const { data: modules, error: modError } = await adminDb
      .from('modules')
      .select('id, title')
      .eq('section_id', sectionId)
      .eq('is_published', true)
      .order('position', { ascending: true })

    if (modError || !modules || modules.length === 0) {
      return { items: [] }
    }

    const moduleIds = modules.map((m: { id: string }) => m.id)
    const moduleNameById = new Map<string, string>(
      modules.map((m: { id: string; title: string }) => [m.id, m.title]),
    )

    const { data: items, error: itemError } = await adminDb
      .from('module_items')
      .select('id, module_id, title, content')
      .in('module_id', moduleIds)
      .eq('item_type', 'lecture')
      .eq('is_visible', true)
      .order('position', { ascending: true })

    if (itemError || !items) {
      return { items: [] }
    }

    // PowerPoint items are only offered when the converter is wired up —
    // otherwise picking one would fail at render time.
    const allowPptx = isPptxEnabled()

    const deckItems: ModuleDeckItem[] = []
    for (const item of items as Array<{
      id: string
      module_id: string
      title: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: any
    }>) {
      const content = item.content
      const isPdf = content?.fileType === 'pdf'
      const isPpt = content?.fileType === 'ppt'
      if (
        (isPdf || (isPpt && allowPptx)) &&
        typeof content?.filePath === 'string' &&
        content.filePath.length > 0
      ) {
        deckItems.push({
          id: item.id,
          title: item.title || content.fileName || 'Untitled',
          moduleName: moduleNameById.get(item.module_id) || 'Unknown Module',
          fileName: content.fileName || (isPpt ? 'presentation.pptx' : 'document.pdf'),
          fileSize: content.fileSize || '',
          fileType: isPpt ? 'ppt' : 'pdf',
        })
      }
    }

    return { items: deckItems }
  } catch (error) {
    logger.error('getModuleDeckItems: Unexpected error', error)
    return { items: [], error: 'An unexpected error occurred' }
  }
}

// ── Action: Use Module Item As Deck ──────────────────────────────
// Copies a PDF or PowerPoint lecture from course-materials to
// live-classroom-decks so the existing render pipeline works unchanged
// (PPT/PPTX is converted to PDF by the render route). Sets module_item_id
// and source_file_path on the room for future feature traceability.

export async function applyModuleItemAsDeck(
  input: ApplyModuleItemAsDeckInput,
): Promise<{ deckId?: string; path?: string; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = applyModuleItemAsDeckSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { roomId, moduleItemId } = parsed.data

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }

    if (room.status !== 'live' && room.status !== 'scheduled') {
      return { error: 'Room has ended' }
    }

    // Fetch the module item
    const { data: item, error: itemError } = await adminDb
      .from('module_items')
      .select('id, module_id, item_type, title, content')
      .eq('id', moduleItemId)
      .single()

    if (itemError || !item) {
      return { error: 'Module item not found' }
    }

    if (item.item_type !== 'lecture') {
      return { error: 'Only lecture items can be used as a deck' }
    }

    const content = item.content as { fileType?: string; filePath?: string; fileName?: string } | null
    const isPdf = content?.fileType === 'pdf'
    const isPpt = content?.fileType === 'ppt'
    if (!content?.filePath || (!isPdf && !isPpt)) {
      return { error: 'This item does not contain a PDF or PowerPoint file' }
    }
    if (isPpt && !isPptxEnabled()) {
      return { error: 'PowerPoint conversion is not available right now. Use a PDF lecture instead.' }
    }

    // Derive the source extension. PPT items store fileType 'ppt' regardless
    // of whether the actual file is .ppt or .pptx, so sniff the real ext from
    // the filename (default to .pptx — the common case).
    const sourceExt: 'pdf' | 'pptx' | 'ppt' = isPdf
      ? 'pdf'
      : content.fileName?.toLowerCase().endsWith('.ppt')
        ? 'ppt'
        : 'pptx'
    const sourceContentType =
      sourceExt === 'pdf'
        ? 'application/pdf'
        : sourceExt === 'ppt'
          ? 'application/vnd.ms-powerpoint'
          : 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

    // Cross-section guard: module must belong to the same section as the room
    const { data: mod, error: modError } = await adminDb
      .from('modules')
      .select('id, section_id')
      .eq('id', item.module_id)
      .single()

    if (modError || !mod) {
      return { error: 'Parent module not found' }
    }

    if (mod.section_id !== room.section_id) {
      return { error: 'Module item does not belong to this course section' }
    }

    // Copy file from course-materials to live-classroom-decks
    const { data: blob, error: downloadError } = await adminDb.storage
      .from(COURSE_MATERIALS_BUCKET)
      .download(content.filePath)

    if (downloadError || !blob) {
      logger.error('applyModuleItemAsDeck: Download failed', downloadError, {
        roomId,
        moduleItemId,
        filePath: content.filePath,
      })
      return {
        error:
          'Source file not found in course materials. The file may have been deleted from storage.',
      }
    }

    const arrayBuffer = await blob.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // Snapshot the module item's extraction onto the deck so quiz/summary
    // generation has a single source of truth without chasing FK chains.
    const fullContent = item.content as Record<string, unknown> | null
    const extraction = fullContent?.extraction as Record<string, unknown> | undefined
    const deckExtraction =
      extraction && (extraction.status === 'completed' || extraction.status === 'partial')
        ? extraction
        : null

    // Create the deck row first (deck-scoped storage path; per-deck extraction).
    const deckTitle =
      (item.title as string | undefined) || content.fileName || 'Module deck'
    const { data: deck, error: deckError } = await adminDb
      .from('lc_decks')
      .insert({
        room_id: roomId,
        position: await nextDeckPosition(adminDb, roomId),
        title: deckTitle,
        module_item_id: moduleItemId,
        // source_file_path is set to the decks-bucket render source below (after
        // the file is copied there) — the render core derives from it.
        extraction: deckExtraction,
      })
      .select('id')
      .single()

    if (deckError || !deck) {
      logger.error('applyModuleItemAsDeck: deck insert failed', deckError, { roomId, moduleItemId })
      return { error: 'Failed to prepare deck for live classroom' }
    }

    const targetPath = `${roomId}/${deck.id}/source.${sourceExt}`
    const { error: uploadError } = await adminDb.storage
      .from(LIVE_CLASSROOM_BUCKET)
      .upload(targetPath, buffer, {
        contentType: sourceContentType,
        upsert: true,
      })

    if (uploadError) {
      logger.error('applyModuleItemAsDeck: Upload failed', uploadError, { roomId, targetPath })
      // Roll back the deck row so a failed upload doesn't leave a ghost
      // "Preparing…" deck in the switcher.
      await adminDb.from('lc_decks').delete().eq('id', deck.id)
      return { error: 'Failed to prepare deck for live classroom' }
    }

    // Picking a deck FROM A MODULE is the professor's module choice — pin the
    // session under that module on the roadmap (the concrete equivalent of the
    // quiz/assignment setup spotlight; no popup needed here). Idempotent:
    // re-picking from another module just moves it. Best-effort — a failure
    // never blocks the deck.
    const placed = await writePlacementEdge(adminDb, room.section_id, 'live_session', roomId, mod.id)
    if (placed) {
      revalidatePath(`/professor/courses/${room.section_id}/roadmap`)
      revalidatePath(`/student/courses/${room.section_id}/roadmap`)
    }
    // Record the render source (decks-bucket copy) so the render core derives
    // the path server-side. Traceability to the module item is kept via
    // module_item_id above.
    await adminDb.from('lc_decks').update({ source_file_path: targetPath }).eq('id', deck.id)

    logEvent({
      userId: user.id,
      eventType: 'lc_room.deck_from_module',
      eventCategory: 'professor',
      metadata: { roomId, deckId: deck.id, moduleItemId, moduleId: mod.id, filePath: content.filePath },
      sectionId: room.section_id,
    })

    return { deckId: deck.id, path: targetPath }
  } catch (error) {
    logger.error('applyModuleItemAsDeck: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Switch Deck ──────────────────────────────────────────
// Make a previously-added deck the active one and resume it where it was
// left. Copies the deck's url/page_count/current_slide onto lc_rooms in a
// single UPDATE — which fires deck_ready (clients re-snapshot) + slide_changed
// (clients jump to the resumed slide). The mirror trigger is skipped because
// active_deck_id changes, so it can't clobber the target's saved slide.

export async function switchDeck(
  input: SwitchDeckInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = switchDeckSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { roomId, deckId } = parsed.data

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }
    if (room.status !== 'live') {
      return { error: 'Room has ended' }
    }

    const { data: deck } = await adminDb
      .from('lc_decks')
      .select('id, room_id, deck_url, page_count, current_slide')
      .eq('id', deckId)
      .eq('room_id', roomId)
      .maybeSingle()

    if (!deck) return { error: 'Deck not found' }
    if (!deck.deck_url) return { error: 'That deck is still preparing — try again in a moment' }

    const { error: updateError } = await adminDb
      .from('lc_rooms')
      .update({
        active_deck_id: deck.id,
        deck_url: deck.deck_url,
        deck_page_count: deck.page_count,
        current_slide: deck.current_slide,
      })
      .eq('id', roomId)

    if (updateError) {
      logger.error('switchDeck: update failed', updateError, { roomId, deckId })
      return { error: 'Failed to switch deck' }
    }

    logEvent({
      userId: user.id,
      eventType: 'lc_room.deck_switched',
      eventCategory: 'professor',
      metadata: { roomId, deckId },
      sectionId: room.section_id,
    })

    return { success: true }
  } catch (error) {
    logger.error('switchDeck: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Remove Deck ──────────────────────────────────────────
// Delete a deck from the room (e.g. an accidental wrong upload). Its
// transcriptions + annotations cascade away (deck_id FK ON DELETE
// CASCADE); its rendered images are best-effort removed from storage.
// If the removed deck was active, fall back to the most recent remaining
// rendered deck; if none remain, clear the room's deck mirror so the
// presenter returns to the upload screen. Clients re-snapshot via a
// deck_ready broadcast (the re-activation update fires it on its own;
// the non-active / cleared paths broadcast manually since a NULL deck_url
// doesn't trip the lc_rooms trigger).

export async function removeDeck(
  input: RemoveDeckInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = removeDeckSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { roomId, deckId } = parsed.data

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }
    if (room.status !== 'live') {
      return { error: 'Room has ended' }
    }

    // Deck must belong to this room.
    const { data: deck } = await adminDb
      .from('lc_decks')
      .select('id')
      .eq('id', deckId)
      .eq('room_id', roomId)
      .maybeSingle()
    if (!deck) return { error: 'Deck not found' }

    const wasActive = room.active_deck_id === deckId

    // Order matters (fixes a re-render race): DELETE the deck row FIRST, THEN
    // repoint lc_rooms, THEN best-effort storage cleanup LAST. The FK
    // lc_rooms.active_deck_id → lc_decks is ON DELETE SET NULL, so deleting the
    // active deck clears the pointer inside the same statement (it can never
    // dangle) — and because that FK action leaves deck_url UNCHANGED, the delete
    // fires NO deck_ready. Any re-snapshot we trigger below therefore reads a DB
    // with the row already gone. (Repointing first, as before, broadcast
    // deck_ready via the deck_url-change trigger BEFORE the delete, so clients
    // re-snapshotted a still-present deck and the switcher kept showing a phantom
    // deck as active until a manual reload.)
    const { error: deleteError } = await adminDb.from('lc_decks').delete().eq('id', deckId)
    if (deleteError) {
      logger.error('removeDeck: delete failed', deleteError, { roomId, deckId })
      return { error: 'Failed to remove deck' }
    }

    // The deck delete just cascaded this deck's lc_transcriptions rows — the
    // source of truth behind any transcript vectors (N1). Erase those too, in
    // the same action that erased the rows (vector-db rule 10: delete paths
    // live with write paths). Best-effort: a live room usually has no vectors
    // yet (embedding runs at session end), and a stale vector is inert anyway —
    // hydration finds no row and drops it — so a failure here degrades, never
    // blocks the removal.
    try {
      const { data: sectionRow } = await adminDb
        .from('course_sections')
        .select('institution_id')
        .eq('id', room.section_id)
        .single()
      if (sectionRow?.institution_id) {
        await deleteTranscriptVectors(
          { institutionId: sectionRow.institution_id, sectionId: room.section_id },
          roomId,
          { deckId },
        )
      }
    } catch (vectorError) {
      logger.warn('removeDeck: transcript vector cleanup failed', {
        source: 'liveClassroom.removeDeck',
        roomId,
        deckId,
        message: vectorError instanceof Error ? vectorError.message : String(vectorError),
      })
    }

    let reactivationFiredEvent = false
    // The active-deck pointer the clients should re-snapshot to. Unchanged for
    // a background removal; the fallback (or null) when the active one goes.
    let activeUrl: string | null = room.deck_url
    let activePageCount: number | null = room.deck_page_count

    if (wasActive) {
      // Fall back to the most recent remaining rendered deck. The removed row is
      // already deleted, so no id-exclusion filter is needed.
      const { data: remaining } = await adminDb
        .from('lc_decks')
        .select('id, deck_url, page_count, current_slide')
        .eq('room_id', roomId)
        .not('deck_url', 'is', null)
        .order('position', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (remaining) {
        await adminDb
          .from('lc_rooms')
          .update({
            active_deck_id: remaining.id,
            deck_url: remaining.deck_url,
            deck_page_count: remaining.page_count,
            current_slide: remaining.current_slide,
          })
          .eq('id', roomId)
        reactivationFiredEvent = true // deck_url change trips the deck_ready trigger (now a consistent post-delete read)
        activeUrl = remaining.deck_url
        activePageCount = remaining.page_count
      } else {
        // No decks left — reset to the no-deck state (upload screen). The FK
        // already set active_deck_id NULL on delete; clear the rest of the mirror.
        await adminDb
          .from('lc_rooms')
          .update({ active_deck_id: null, deck_url: null, deck_page_count: null, current_slide: 0 })
          .eq('id', roomId)
        activeUrl = null
        activePageCount = null
      }
    }

    // A background removal (room unchanged) and the cleared-to-empty case don't
    // trip the deck_ready trigger (no non-null deck_url change), so nudge
    // clients to re-snapshot the deck list. Send the REAL current active-deck
    // pointer so the payload never falsely implies the live deck went away.
    // persist=true is REQUIRED: the client spoof filter drops seq=null events on
    // the authoritative topic unless they're in NULL_SEQ_AUTHORITATIVE_TYPES, and
    // deck_ready is not (it normally carries a seq from the DB trigger). A
    // non-persisted broadcast here was silently dropped, so a non-active deck
    // lingered in the switcher until reload. Persisting assigns a seq so it
    // survives — and keeps deck_ready always seq'd, like the trigger's.
    if (!reactivationFiredEvent) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adminDb as any).rpc('lc_send_event', {
          p_room_id: roomId,
          p_event_type: 'deck_ready',
          p_data: { deckUrl: activeUrl, deckPageCount: activePageCount },
          p_persist: true,
          p_broadcast: true,
        })
      } catch (broadcastError) {
        logger.warn('removeDeck: re-snapshot broadcast failed', { roomId, error: String(broadcastError) })
      }
    }

    // Best-effort storage cleanup LAST — DB state is already consistent.
    try {
      await deleteStorageFolder(adminDb, LIVE_CLASSROOM_BUCKET, `${roomId}/${deckId}`)
    } catch (storageError) {
      logger.error('removeDeck: storage cleanup failed', storageError, { roomId, deckId })
    }

    logEvent({
      userId: user.id,
      eventType: 'lc_room.deck_removed',
      eventCategory: 'professor',
      metadata: { roomId, deckId, wasActive },
      sectionId: room.section_id,
    })

    return { success: true }
  } catch (error) {
    logger.error('removeDeck: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Append Transcription ─────────────────────────────────
// Atomically appends transcribed text to a page's transcript row.
// Called by the client-side useTranscription hook after debouncing
// committed ElevenLabs Scribe v2 transcript chunks (5-second batches).

export async function appendTranscription(
  input: AppendTranscriptionInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = appendTranscriptionSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { roomId, deckId, pageNumber, text } = parsed.data

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }

    if (room.status !== 'live') {
      return { error: 'Room has ended' }
    }

    // Bind to a deck of this room. Accept a now-inactive deck so a chunk
    // captured on deck A but flushed just after a switch to B still lands on A.
    if (!(await deckBelongsToRoom(adminDb, deckId, roomId))) {
      return { error: 'Deck not found' }
    }

    // Strip HTML tags as defense-in-depth (text originates from ElevenLabs
    // but is relayed through the client)
    const sanitized = text.replace(/<[^>]*>/g, '').trim()
    if (!sanitized) return { success: true }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: rpcError } = await (adminDb as any).rpc('lc_append_transcription', {
      p_room_id: roomId,
      p_deck_id: deckId,
      p_page_number: pageNumber,
      p_text: sanitized,
    })

    if (rpcError) {
      logger.error('appendTranscription: RPC failed', rpcError, { roomId, deckId, pageNumber })
      return { error: 'Failed to save transcription' }
    }

    return { success: true }
  } catch (error) {
    logger.error('appendTranscription: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Get Room Transcriptions ──────────────────────────────
// Returns all transcription rows for a room, used by quiz generation
// and the transcription panel on page reload.

export async function getRoomTranscriptions(
  roomId: string,
  deckId?: string,
): Promise<{ data?: Array<{ page_number: number; text: string }>; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = roomIdSchema.safeParse(roomId)
    if (!parsed.success) return { error: 'Invalid room ID' }

    const { ok, room, adminDb } = await verifyRoomOwnership(parsed.data, user.id)
    if (!ok || !room) return { error: 'Room not found or you do not own this room' }

    // Scope to a deck: the given one, else the room's active deck. Transcripts
    // are per-deck now, so without this two decks' pages would interleave.
    const targetDeckId = deckId ?? (room.active_deck_id as string | null)
    if (!targetDeckId) return { data: [] }

    const { data, error } = await adminDb
      .from('lc_transcriptions')
      .select('page_number, text')
      .eq('deck_id', targetDeckId)
      .order('page_number', { ascending: true })

    if (error) {
      logger.error('getRoomTranscriptions: Query failed', error, { roomId: parsed.data, deckId: targetDeckId })
      return { error: 'Failed to load transcriptions' }
    }

    return { data: (data ?? []) as Array<{ page_number: number; text: string }> }
  } catch (error) {
    logger.error('getRoomTranscriptions: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Generate and Push Live Quiz ──────────────────────────
// One-click AI quiz: gathers transcription + deck extraction for all
// covered slides, sends to Gemini Flash, and pushes the generated
// quiz directly to students via lc_interactions.

// ── Action: topic options for the manual quiz composer ───────────
// Returns this room's section's tracked subtopics so the professor can tag a
// manual live quiz's question — the same topic→mastery link AI quizzes get.
// IDOR-safe: only the owning professor of the room can read them.
export async function getRoomTopicOptions(
  roomId: string,
): Promise<{ topics?: Array<{ id: string; name: string }>; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) return { error: 'Room not found or you do not own this room' }

    const { data } = await adminDb
      .from('skills')
      .select('id, name, parent_id, excluded, position')
      .eq('section_id', room.section_id)
      .eq('excluded', false)
      .order('position', { ascending: true })

    // Leaf topics only — mastery is scored at the leaf (a childless top-level
    // topic is its own leaf; "not a parent" can't be expressed in one SQL filter).
    const leaves = selectLeafSkills(
      (data ?? []) as Array<{ id: string; name: string; parent_id: string | null; excluded: boolean }>,
    )
    const topics = leaves.map((t) => ({ id: t.id, name: t.name }))
    return { topics }
  } catch (error) {
    logger.error('getRoomTopicOptions: unexpected', error, { roomId })
    return { error: 'Failed to load topics' }
  }
}

export async function generateAndPushLiveQuiz(
  input: GenerateLiveQuizInput,
): Promise<{ interactionId?: string; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = generateLiveQuizSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { roomId, timeLimitSeconds, revealAnswers } = parsed.data

    const { ok, room, adminDb } = await verifyRoomOwnership(roomId, user.id)
    if (!ok || !room) {
      return { error: 'Room not found or you do not own this room' }
    }

    if (room.status !== 'live') {
      return { error: 'Room has ended' }
    }

    // Institution/platform AI kill switch.
    const aiVerdict = await checkAiFeatureBySection(adminDb, room.section_id, 'live-classroom-ai')
    if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

    // Guard: no concurrent open quizzes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: openQuizzes } = await (adminDb as any)
      .from('lc_interactions')
      .select('id')
      .eq('room_id', roomId)
      .eq('kind', 'quiz')
      .in('status', ['draft', 'open'])
      .limit(1)

    if (openQuizzes && openQuizzes.length > 0) {
      return { error: 'Close the current quiz before generating a new one' }
    }

    // Quiz covers the ACTIVE deck (extraction + transcript are per-deck now).
    const activeDeckId = room.active_deck_id as string | null
    if (!activeDeckId) {
      return { error: 'No active deck yet. Upload a deck before generating a quiz.' }
    }

    const { data: activeDeck } = await adminDb
      .from('lc_decks')
      .select('extraction')
      .eq('id', activeDeckId)
      .maybeSingle()

    // Fetch transcriptions for the active deck
    const { data: transcriptions, error: txError } = await adminDb
      .from('lc_transcriptions')
      .select('page_number, text')
      .eq('deck_id', activeDeckId)
      .order('page_number', { ascending: true })

    if (txError) {
      logger.error('generateAndPushLiveQuiz: transcription fetch failed', txError, { roomId })
      return { error: 'Failed to load transcriptions' }
    }

    const txRows = (transcriptions ?? []) as Array<{ page_number: number; text: string }>

    if (txRows.length === 0) {
      return { error: 'No transcription data yet. Start transcribing before generating a quiz.' }
    }

    // Assemble per-slide context (slide text + transcription, truncated)
    const { slideContent, transcriptionContent, slidesCovered } = buildLectureContext(
      (activeDeck?.extraction ?? null) as { pages?: ExtractionPageData[] } | null,
      txRows,
    )

    // Section's tracked leaf topics — grounds the AI's per-question concept tags
    // onto the real topic pool so they map cleanly onto mastery (mastery is
    // scored at the leaf). Best-effort: no pool → ungrounded concepts.
    const { data: topicRows } = await adminDb
      .from('skills')
      .select('id, name, parent_id, excluded')
      .eq('section_id', room.section_id)
    const leafPool = selectLeafSkills(
      (topicRows ?? []) as Array<{ id: string; name: string; parent_id: string | null; excluded: boolean }>,
    )
    const poolForMatch = leafPool.map((t) => ({ id: t.id, canonical: canonicalizeName(t.name) }))

    // Generate quiz via Gemini
    const result = await generateLiveQuizFromTranscription(
      {
        slideContent,
        transcription: transcriptionContent,
        slidesCovered,
        conceptPool: leafPool.map((t) => t.name),
      },
      { sectionId: room.section_id },
    )

    if (result.error || result.questions.length === 0) {
      logger.error('generateAndPushLiveQuiz: generation failed', null, {
        roomId,
        error: result.error,
      })
      return { error: result.error || 'Failed to generate quiz questions' }
    }

    // Transform to quizPayloadSchema format for lc_interactions
    const quizPayload = {
      title: result.title || 'Comprehension Check',
      questions: result.questions.map((q) => {
        // Map the (grounded) concept tag back to a real skill id so this
        // question feeds skill mastery. No match → empty; recompute then falls
        // back to name-matching the quiz title.
        const matched = matchInPool(q.concept, poolForMatch)
        return {
          id: q.id,
          prompt: q.prompt,
          choices: q.choices,
          correctChoiceId: q.correctChoiceId,
          concept: q.concept,
          explanation: q.explanation,
          skillIds: matched ? [matched] : [],
        }
      }),
      timeLimitSeconds,
      revealAnswers,
    }

    // Insert as draft, then immediately open
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: created, error: insertError } = await (adminDb as any)
      .from('lc_interactions')
      .insert({
        room_id: roomId,
        kind: 'quiz',
        payload: quizPayload,
        status: 'open',
        opened_at: new Date().toISOString(),
        created_by: user.id,
      })
      .select('id')
      .single()

    if (insertError || !created) {
      logger.error('generateAndPushLiveQuiz: insert failed', insertError, { roomId })
      return { error: 'Failed to push quiz to students' }
    }

    logEvent({
      userId: user.id,
      eventType: 'lc_room.ai_quiz_generated',
      eventCategory: 'professor',
      metadata: {
        roomId,
        interactionId: created.id,
        questionCount: result.questions.length,
        slidesCovered,
      },
      sectionId: room.section_id,
    })

    return { interactionId: created.id }
  } catch (error) {
    logger.error('generateAndPushLiveQuiz: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Get Quiz Concept Analytics ───────────────────────────
// Reads lc_responses for an AI-generated quiz, computes per-concept
// accuracy, and returns a breakdown showing which topics students
// understood and which need revisiting.

export interface ConceptAnalysis {
  concept: string
  correctCount: number
  totalCount: number
  correctRate: number
}

export interface QuizQuestionSummary {
  id: string
  prompt: string
  concept: string
  correctAnswer: string
  correctRate: number
}

export async function getQuizConceptAnalytics(
  interactionId: string,
): Promise<{ concepts?: ConceptAnalysis[]; questions?: QuizQuestionSummary[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = interactionIdSchema.safeParse(interactionId)
    if (!parsed.success) return { error: 'Invalid interaction ID' }

    const adminDb = createAdminClient()

    // Fetch the interaction to get quiz payload
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: interaction, error: intError } = await (adminDb as any)
      .from('lc_interactions')
      .select('id, room_id, kind, payload, status')
      .eq('id', parsed.data)
      .single()

    if (intError || !interaction) return { error: 'Interaction not found' }
    if (interaction.kind !== 'quiz') return { error: 'Not a quiz interaction' }

    // Verify room ownership
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: room } = await (adminDb as any)
      .from('lc_rooms')
      .select('prof_id')
      .eq('id', interaction.room_id)
      .single()

    if (!room || room.prof_id !== user.id) return { error: 'Forbidden' }

    // Fetch all responses
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: responses, error: resError } = await (adminDb as any)
      .from('lc_responses')
      .select('response')
      .eq('interaction_id', parsed.data)

    if (resError) {
      logger.error('getQuizConceptAnalytics: response fetch failed', resError, { interactionId: parsed.data })
      return { error: 'Failed to load responses' }
    }

    const allResponses = (responses ?? []) as Array<{
      response: { answers: Record<string, string> }
    }>

    if (allResponses.length === 0) {
      return { concepts: [] }
    }

    // Build question map: questionId → { correctChoiceId, concept }
    const payload = interaction.payload as {
      questions: Array<{
        id: string
        correctChoiceId: string
        concept?: string
      }>
    }

    const questionMap = new Map<string, { correctChoiceId: string; concept: string }>()
    for (const q of payload.questions) {
      questionMap.set(q.id, {
        correctChoiceId: q.correctChoiceId,
        concept: q.concept ?? 'General',
      })
    }

    // Aggregate by concept
    const conceptStats = new Map<string, { correct: number; total: number }>()

    for (const resp of allResponses) {
      const answers = resp.response?.answers ?? {}
      for (const [questionId, selectedChoiceId] of Object.entries(answers)) {
        const question = questionMap.get(questionId)
        if (!question) continue

        const stats = conceptStats.get(question.concept) ?? { correct: 0, total: 0 }
        stats.total++
        if (selectedChoiceId === question.correctChoiceId) {
          stats.correct++
        }
        conceptStats.set(question.concept, stats)
      }
    }

    const concepts: ConceptAnalysis[] = Array.from(conceptStats.entries())
      .map(([concept, { correct, total }]) => ({
        concept,
        correctCount: correct,
        totalCount: total,
        correctRate: total > 0 ? Math.round((correct / total) * 100) : 0,
      }))
      .sort((a, b) => a.correctRate - b.correctRate)

    // Per-question summary
    const questionStats = new Map<string, { correct: number; total: number }>()
    for (const resp of allResponses) {
      const answers = resp.response?.answers ?? {}
      for (const [questionId, selectedChoiceId] of Object.entries(answers)) {
        const question = questionMap.get(questionId)
        if (!question) continue
        const stats = questionStats.get(questionId) ?? { correct: 0, total: 0 }
        stats.total++
        if (selectedChoiceId === question.correctChoiceId) {
          stats.correct++
        }
        questionStats.set(questionId, stats)
      }
    }

    const fullPayload = interaction.payload as {
      questions: Array<{
        id: string
        prompt: string
        correctChoiceId: string
        concept?: string
        choices: Array<{ id: string; text: string }>
      }>
    }

    const questions: QuizQuestionSummary[] = fullPayload.questions.map((q) => {
      const correctChoice = q.choices.find((c) => c.id === q.correctChoiceId)
      const stats = questionStats.get(q.id)
      return {
        id: q.id,
        prompt: q.prompt,
        concept: q.concept ?? 'General',
        correctAnswer: correctChoice?.text ?? '',
        correctRate: stats && stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
      }
    })

    return { concepts, questions }
  } catch (error) {
    logger.error('getQuizConceptAnalytics: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// ── Action: Close Quiz and Snapshot Report ────────────────────────
// Closes an AI quiz, computes analytics, and stores the report in
// the interaction payload so it can be retrieved later without
// recomputing. Atomic: close + snapshot happen in one call.

export interface NonResponder {
  id: string
  name: string
}

export interface QuizReport {
  closedAt: string
  totalStudents: number
  overallAccuracy: number
  concepts: ConceptAnalysis[]
  questions: QuizQuestionSummary[]
  /** Enrolled students who did not answer this quiz (#87). */
  nonResponders: NonResponder[]
}

/**
 * Enrolled students in `sectionId` who have NOT responded to `interactionId`,
 * with display names, sorted alphabetically. Shared by the live "waiting on"
 * view and the closed-quiz report. Read-only; caller must have already
 * verified the professor owns the room.
 */
async function fetchNonResponders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  interactionId: string,
): Promise<NonResponder[]> {
  const { data: enrollments } = await adminDb
    .from('enrollments')
    .select('student_id')
    .eq('section_id', sectionId)
    .in('status', ['enrolled', 'completed'])
  const enrolledIds: string[] = (enrollments ?? []).map(
    (e: { student_id: string }) => e.student_id,
  )
  if (enrolledIds.length === 0) return []

  const { data: responses } = await adminDb
    .from('lc_responses')
    .select('student_id')
    .eq('interaction_id', interactionId)
  const respondedIds = new Set<string>(
    (responses ?? []).map((r: { student_id: string }) => r.student_id),
  )

  const missingIds = enrolledIds.filter((id) => !respondedIds.has(id))
  if (missingIds.length === 0) return []

  const { data: profiles } = await adminDb
    .from('profiles')
    .select('id, name, email')
    .in('id', missingIds)
  const nameById = new Map<string, string>()
  for (const p of (profiles ?? []) as Array<{ id: string; name?: string; email?: string }>) {
    nameById.set(p.id, p.name || p.email || 'Student')
  }

  return missingIds
    .map((id) => ({ id, name: nameById.get(id) ?? 'Student' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function closeQuizWithReport(
  interactionId: string,
): Promise<{ report?: QuizReport; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = interactionIdSchema.safeParse(interactionId)
    if (!parsed.success) return { error: 'Invalid interaction ID' }

    const adminDb = createAdminClient()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: interaction, error: intError } = await (adminDb as any)
      .from('lc_interactions')
      .select('id, room_id, kind, payload, status')
      .eq('id', parsed.data)
      .single()

    if (intError || !interaction) return { error: 'Interaction not found' }
    if (interaction.kind !== 'quiz') return { error: 'Not a quiz interaction' }
    if (interaction.status !== 'open') return { error: 'Quiz is not open' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: room } = await (adminDb as any)
      .from('lc_rooms')
      .select('prof_id, section_id')
      .eq('id', interaction.room_id)
      .single()

    if (!room || room.prof_id !== user.id) return { error: 'Forbidden' }

    // Compute analytics
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: responses } = await (adminDb as any)
      .from('lc_responses')
      .select('response')
      .eq('interaction_id', parsed.data)

    const allResponses = (responses ?? []) as Array<{
      response: { answers: Record<string, string> }
    }>

    const quizPayload = interaction.payload as {
      questions: Array<{
        id: string
        prompt: string
        correctChoiceId: string
        concept?: string
        choices: Array<{ id: string; text: string }>
      }>
    }

    const questionMap = new Map<string, { correctChoiceId: string; concept: string }>()
    for (const q of quizPayload.questions) {
      questionMap.set(q.id, {
        correctChoiceId: q.correctChoiceId,
        concept: q.concept ?? 'General',
      })
    }

    const conceptStats = new Map<string, { correct: number; total: number }>()
    const questionStats = new Map<string, { correct: number; total: number }>()

    for (const resp of allResponses) {
      const answers = resp.response?.answers ?? {}
      for (const [questionId, selectedChoiceId] of Object.entries(answers)) {
        const question = questionMap.get(questionId)
        if (!question) continue

        const cs = conceptStats.get(question.concept) ?? { correct: 0, total: 0 }
        cs.total++
        if (selectedChoiceId === question.correctChoiceId) cs.correct++
        conceptStats.set(question.concept, cs)

        const qs = questionStats.get(questionId) ?? { correct: 0, total: 0 }
        qs.total++
        if (selectedChoiceId === question.correctChoiceId) qs.correct++
        questionStats.set(questionId, qs)
      }
    }

    const conceptsResult: ConceptAnalysis[] = Array.from(conceptStats.entries())
      .map(([concept, { correct, total }]) => ({
        concept,
        correctCount: correct,
        totalCount: total,
        correctRate: total > 0 ? Math.round((correct / total) * 100) : 0,
      }))
      .sort((a, b) => a.correctRate - b.correctRate)

    const questionsResult: QuizQuestionSummary[] = quizPayload.questions.map((q) => {
      const correctChoice = q.choices.find((c) => c.id === q.correctChoiceId)
      const stats = questionStats.get(q.id)
      return {
        id: q.id,
        prompt: q.prompt,
        concept: q.concept ?? 'General',
        correctAnswer: correctChoice?.text ?? '',
        correctRate: stats && stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
      }
    })

    const totalAnswers = Array.from(conceptStats.values()).reduce((s, v) => s + v.total, 0)
    const totalCorrect = Array.from(conceptStats.values()).reduce((s, v) => s + v.correct, 0)

    // Best-effort enrichment — never let a non-responder lookup failure block
    // closing the quiz / returning the report.
    let nonResponders: NonResponder[] = []
    try {
      nonResponders = await fetchNonResponders(adminDb, room.section_id, parsed.data)
    } catch (nrErr) {
      logger.warn('closeQuizWithReport: non-responder fetch failed (report still returned)', {
        error: String(nrErr),
      })
    }

    const report: QuizReport = {
      closedAt: new Date().toISOString(),
      totalStudents: allResponses.length,
      overallAccuracy: totalAnswers > 0 ? Math.round((totalCorrect / totalAnswers) * 100) : 0,
      concepts: conceptsResult,
      questions: questionsResult,
      nonResponders,
    }

    // Close quiz + store report atomically
    const updatedPayload = { ...interaction.payload, report }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: closeError } = await (adminDb as any)
      .from('lc_interactions')
      .update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        payload: updatedPayload,
      })
      .eq('id', parsed.data)

    if (closeError) {
      logger.error('closeQuizWithReport: close failed', closeError, { interactionId: parsed.data })
      return { error: 'Failed to close quiz' }
    }

    // Final aggregate broadcast — best-effort, don't fail the close if it errors
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (adminDb as any).rpc('lc_send_event', {
        p_room_id: interaction.room_id,
        p_event_type: 'aggregate_updated',
        p_data: { interactionId: parsed.data, final: true },
        p_persist: true,
        p_broadcast: true,
      })
    } catch (broadcastError) {
      logger.warn('closeQuizWithReport: final aggregate broadcast failed', { error: broadcastError })
    }

    logEvent({
      userId: user.id,
      eventType: 'lc_room.quiz_closed_with_report',
      eventCategory: 'professor',
      metadata: {
        interactionId: parsed.data,
        totalStudents: allResponses.length,
        overallAccuracy: report.overallAccuracy,
      },
      sectionId: room.section_id,
    })

    // A closed live-classroom quiz is final mastery evidence — fold it into
    // skill_mastery now (coalesced, never throws) rather than waiting for the
    // next unrelated grade / 5-min sweep / nightly job. Mirrors how graded
    // regular quizzes and assignments enqueue a recompute.
    after(() => enqueueMasteryRecompute(room.section_id))

    return { report }
  } catch (error) {
    logger.error('closeQuizWithReport: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}

// Live "who hasn't answered yet" (#87). Returns enrolled students who have no
// response to the given poll/quiz — used by the professor's live interaction
// view (refetched as answers arrive). Read-only, professor-only.
export async function getInteractionNonResponders(
  interactionId: string,
): Promise<{ nonResponders?: NonResponder[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = interactionIdSchema.safeParse(interactionId)
    if (!parsed.success) return { error: 'Invalid interaction ID' }

    const adminDb = createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: interaction } = await (adminDb as any)
      .from('lc_interactions')
      .select('id, room_id')
      .eq('id', parsed.data)
      .single()
    if (!interaction) return { error: 'Interaction not found' }

    const { ok, room } = await verifyRoomOwnership(interaction.room_id, user.id)
    if (!ok || !room) return { error: 'Forbidden' }

    const nonResponders = await fetchNonResponders(adminDb, room.section_id, parsed.data)
    return { nonResponders }
  } catch (error) {
    logger.error('getInteractionNonResponders: Unexpected error', error)
    return { error: 'An unexpected error occurred' }
  }
}
