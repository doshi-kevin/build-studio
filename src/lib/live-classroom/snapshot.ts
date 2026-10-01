// Snapshot-on-join: a single round-trip that gives the client everything
// it needs to render the room as of the moment it joined, plus the
// `lastSeq` that anchors all future replay calls.
//
// Phase 2 extension: now also returns openInteractions (polls/quizzes/
// questions in 'open' or 'draft' status), recentQuestions (last 50
// question-kind interactions for Q&A panel), and myResponses (this user's
// existing responses so the UI shows submitted state without re-querying).
//
// Auth: caller must be the room's professor or an enrolled student.

'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import type { LcRoom, DeckSummary } from '@/lib/validations/live-classroom'
import type { Stroke } from '@/lib/live-classroom/drawings/types'
import { signMany, LIVE_CLASSROOM_SIGNED_URL_TTL } from '@/lib/supabase/signed-urls'
import { stripQuizAnswers, stripInteractionText, stripAnonymousAuthor } from './snapshot-utils'

const LIVE_CLASSROOM_BUCKET = 'live-classroom-decks'

const inputSchema = z.object({
  roomId: z.string().uuid(),
})

export interface SnapshotInteraction {
  id: string
  room_id: string
  kind: 'poll' | 'quiz' | 'question'
  payload: Record<string, unknown>
  status: 'draft' | 'open' | 'closed'
  created_by: string
  created_at: string
  opened_at: string | null
  closed_at: string | null
}

export interface SnapshotResponse {
  interaction_id: string
  response: Record<string, unknown>
  submitted_at: string
}

export interface RoomSnapshot {
  room: LcRoom
  lastSeq: number
  /** Polls and quizzes currently in 'draft' or 'open' status. */
  openInteractions: SnapshotInteraction[]
  /** Closed polls/quizzes — used by the activity timeline (not the live panels). */
  closedInteractions: SnapshotInteraction[]
  /** Last 50 question-kind interactions, newest first (sorted by upvotes/recency in UI). */
  recentQuestions: SnapshotInteraction[]
  /** This user's responses for any interaction in this room. Empty for prof. */
  myResponses: SnapshotResponse[]
  /** Every deck in the room (for the switcher), ordered by position. */
  decks: DeckSummary[]
  /** The deck currently presented; null until the first deck renders. */
  activeDeckId: string | null
  /** All strokes drawn on the ACTIVE deck, across its slides. The drawing
   *  hook filters by current slide; storing them all in one trip avoids
   *  per-slide-change fetches. Re-fetched on deck_ready, so a switch swaps
   *  in the newly-active deck's strokes. */
  slideAnnotations: Stroke[]
  /** Pre-signed URLs for each slide of the current deck, indexed by
   *  zero-based slide number. Empty when the deck hasn't been uploaded
   *  yet. URLs expire after LIVE_CLASSROOM_SIGNED_URL_TTL — clients
   *  re-fetch the snapshot on `deck_ready` events and on a long-session
   *  refresh timer to keep these fresh. */
  slideUrls: string[]
}

export interface GetRoomSnapshotResult {
  snapshot?: RoomSnapshot
  error?: string
}

