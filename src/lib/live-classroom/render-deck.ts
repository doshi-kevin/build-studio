// renderDeckToStorage — the deck render core, extracted from the
// /api/live-classroom/render-deck route so it can run in two places:
//   1. The route (cookie-authed, mid-class + pre-class uploads).
//   2. The background render_scheduled_deck pipeline (service-role, no browser).
//
// The professor's browser used to hold the render request open — navigating
// away killed the render. Scheduling needs the render to survive the professor
// leaving, so the pipeline runs this same core from the durable job queue.
//
// SECURITY: the source path is ALWAYS derived server-side from the deck row's
// source_file_path (written by the server at upload time), never from a client
// string, and re-validated against the canonical {roomId}/{deckId}/source.ext
// shape. A caller cannot redirect the render at another tenant's file.

import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { renderPdfPage } from '@/lib/document-parser/page-renderer'
import { parseDocument } from '@/lib/document-parser'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { ensurePdf, isPptxEnabled, ConvertError } from '@/lib/live-classroom/deck-converter'
import { promoteUploadedDeckToModuleMaterial } from '@/lib/live-classroom/promote-deck-material'
import { MAX_DECK_BYTES, MAX_PPTX_BYTES, MAX_DECK_PAGES } from '@/lib/validations/live-classroom'

export const LIVE_CLASSROOM_BUCKET = 'live-classroom-decks'

/** Terminal render failure with the HTTP status + user-facing message the route
 *  should surface. `broadcast` is true when joined clients were already told the
 *  render failed (so the route needn't re-broadcast). */
export class RenderDeckError extends Error {
  constructor(
    public reason: string,
    public httpStatus: number,
    public clientMessage: string,
    public broadcast = false,
  ) {
    super(clientMessage)
    this.name = 'RenderDeckError'
  }
}

interface RenderDeckArgs {
  adminDb: SupabaseClient
  roomId: string
  deckId: string
  /** Mirror the rendered deck onto lc_rooms (go-live). False for pre-class /
   *  scheduled renders — the deck is rendered but hidden until "Start class". */
  activate: boolean
  /** For event attribution; null for the headless background render. */
  userId: string | null
  /** Section the room belongs to — tags analytics events. */
  sectionId: string
}

/**
 * Render a deck's source file to per-page WebP images in storage, persist the
 * deck row, and (optionally) activate it on the room. Throws RenderDeckError on
 * terminal failure (already broadcasting deck_failed where relevant). Idempotent
 * enough for the queue: safe to re-run (writes a fresh version folder).
 */
