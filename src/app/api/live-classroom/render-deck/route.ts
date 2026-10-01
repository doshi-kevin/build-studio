// Live Classroom deck render route — cookie-authed entry point for the
// professor's browser (mid-class "Add a deck" and pre-class setup uploads).
// The heavy lifting lives in renderDeckToStorage (src/lib/live-classroom/
// render-deck.ts) so the background render_scheduled_deck pipeline can run the
// exact same core without a browser. This route only owns: auth, the room
// ownership/status gate, a per-instance mutex, and mapping render failures to
// HTTP responses.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { renderDeckJsonBodySchema } from '@/lib/validations/live-classroom'
import { renderDeckToStorage, RenderDeckError } from '@/lib/live-classroom/render-deck'
import { revalidatePath } from 'next/cache'

// Force Node.js runtime (required for pdfjs-dist + @napi-rs/canvas)
export const runtime = 'nodejs'

// Vercel-only directive — no-op on Cloud Run, where the timeout is
// controlled by the deploy script's --timeout flag (currently 900s).
export const maxDuration = 300

// Simple mutex for single-request processing per instance.
let isProcessing = false

export async function POST(request: NextRequest) {
  if (isProcessing) {
    return NextResponse.json(
      { error: 'Server is processing another upload. Please try again in a moment.' },
      { status: 503 },
    )
  }

  isProcessing = true
  let resolvedRoomId: string | null = null
  try {
    // 1. Auth
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // 2. Parse body
    let bodyJson: unknown
    try {
      bodyJson = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsed = renderDeckJsonBodySchema.safeParse(bodyJson)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input: ' + parsed.error.issues[0]?.message }, { status: 400 })
    }
    const { roomId, deckId, activate } = parsed.data
    resolvedRoomId = roomId

    // 3. Verify room ownership + status. Scheduled rooms may render too (slides
    //    are prepared before go-live); only an ended room is off-limits.
    const adminDb = createAdminClient()
    const { data: room, error: roomError } = await adminDb
      .from('lc_rooms')
      .select('id, prof_id, section_id, status')
      .eq('id', roomId)
      .single()
    if (roomError || !room) {
      return NextResponse.json({ error: 'Room not found' }, { status: 404 })
    }
    if (room.prof_id !== user.id) {
      return NextResponse.json({ error: 'You do not own this room' }, { status: 403 })
    }
    if (room.status !== 'live' && room.status !== 'scheduled') {
      return NextResponse.json({ error: 'Room has ended' }, { status: 400 })
    }

    // 4. Render (derives the source path server-side from the deck row).
    try {
      const { deckUrl, pageCount } = await renderDeckToStorage({
        adminDb,
        roomId,
        deckId,
        activate,
        userId: user.id,
        sectionId: room.section_id,
      })

      // renderDeckToStorage promotes an uploaded (non-module) deck into the
      // student-visible "Classroom Uploads" module + pins the session on the
      // roadmap. Refresh the affected pages so the professor sees it immediately
      // (the background scheduled-render path can't revalidate; it relies on the
      // next fetch).
      revalidatePath(`/professor/courses/${room.section_id}/modules`)
      revalidatePath(`/professor/courses/${room.section_id}/roadmap`)
      revalidatePath(`/student/courses/${room.section_id}/roadmap`)

      return NextResponse.json({ success: true, deckUrl, pageCount })
    } catch (err) {
      if (err instanceof RenderDeckError) {
        /* Roll back the never-rendered deck row (#636). It is inserted BEFORE the
           render, so a terminal failure — a PDF over the page cap, or a PPTX whose
           Gotenberg conversion dies — used to leave a row the Switch-deck dialog
           renders forever as a disabled "Preparing…" with no way to remove it. Every
           failed upload added another, and a professor mid-class could not tell one
           from a deck that was genuinely still processing.

           Mirrors applyModuleItemAsDeck, which already rolls back its row on upload
           failure for exactly this reason.

           `.is('deck_url', null)` is the safety: only a deck that never rendered is
           removable. A re-render that fails over an ALREADY-working deck must leave
           it alone — deleting it would destroy slides the professor is presenting.

           Only the interactive route does this. The background render_scheduled_deck
           pipeline calls renderDeckToStorage directly and its job retries, so
           deleting there would both break the retry and silently discard a deck
           uploaded ahead of class. Storage is left for the room-level cleanup that
           runs when a room is cancelled or reaped. */
        const { error: rollbackError } = await adminDb
          .from('lc_decks')
          .delete()
          .eq('id', deckId)
          .eq('room_id', roomId)
          .is('deck_url', null)
        if (rollbackError) {
          logger.warn('render-deck: failed-deck rollback failed (non-fatal)', {
            roomId,
            deckId,
            error: rollbackError.message,
          })
        }
        return NextResponse.json({ error: err.clientMessage }, { status: err.httpStatus })
      }
      throw err
    }
  } catch (error) {
    logger.error('render-deck: Unexpected error', error)
    // Best-effort: tell joined clients the render bombed so they don't sit on
    // "Waiting for slides" forever.
    if (resolvedRoomId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (createAdminClient() as any).rpc('lc_send_event', {
          p_room_id: resolvedRoomId,
          p_event_type: 'deck_failed',
          p_data: { reason: 'unknown' },
          p_persist: false,
          p_broadcast: true,
        })
      } catch {
        // Swallow — the client will time out / retry on its own.
      }
    }
    return NextResponse.json({ error: 'An unexpected error occurred while processing the PDF' }, { status: 500 })
  } finally {
    isProcessing = false
  }
}
