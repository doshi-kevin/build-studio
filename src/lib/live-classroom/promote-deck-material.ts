// Promote an uploaded live-classroom deck into a module material — saved for the
// professor, NOT yet shared with students.
//
// When a professor picks a deck FROM A MODULE, applyModuleItemAsDeck already pins
// the session under that module on the roadmap (via a module→resource edge). When
// they UPLOAD THEIR OWN FILE instead, there's no module to attach to, so the
// session would have no module band to sit in and would stay off the roadmap.
//
// This mirrors the hidden "Quiz Uploads" pattern (registerQuizUpload): the
// container module is published, but the ITEM is inserted `is_visible: false`, so
// students see nothing until the professor shares it (shareRoomUploads, offered by
// the end-of-class prompt). Uploading a deck to project is not a decision to
// publish coursework, and the upload control never asked. The uploaded source is
// copied into the course-materials bucket, registered as a real lecture module
// item (so it goes through the durable extraction pipeline and is
// browsable/reusable), the deck is linked to it, and the live session is pinned
// under the "Classroom Uploads" module on the roadmap. Until it is shared, the
// roadmap draws the card faded with an eye-off glyph.
//
// Best-effort: callers run this after a successful render and must never fail the
// render over it. Idempotent — a deck already linked to a module item is skipped,
// so re-renders don't duplicate work.

import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { COURSE_MATERIALS_BUCKET, inferLectureFileType } from '@/lib/supabase/storage'
import { enqueueExtractionJob } from '@/lib/extraction/enqueue'
import { enqueueJob } from '@/lib/jobs/enqueue'
import { EMBED_MATERIAL_JOB_TYPE } from '@/lib/jobs/pipelines/embed-material'
import { writePlacementEdge } from '@/lib/roadmap/placement'

// Defined locally (not imported from render-deck) to avoid a cycle — render-deck
// calls this module. Matches the same local const in snapshot.ts / actions.ts.
const LIVE_CLASSROOM_BUCKET = 'live-classroom-decks'

const CLASSROOM_UPLOADS_MODULE_TITLE = 'Classroom Uploads'
/** The container's real identity — `modules.system_kind`, not its title, which a
 *  professor can type or rename (migration 20260729044216). */
const CLASSROOM_UPLOADS_KIND = 'classroom_uploads'

interface PromoteArgs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: SupabaseClient | any
  /** The room row (needs at least id + section_id). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  room: any
  /** For event attribution; null for a headless render. */
  userId: string | null
  deckId: string
}

/**
 * Find-or-create the section's "Classroom Uploads" container module. The module
 * itself is published (it has to be, for its items to be reachable at all once
 * shared); each ITEM decides its own visibility. Race-safe via the
 * modules_one_system_kind_per_section unique index (re-selects the winner on a
 * 23505 conflict).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findOrCreateUploadsModule(adminDb: any, sectionId: string): Promise<string | null> {
  /* Keyed on `system_kind`, never the title: the title is a string a professor can
     type, and matching on it meant a module they happened to name "Classroom
     Uploads" quietly became the container that live-classroom decks land in. */
  const { data: existing } = await adminDb
    .from('modules')
    .select('id')
    .eq('section_id', sectionId)
    .eq('system_kind', CLASSROOM_UPLOADS_KIND)
    .limit(1)
  if (existing?.[0]?.id) return existing[0].id as string

  const { data: created, error } = await adminDb
    .from('modules')
    .insert({
      section_id: sectionId,
      title: CLASSROOM_UPLOADS_MODULE_TITLE,
      description: 'Files uploaded during live classroom sessions.',
      is_published: true,
      position: 9998,
      system_kind: CLASSROOM_UPLOADS_KIND,
    })
    .select('id')
    .single()
  if (created) return created.id as string
  if (error?.code === '23505') {
    // Lost the find-or-create race (modules_one_system_kind_per_section) — use
    // the winner's row.
    const { data: raced } = await adminDb
      .from('modules')
      .select('id')
      .eq('section_id', sectionId)
      .eq('system_kind', CLASSROOM_UPLOADS_KIND)
      .limit(1)
    return raced?.[0]?.id ?? null
  }
  logger.error('promoteUploadedDeckToModuleMaterial: module create failed', error, { sectionId })
  return null
}

/**
 * Promote deck `deckId` (an uploaded file) into a module material — hidden from
 * students until shared — and pin its session under the "Classroom Uploads"
 * module. No-op when the deck was picked from a module (already has
 * module_item_id) or has no source file.
 */