export async function getRoomSnapshot(
  roomId: string,
  opts?: { viewerSafe?: boolean },
): Promise<GetRoomSnapshotResult> {
  try {
    const parsed = inputSchema.safeParse({ roomId })
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Every column the `LcRoom` contract declares — this row is returned to the
    // client as `snapshot.room`, so the list must stay in sync with `LcRoom`.
    // Deliberately excludes `lecture_summary` (the cached "Catch me up" jsonb):
    // no snapshot consumer reads it, it's served by `getLectureSummary()` which
    // gates it on `lecture_summary_enabled` for students, and shipping it here
    // would route around that gate.
    const { data: room, error: roomError } = await adminDb
      .from('lc_rooms')
      .select(
        'id, section_id, prof_id, status, deck_url, deck_page_count, current_slide, active_deck_id, is_blanked, module_item_id, source_file_path, name, lecture_summary_enabled, setup_completed, scheduled_at, recurrence_group_id, created_at, ended_at',
      )
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

    // The Projector View authenticates as the room's professor but must render
    // the STUDENT-safe projection (no answer keys on the wall). `viewerSafe`
    // forces the same `stripQuizAnswers` path students get — never routes
    // around it, and is strictly more restrictive than the prof default.
    // Students always get the safe path regardless (`!isProf` is true for them).
    const studentSafe = !isProf || opts?.viewerSafe === true
    /* The PROJECTOR specifically — a professor asking for the viewer-safe
       projection. Distinct from studentSafe: students need question and choice text
       to answer, the wall display must not receive it at all (#648). */
    const projectorSafe = opts?.viewerSafe === true

    // ── Latest seq for this room ──
    const { data: latest } = await adminDb
      .from('lc_events')
      .select('seq')
      .eq('room_id', roomId)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastSeq = (latest?.seq as number | undefined) ?? 0

    // ── Open interactions (polls + quizzes) ──
    let openInteractions: SnapshotInteraction[] = []
    // Closed polls/quizzes — for the activity timeline so finished items don't
    // vanish from the "what happened in class" log. The live panels ignore this.
    let closedInteractions: SnapshotInteraction[] = []
    let recentQuestions: SnapshotInteraction[] = []
    let myResponses: SnapshotResponse[] = []
    let slideAnnotations: Stroke[] = []
    let decks: DeckSummary[] = []
    const activeDeckId = (room.active_deck_id as string | null) ?? null

    // lc_interactions may not exist yet on local dev DBs that haven't been
    // migrated past 35. Wrap in try/catch so Phase 0/1-only environments
    // still return a snapshot (with empty arrays).
    try {
      const { data: opens } = await adminDb
        .from('lc_interactions')
        .select('id, room_id, kind, payload, status, created_by, created_at, opened_at, closed_at')
        .eq('room_id', roomId)
        .in('kind', ['poll', 'quiz'])
        .in('status', ['draft', 'open'])
        .order('created_at', { ascending: true })
      openInteractions = (opens ?? []) as SnapshotInteraction[]
      // Students (and the student-safe Projector View) must never receive live
      // quiz answers (anti-cheat).
      if (studentSafe) openInteractions = openInteractions.map(stripQuizAnswers)
      if (projectorSafe) openInteractions = openInteractions.map(stripInteractionText)

      const { data: closed } = await adminDb
        .from('lc_interactions')
        .select('id, room_id, kind, payload, status, created_by, created_at, opened_at, closed_at')
        .eq('room_id', roomId)
        .in('kind', ['poll', 'quiz'])
        .eq('status', 'closed')
        .order('created_at', { ascending: true })
      closedInteractions = (closed ?? []) as SnapshotInteraction[]
      if (studentSafe) closedInteractions = closedInteractions.map(stripQuizAnswers)
      if (projectorSafe) closedInteractions = closedInteractions.map(stripInteractionText)

      const { data: questions } = await adminDb
        .from('lc_interactions')
        .select('id, room_id, kind, payload, status, created_by, created_at, opened_at, closed_at')
        .eq('room_id', roomId)
        .eq('kind', 'question')
        .order('created_at', { ascending: false })
        .limit(50)
      recentQuestions = (questions ?? []) as SnapshotInteraction[]
      /* Applied for EVERY audience, professor included (#658). An anonymous question's
         `created_by` is the asker's real id, and non-anonymous questions in the same
         response carry id AND name — so a classmate could build a uuid→name map and
         de-anonymise every match. Stripped here, before the name backfill below, which
         already skips anonymous questions for the same reason. */
      recentQuestions = recentQuestions.map((q) => stripAnonymousAuthor(q, user.id))

      // Backfill author display names for non-anonymous questions whose
      // payload doesn't carry `authorName` yet (e.g. questions asked before
      // the askQuestion server action started embedding it). Anonymous
      // questions are deliberately skipped — we don't want to leak the
      // asker's identity even server-side.
      const namelessAuthorIds = Array.from(
        new Set(
          recentQuestions
            .filter((q) => {
              const anon = (q.payload.anonymous as boolean | undefined) ?? false
              const hasName = typeof q.payload.authorName === 'string' && q.payload.authorName.length > 0
              return !anon && !hasName && q.created_by
            })
            .map((q) => q.created_by),
        ),
      )
      if (namelessAuthorIds.length > 0) {
        const { data: profiles } = await adminDb
          .from('profiles')
          .select('id, name, email')
          .in('id', namelessAuthorIds)
        const nameById = new Map<string, string>()
        for (const p of (profiles ?? []) as Array<{ id: string; name?: string; email?: string }>) {
          nameById.set(p.id, p.name || p.email || 'A student')
        }
        recentQuestions = recentQuestions.map((q) => {
          const anon = (q.payload.anonymous as boolean | undefined) ?? false
          const hasName = typeof q.payload.authorName === 'string' && q.payload.authorName.length > 0
          if (anon || hasName) return q
          const name = nameById.get(q.created_by)
          if (!name) return q
          return { ...q, payload: { ...q.payload, authorName: name } }
        })
      }

      if (!isProf) {
        const interactionIds = [
          ...openInteractions.map((i) => i.id),
          ...recentQuestions.map((i) => i.id),
        ]
        if (interactionIds.length > 0) {
          const { data: responses } = await adminDb
            .from('lc_responses')
            .select('interaction_id, response, submitted_at')
            .in('interaction_id', interactionIds)
            .eq('student_id', user.id)
          myResponses = (responses ?? []) as SnapshotResponse[]
        }
      }
    } catch (err) {
      // Table doesn't exist yet — fine for Phase 1 environments.
      logger.debug('getRoomSnapshot: lc_interactions unavailable (pre-Phase-2 env)', { roomId })
      logger.debug('snapshot interactions error', { err: String(err) })
    }

    // ── Decks (for the switcher) ──
    try {
      const { data: deckRows } = await adminDb
        .from('lc_decks')
        .select('id, title, position, page_count, current_slide, deck_url')
        .eq('room_id', roomId)
        .order('position', { ascending: true })
      decks = ((deckRows ?? []) as Array<{
        id: string
        title: string | null
        position: number
        page_count: number | null
        current_slide: number
        deck_url: string | null
      }>).map((d) => ({
        id: d.id,
        title: d.title,
        position: d.position,
        pageCount: d.page_count,
        currentSlide: d.current_slide,
        ready: !!d.deck_url,
      }))
    } catch (err) {
      logger.debug('getRoomSnapshot: lc_decks unavailable (pre-multi-deck env)', { roomId })
      logger.debug('snapshot decks error', { err: String(err) })
    }

    // ── Slide annotations (permanent storage) ──
    // Bulk-fetch every stroke drawn on the ACTIVE deck. The drawing hook
    // filters by the currently-viewed slide on render — keeping all of the
    // active deck's strokes in one round-trip avoids a fetch on every slide
    // advance, and scoping to the deck means a switch shows that deck's strokes.
    if (activeDeckId) {
      try {
        const { data: rows } = await adminDb
          .from('lc_slide_annotations')
          .select('stroke')
          .eq('deck_id', activeDeckId)
          .order('created_at', { ascending: true })
          .limit(5000)
        slideAnnotations = ((rows ?? []) as Array<{ stroke: Stroke }>).map((r) => r.stroke)
      } catch (err) {
        // Table won't exist on dev DBs that haven't been migrated past 38.
        logger.debug('getRoomSnapshot: lc_slide_annotations unavailable (pre-migration-39 env)', { roomId })
        logger.debug('snapshot annotations error', { err: String(err) })
      }
    }

    // ── Pre-signed slide URLs ──
    // The deck bucket is private (mig 49). Mint short-lived signed URLs
    // for every page so the renderer can swap slides instantly without
    // a server round-trip per slide change. The room's deck_url stores
    // the bucket-relative folder (`{bucket}/{roomId}/{deckVersion}`) —
    // strip the bucket prefix to get the storage path each page lives
    // under, then sign all N pages in one batch.
    let slideUrls: string[] = []
    const roomTyped = room as LcRoom
    if (roomTyped.deck_url && typeof roomTyped.deck_page_count === 'number' && roomTyped.deck_page_count > 0) {
      const deckPathPrefix = roomTyped.deck_url.startsWith(`${LIVE_CLASSROOM_BUCKET}/`)
        ? roomTyped.deck_url.slice(LIVE_CLASSROOM_BUCKET.length + 1)
        : roomTyped.deck_url
      const paths = Array.from({ length: roomTyped.deck_page_count }, (_, i) => `${deckPathPrefix}/page-${i + 1}.webp`)
      const signed = await signMany(LIVE_CLASSROOM_BUCKET, paths, LIVE_CLASSROOM_SIGNED_URL_TTL)
      slideUrls = paths.map((p) => signed.get(p) ?? '')
    }

    return {
      snapshot: {
        room: roomTyped,
        lastSeq,
        openInteractions,
        closedInteractions,
        recentQuestions,
        myResponses,
        decks,
        activeDeckId,
        slideAnnotations,
        slideUrls,
      },
    }
  } catch (err) {
    logger.error('getRoomSnapshot: unexpected error', err, { roomId })
    return { error: 'An unexpected error occurred' }
  }
}
