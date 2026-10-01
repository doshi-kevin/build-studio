// Reading the transcript extraction read model back for a student
// (athena-students.md U21-U24; the pass itself is roadmap-engine.md §5.1).
//
// The gated read itself — ended rooms only, `lecture_summary_enabled` honoured
// in code because the tool runs on the admin client (guardrail G14) — lives in
// `@/lib/live-classroom/insights/read`, shared with the roadmap's transcript
// annotations so the visibility rule exists in exactly one place. This module
// only shapes the rows into what Athena's prompt needs.

import 'server-only'

import { fetchSectionTranscriptInsights } from '@/lib/live-classroom/insights/read'
import type { AnchoredClaim } from '@/lib/validations/lc-transcript-insights'
import type { AdminDb } from './contract'

/** Bounded read — a term's worth of classes is plenty of context for "what did
 *  he say", and the prompt budget is not infinite. */
const MAX_ROOMS = 8

export interface ClassStatement {
  /** commitment | exam_scope | emphasis | off_deck */
  kind: AnchoredClaim['kind']
  /** One plain sentence — what was said, for the student to read. */
  said: string
  /** The professor's verbatim words. Athena must quote this, never paraphrase. */
  quote: string
  /** Where it was said, in the terms a student can act on. */
  inClass: string
  onDate: string | null
  slide: string
  topic?: string
}

/**
 * Every statement the professor made in this section's finished classes, newest
 * class first. Returns `[]` — never a hedge — when nothing was said or the
 * professor has the replay toggle off; "nothing was said about that" is a
 * correct and common answer here (G13).
 */
export async function fetchClassStatements(
  adminDb: AdminDb,
  sectionId: string,
): Promise<ClassStatement[]> {
  const rows = await fetchSectionTranscriptInsights(adminDb, sectionId, 'student', MAX_ROOMS)

  const statements: ClassStatement[] = []
  for (const row of rows) {
    for (const claim of row.insights.claims) {
      statements.push({
        kind: claim.kind,
        said: claim.summary,
        quote: claim.quote,
        inClass: row.roomName || 'a live class',
        onDate: row.endedAt ? String(row.endedAt).slice(0, 10) : null,
        // The stored page is 0-based (it joins lc_transcriptions); students
        // count slides from 1, and so does the citation Athena will write.
        slide: `${claim.deckTitle?.trim() || 'deck'}, slide ${claim.pageNumber + 1}`,
        ...(claim.topic ? { topic: claim.topic } : {}),
      })
    }
  }
  return statements
}
