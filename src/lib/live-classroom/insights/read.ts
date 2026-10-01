// Reading the transcript extraction read model back (roadmap-engine.md §5.1).
//
// One gated read for every consumer of `lc_transcript_insights` — the roadmap's
// transcript annotations (P14/P16/P22–P24, S20–S23) and Athena's
// `get_what_was_said_in_class` tool both come through here, so the visibility
// gate lives in exactly one place. Callers hold an admin client behind their own
// ownership/enrollment checks, which bypasses RLS — so the same conditions the
// migration's policies enforce are re-applied in code, per audience:
//
//  - professor: every ended room of the verified section, unconditionally — a
//    read-back of their own speech. Deliberately keyed on SECTION ownership
//    (the caller passed verifyOwnership) where the RLS policy keys on room
//    authorship; the two agree because a room's prof_id is always the section's
//    professor (enforced by the lc_rooms WITH CHECK, 20260806193123).
//  - student: only when the professor left "Catch me up" on (guardrail G14) — a
//    professor who declined to have their spoken words played back to students
//    has declined it everywhere.
//
// Both audiences see ended rooms only: extraction runs when a class ends, and a
// live room's transcript is a different feature (X5).

import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  transcriptInsightsSchema,
  type TranscriptInsights,
} from '@/lib/validations/lc-transcript-insights'

export type TranscriptAudience = 'professor' | 'student'

export interface SectionTranscriptInsights {
  roomId: string
  /** lc_rooms.name — the session node's title on the roadmap; null when unnamed. */
  roomName: string | null
  /** When the class happened (ended_at, falling back to created_at). */
  endedAt: string | null
  insights: TranscriptInsights
}

/** A term's worth of classes; every read is bounded (data-access.md). */
const DEFAULT_MAX_ROOMS = 40

interface RoomJoin {
  name: string | null
  status: string | null
  lecture_summary_enabled: boolean | null
  created_at: string | null
  ended_at: string | null
  section_id: string | null
}
interface InsightRow {
  room_id: string
  insights: unknown
  lc_rooms: RoomJoin | RoomJoin[] | null
}

/**
 * Every stored transcript extraction for a section's finished classes, newest
 * class first, parsed and audience-gated. Returns `[]` — never a hedge — when
 * nothing was extracted or (for students) the replay toggle is off.
 */
export async function fetchSectionTranscriptInsights(
  db: SupabaseClient,
  sectionId: string,
  audience: TranscriptAudience,
  maxRooms: number = DEFAULT_MAX_ROOMS,
): Promise<SectionTranscriptInsights[]> {
  const { data, error } = await db
    .from('lc_transcript_insights')
    .select(
      'room_id, insights, lc_rooms!inner(name, status, lecture_summary_enabled, created_at, ended_at, section_id)',
    )
    .eq('status', 'ready')
    .eq('lc_rooms.section_id', sectionId)
    .eq('lc_rooms.status', 'ended')
    .order('generated_at', { ascending: false })
    .limit(maxRooms)

  if (error) {
    logger.error('fetchSectionTranscriptInsights: read failed', error, { sectionId })
    return []
  }

  const out: SectionTranscriptInsights[] = []
  for (const row of (data ?? []) as InsightRow[]) {
    const room = Array.isArray(row.lc_rooms) ? row.lc_rooms[0] : row.lc_rooms
    if (!room) continue
    // Null means the column predates the toggle — same default as
    // getLectureSummary, and as the RLS policy's COALESCE.
    if (audience === 'student' && room.lecture_summary_enabled === false) continue

    // Stored blobs are parsed, not trusted: a row written by an older shape
    // must be skipped rather than half-read into a prompt or an annotation.
    let insights: TranscriptInsights
    try {
      insights = transcriptInsightsSchema.parse(row.insights)
    } catch {
      logger.warn('fetchSectionTranscriptInsights: unparseable insights row skipped', {
        source: 'insightsRead.fetchSectionTranscriptInsights',
        roomId: row.room_id,
      })
      continue
    }

    out.push({
      roomId: row.room_id,
      roomName: room.name?.trim() || null,
      endedAt: room.ended_at ?? room.created_at,
      insights,
    })
  }
  return out
}
