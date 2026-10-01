// Server-side loader for the post-class "Annotated slides" section of Student
// Class Insights. Assembles, per presented deck, the signed slide-image URLs
// plus the professor's persisted annotation strokes grouped by slide, so the
// client can replay the annotations over each slide and export them to PDF.
//
// Plain server module (NOT 'use server'): called only from the insights Server
// Component, so it never becomes a client-invocable endpoint. It re-verifies
// authorization itself — never trusting the caller — and uses the admin client
// (which bypasses RLS) strictly AFTER that check, matching getRoomSnapshot.
//
// Returns null (→ section not rendered) when the caller isn't authorized, the
// room isn't ended, no decks were rendered, or nothing was annotated at all.

import { createAdminClient } from '@/lib/supabase/admin'
import { getAuthUser, loadRoom, isEnrolled } from '@/lib/live-classroom/room-auth'
import { signMany, LIVE_CLASSROOM_SIGNED_URL_TTL } from '@/lib/supabase/signed-urls'
import { logger } from '@/lib/logger'
import type { Stroke } from '@/lib/live-classroom/drawings/types'

const LIVE_CLASSROOM_BUCKET = 'live-classroom-decks'
// Guard against a pathological payload; a full session's annotations are far
// below this. Matches the snapshot loader's per-deck cap, aggregated.
const MAX_STROKES = 10000

export interface AnnotatedDeck {
  deckId: string
  title: string | null
  /** Signed WebP URL per slide, indexed by zero-based slide number. Empty
   *  string when signing failed for that page (client shows a placeholder). */
  slideUrls: string[]
  /** Professor's strokes grouped by zero-based slide index. Slides without
   *  annotations are simply absent from the map. */
  strokesBySlide: Record<number, Stroke[]>
}

export interface AnnotatedSlidesData {
  decks: AnnotatedDeck[]
}

interface DeckRow {
  id: string
  title: string | null
  position: number
  deck_url: string | null
  page_count: number | null
}

export async function loadAnnotatedSlides(roomId: string): Promise<AnnotatedSlidesData | null> {
  try {
    const user = await getAuthUser()
    if (!user) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const room = await loadRoom(adminDb, roomId)
    if (!room || room.status !== 'ended') return null

    const authorized =
      room.prof_id === user.id || (await isEnrolled(adminDb, room.section_id, user.id))
    if (!authorized) return null

    // Every rendered deck in the room, in presentation order.
    const { data: deckRows } = await adminDb
      .from('lc_decks')
      .select('id, title, position, deck_url, page_count')
      .eq('room_id', roomId)
      .not('deck_url', 'is', null)
      .order('position', { ascending: true })

    const decks = ((deckRows ?? []) as DeckRow[]).filter(
      (d) => d.deck_url && typeof d.page_count === 'number' && d.page_count > 0,
    )
    if (decks.length === 0) return null

    // Single batched query for every deck's strokes — no per-deck N+1.
    const { data: strokeRows } = await adminDb
      .from('lc_slide_annotations')
      .select('deck_id, slide_index, stroke')
      .in('deck_id', decks.map((d) => d.id))
      .order('created_at', { ascending: true })
      .limit(MAX_STROKES)

    const rows = (strokeRows ?? []) as Array<{ deck_id: string; slide_index: number; stroke: Stroke }>
    // Nothing was annotated all class → don't render the section at all.
    if (rows.length === 0) return null

    const strokesByDeck = new Map<string, Record<number, Stroke[]>>()
    for (const row of rows) {
      let bySlide = strokesByDeck.get(row.deck_id)
      if (!bySlide) {
        bySlide = {}
        strokesByDeck.set(row.deck_id, bySlide)
      }
      ;(bySlide[row.slide_index] ??= []).push(row.stroke)
    }

    // Only keep decks that actually carry annotations — a clean, unmarked deck
    // isn't what the student came here for.
    const annotatedDecks = decks.filter((d) => strokesByDeck.has(d.id))
    if (annotatedDecks.length === 0) return null

    const result: AnnotatedDeck[] = []
    for (const deck of annotatedDecks) {
      const pageCount = deck.page_count as number
      // deck_url stores the bucket-relative folder `{bucket}/{roomId}/{deckId}/{version}`.
      const prefix = deck.deck_url!.startsWith(`${LIVE_CLASSROOM_BUCKET}/`)
        ? deck.deck_url!.slice(LIVE_CLASSROOM_BUCKET.length + 1)
        : deck.deck_url!
      const paths = Array.from({ length: pageCount }, (_, i) => `${prefix}/page-${i + 1}.webp`)
      const signed = await signMany(LIVE_CLASSROOM_BUCKET, paths, LIVE_CLASSROOM_SIGNED_URL_TTL)
      result.push({
        deckId: deck.id,
        title: deck.title,
        slideUrls: paths.map((p) => signed.get(p) ?? ''),
        strokesBySlide: strokesByDeck.get(deck.id) ?? {},
      })
    }

    return { decks: result }
  } catch (err) {
    logger.error('loadAnnotatedSlides: unexpected error', err, { roomId })
    return null
  }
}