export async function promoteUploadedDeckToModuleMaterial({
  adminDb,
  room,
  userId,
  deckId,
}: PromoteArgs): Promise<void> {
  const db = adminDb
  const sectionId: string = room.section_id
  const roomId: string = room.id

  // 1. Load the deck; only promote genuine uploads that aren't linked yet.
  const { data: deck } = await db
    .from('lc_decks')
    .select('id, title, source_file_path, module_item_id')
    .eq('id', deckId)
    .eq('room_id', roomId)
    .maybeSingle()
  if (!deck || !deck.source_file_path || deck.module_item_id) return

  // Source lives at the canonical {roomId}/{deckId}/source.<ext> (server-authored).
  const expectedPrefix = `${roomId}/${deckId}/source.`
  const src: string = deck.source_file_path
  const ext = src.startsWith(expectedPrefix) ? src.slice(expectedPrefix.length) : null
  if (ext !== 'pdf' && ext !== 'pptx' && ext !== 'ppt') return

  const rawTitle: string = (deck.title as string | null)?.trim() || 'Live session slides'
  const itemTitle = rawTitle.replace(/\.[^.]+$/, '')
  /* Type comes from the SOURCE extension, which the check above already
     verified — not from the deck's title. A professor naming a deck
     "notes.txt" does not make their PDF a text file, and typing it from the
     title meant the wrong extractor ran on the real bytes. `ext` is one of
     pdf/pptx/ppt here, so the result is always an extractable document. */
  const fileType = inferLectureFileType(`deck.${ext}`)
  // Display name for the material row: keep the professor's title, but ensure it
  // carries the SOURCE extension rather than whatever they happened to type.
  const fileName = `${itemTitle}.${ext}`

  // 2. Copy the source into the course-materials bucket so it's a real, browsable
  //    module material (the live-classroom bucket is deck-render-only).
  const { data: blob, error: dlError } = await db.storage.from(LIVE_CLASSROOM_BUCKET).download(src)
  if (dlError || !blob) {
    logger.warn('promoteUploadedDeckToModuleMaterial: source download failed', { roomId, deckId })
    return
  }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const materialPath = `${sectionId}/live-classroom-uploads/${deckId}.${ext}`
  const { error: upError } = await db.storage
    .from(COURSE_MATERIALS_BUCKET)
    .upload(materialPath, buffer, { contentType: blob.type || 'application/octet-stream', upsert: true })
  if (upError) {
    logger.warn('promoteUploadedDeckToModuleMaterial: material upload failed', { roomId, deckId, error: String(upError) })
    return
  }

  // 3. Find-or-create the container module (published; its items gate themselves).
  const moduleId = await findOrCreateUploadsModule(db, sectionId)
  if (!moduleId) return

  // 4. Register the file as a HIDDEN lecture item (still goes through extraction).
  const { data: item, error: itemError } = await db
    .from('module_items')
    .insert({
      module_id: moduleId,
      item_type: 'lecture',
      title: itemTitle,
      description: '',
      position: 9999,
      /* NOT student-visible on upload. A professor dragging a deck into a live
         room is trying to project it, not to publish coursework — and the upload
         control never said otherwise, so this was the one change in the roadmap
         work a professor could not see coming. The file is registered and
         extracted exactly as before; what changes is that SHARING is a separate,
         explicit step (shareRoomUploads), offered when the class ends. Until
         then the roadmap shows the card faded with an eye-off, so an unshared deck
         is visible to the professor and impossible to mistake for published. */
      is_visible: false,
      content: {
        fileType,
        filePath: materialPath,
        fileName,
        liveClassroom: { roomId, deckId, uploadedAt: new Date().toISOString(), uploadedBy: userId },
      },
    })
    .select('id')
    .single()
  if (itemError || !item) {
    logger.error('promoteUploadedDeckToModuleMaterial: item insert failed', itemError, { roomId, deckId })
    return
  }
  const moduleItemId = item.id as string

  // 5. Link the deck to its new module item + enqueue durable extraction and
  //    vector indexing. Both, because they feed different readers: extraction
  //    gives the item its topics and page text, embedding puts its pages in the
  //    retrieval index. Only extraction was enqueued here, so a deck projected
  //    in class — the single most likely lecture in the whole course — reached
  //    the index only if the professor later edited the item by hand.
  await db.from('lc_decks').update({ module_item_id: moduleItemId }).eq('id', deckId)
  await enqueueExtractionJob({ moduleItemId, sectionId })
  try {
    // Read the tenant from the section rather than trusting the caller's `room`
    // select list — `room` is loosely typed and its columns vary by call site.
    const { data: sec } = await db
      .from('course_sections')
      .select('institution_id')
      .eq('id', sectionId)
      .single()
    if (sec) {
      await enqueueJob({
        type: EMBED_MATERIAL_JOB_TYPE,
        params: { moduleItemId },
        institutionId: sec.institution_id,
        sectionId,
        createdBy: userId,
        subjectKey: moduleItemId,
      })
    }
  } catch (error) {
    // Best-effort, exactly as the modules board treats it: the sweep re-kicks a
    // lost enqueue, and a failure here must not cost the professor their deck.
    logger.warn('promoteUploadedDeckToModuleMaterial: embed enqueue failed (non-fatal)', {
      moduleItemId,
      error: String(error),
    })
  }

  // 6. Pin the session under the module — but never clobber an existing real
  //    module placement (e.g. the professor also picked a module PDF, which
  //    applyModuleItemAsDeck already placed). Only place if unplaced.
  const { data: existingEdge } = await db
    .from('roadmap_edges')
    .select('id')
    .eq('section_id', sectionId)
    .eq('from_node_type', 'module')
    .eq('to_node_type', 'live_session')
    .eq('to_node_id', roomId)
    .limit(1)
  if (!existingEdge?.[0]) {
    await writePlacementEdge(db, sectionId, 'live_session', roomId, moduleId)
  }

  /* Audited on BOTH paths. This was guarded on `userId`, and the headless
     scheduled-render path passes null — so the write that creates a course
     material landed with no audit trail at all, on exactly the path no human
     watched. `actorId: null` + a system actor keeps the row rather than dropping
     it; the event still names the room and deck it came from. */
  logEvent({
    userId,
    eventType: 'lc_room.deck_promoted_to_material',
    eventCategory: 'professor',
    sectionId,
    metadata: {
      roomId,
      deckId,
      moduleItemId,
      moduleId,
      visibleToStudents: false,
      actor: userId ? 'professor' : 'system:scheduled-render',
    },
  })
  logger.info('promoteUploadedDeckToModuleMaterial: promoted', { roomId, deckId, moduleItemId })
}