export async function renderDeckToStorage({
  adminDb,
  roomId,
  deckId,
  activate,
  userId,
  sectionId,
}: RenderDeckArgs): Promise<{ deckUrl: string; pageCount: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = adminDb as any

  // 1. Load the deck + derive the source path SERVER-SIDE. The deck must belong
  //    to this room. source_file_path is server-authored at upload time.
  const { data: deckRow } = await db
    .from('lc_decks')
    .select('id, extraction, source_file_path, room:room_id(status)')
    .eq('id', deckId)
    .eq('room_id', roomId)
    .maybeSingle()
  if (!deckRow) {
    throw new RenderDeckError('deck_not_found', 404, 'Deck not found')
  }

  // If the session was cancelled/ended before the render started, stop cleanly.
  // A background job then records a no-op skip rather than a false failure
  // (cancelScheduledSession deletes the source, which would otherwise surface as
  // a spurious "source_missing" failure).
  const roomStatus = Array.isArray(deckRow.room) ? deckRow.room[0]?.status : deckRow.room?.status
  if (roomStatus === 'ended') {
    throw new RenderDeckError('cancelled', 409, 'This session was cancelled.')
  }

  // Derive + validate the source path from the server-authored source_file_path.
  // The canonical location is always {roomId}/{deckId}/source.<ext>; we re-check
  // the shape with a plain prefix compare (no dynamic RegExp — roomId/deckId are
  // validated UUIDs, but this keeps the check free of interpolation surface).
  const rawPath: string | null = deckRow.source_file_path
  const expectedPrefix = `${roomId}/${deckId}/source.`
  const ext = rawPath?.startsWith(expectedPrefix) ? rawPath.slice(expectedPrefix.length) : null
  if (ext !== 'pdf' && ext !== 'pptx' && ext !== 'ppt') {
    throw new RenderDeckError('bad_source_path', 400, 'Source file is missing. Please re-upload.')
  }
  const sourceExt: 'pdf' | 'pptx' | 'ppt' = ext
  const sourcePath = `${expectedPrefix}${ext}` // validated canonical path
  const deckAlreadyExtracted = deckRow.extraction != null

  if (sourceExt !== 'pdf' && !isPptxEnabled()) {
    throw new RenderDeckError(
      'pptx_disabled',
      503,
      'PowerPoint conversion is not enabled. Please upload a PDF.',
    )
  }

  // Helper: fire-and-forget broadcast (progress + terminal failure). Transient
  // UX state, not persisted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const broadcast = async (eventType: string, data: Record<string, any>) => {
    try {
      await db.rpc('lc_send_event', {
        p_room_id: roomId,
        p_event_type: eventType,
        p_data: data,
        p_persist: false,
        p_broadcast: true,
      })
    } catch (err) {
      logger.debug('renderDeckToStorage: broadcast failed (non-fatal)', { eventType, err: String(err) })
    }
  }

  // 2. Download the source from storage (server-to-server; no GFE ingress cap).
  const { data: blob, error: downloadError } = await db.storage
    .from(LIVE_CLASSROOM_BUCKET)
    .download(sourcePath)
  if (downloadError || !blob) {
    logger.error('renderDeckToStorage: source download failed', downloadError, { roomId, sourcePath })
    throw new RenderDeckError('source_missing', 404, 'Source file not found. Please re-upload.')
  }

  const sizeCap = sourceExt === 'pdf' ? MAX_DECK_BYTES : MAX_PPTX_BYTES
  if (blob.size > sizeCap) {
    throw new RenderDeckError(
      'too_large',
      413,
      `File too large. Maximum size is ${Math.round(sizeCap / (1024 * 1024))} MB.`,
    )
  }
  const sourceBuffer = Buffer.from(await blob.arrayBuffer())

  // 3. Normalize to PDF (PPT/PPTX via Gotenberg). On failure tell joined clients
  //    the conversion bombed so they stop waiting.
  let pdfBuffer: Buffer
  if (sourceExt === 'pdf') {
    pdfBuffer = sourceBuffer
  } else {
    try {
      const convertStart = Date.now()
      pdfBuffer = await ensurePdf(sourceBuffer, sourceExt, `source.${sourceExt}`)
      if (userId) {
        logEvent({
          userId,
          eventType: 'lc_room.deck_convert_succeeded',
          eventCategory: 'professor',
          metadata: { roomId, format: sourceExt, inBytes: sourceBuffer.length, outBytes: pdfBuffer.length, ms: Date.now() - convertStart },
          sectionId,
        })
      }
    } catch (convertErr) {
      const status = convertErr instanceof ConvertError ? convertErr.status : undefined
      logger.error('renderDeckToStorage: PPTX conversion failed', convertErr, { roomId, sourceExt, status })
      await broadcast('deck_failed', { reason: 'convert' })
      if (userId) {
        logEvent({
          userId,
          eventType: 'lc_room.deck_convert_failed',
          eventCategory: 'professor',
          metadata: { roomId, format: sourceExt, status: status ?? null },
          sectionId,
        })
      }
      throw new RenderDeckError(
        'convert',
        502,
        "We couldn't convert your PowerPoint. Try again, or upload a PDF instead.",
        true,
      )
    }
  }

  // 4. Page count.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) }).promise
  const pageCount = doc.numPages
  await doc.destroy()
  if (pageCount > MAX_DECK_PAGES) {
    throw new RenderDeckError('too_many_pages', 400, `PDF has too many pages. Maximum is ${MAX_DECK_PAGES} pages.`)
  }

  // 5. Text extraction in parallel with the render loop (skip module decks that
  //    already carry a snapshot). Awaited after the loop.
  const extractionPromise = (async () => {
    if (deckAlreadyExtracted) return null
    try {
      const result = await parseDocument(pdfBuffer)
      return result.status === 'completed' ? result : null
    } catch (err) {
      logger.warn('renderDeckToStorage: extraction failed (non-fatal)', { roomId, err: String(err) })
      return null
    }
  })()

  // 6. Versioned upload paths so a re-render doesn't collide with CDN-cached
  //    bytes. Activation stays atomic (clients read the old deck until flip).
  const deckVersion = Date.now().toString()

  for (let i = 1; i <= pageCount; i++) {
    // Cancel guard: if the room or deck was deleted/ended mid-render (e.g. the
    // professor cancelled the scheduled session), stop uploading orphan pages.
    if (i === 1 || i % 5 === 0) {
      const { data: stillThere } = await db
        .from('lc_decks')
        .select('id, room:room_id(status)')
        .eq('id', deckId)
        .eq('room_id', roomId)
        .maybeSingle()
      const roomStatus = Array.isArray(stillThere?.room) ? stillThere?.room[0]?.status : stillThere?.room?.status
      if (!stillThere || roomStatus === 'ended') {
        logger.info('renderDeckToStorage: aborting — room/deck gone or ended', { roomId, deckId, page: i })
        throw new RenderDeckError('cancelled', 409, 'This session was cancelled.')
      }
    }

    const rendered = await renderPdfPage(pdfBuffer, { pageNumber: i, format: 'webp', scale: 2 })
    if (!rendered) {
      logger.error('renderDeckToStorage: failed to render page', null, { roomId, page: i })
      await broadcast('deck_failed', { reason: 'render', page: i })
      throw new RenderDeckError('render', 500, `Failed to render page ${i}`, true)
    }

    let uploadError: unknown = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await db.storage
        .from(LIVE_CLASSROOM_BUCKET)
        .upload(`${roomId}/${deckId}/${deckVersion}/page-${i}.webp`, rendered.buffer, {
          contentType: rendered.mimeType,
          upsert: true,
        })
      uploadError = error
      if (!error) break
      logger.warn('renderDeckToStorage: page upload attempt failed, retrying', { roomId, page: i, attempt, err: String(error) })
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt))
    }
    if (uploadError) {
      logger.error('renderDeckToStorage: upload failed', uploadError, { roomId, page: i })
      await broadcast('deck_failed', { reason: 'upload', page: i })
      throw new RenderDeckError('upload', 500, `Failed to upload page ${i}`, true)
    }

    await broadcast('deck_render_progress', { pagesRendered: i, totalPages: pageCount })
  }

  // 7. Persist the deck (source of truth), then optionally activate on the room.
  const deckUrl = `${LIVE_CLASSROOM_BUCKET}/${roomId}/${deckId}/${deckVersion}`
  const { error: deckUpdateError } = await db
    .from('lc_decks')
    .update({ deck_url: deckUrl, page_count: pageCount, current_slide: 0 })
    .eq('id', deckId)
  if (deckUpdateError) {
    logger.error('renderDeckToStorage: failed to update deck', deckUpdateError, { roomId, deckId })
    throw new RenderDeckError('persist', 500, 'Failed to save deck')
  }

  extractionPromise
    .then(async (result) => {
      if (result) {
        await db.from('lc_decks').update({ extraction: result }).eq('id', deckId)
        logger.info('renderDeckToStorage: extraction completed', { roomId, deckId, pages: result.pages?.length })
      }
    })
    .catch(() => {})

  if (activate) {
    const { error: roomUpdateError } = await db
      .from('lc_rooms')
      .update({ active_deck_id: deckId, deck_url: deckUrl, deck_page_count: pageCount, current_slide: 0 })
      .eq('id', roomId)
    if (roomUpdateError) {
      logger.error('renderDeckToStorage: failed to update room', roomUpdateError, { roomId })
      throw new RenderDeckError('activate', 500, 'Failed to update room with deck info')
    }
  }

  // Promote an uploaded (non-module) deck into a student-visible "Classroom
  // Uploads" module material and pin the session under it on the roadmap. Runs
  // here — in the shared core — so BOTH the browser route (live/mid-class) and
  // the headless background pipeline (scheduled) cover it. Best-effort +
  // idempotent (skips decks already linked to a module item), so it never
  // affects the render result and re-renders don't duplicate work.
  try {
    await promoteUploadedDeckToModuleMaterial({
      adminDb: db,
      room: { id: roomId, section_id: sectionId },
      userId,
      deckId,
    })
  } catch (promoteErr) {
    logger.warn('renderDeckToStorage: promote-to-material failed (non-fatal)', {
      roomId,
      deckId,
      err: String(promoteErr),
    })
  }

  logger.info('renderDeckToStorage: success', { roomId, deckId, pageCount })
  return { deckUrl, pageCount }
}
