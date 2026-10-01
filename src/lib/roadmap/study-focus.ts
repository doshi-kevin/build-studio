// "What should I focus on?" — ranked, server-side, from the same journey math
// the roadmap itself draws with (journeyFromTopicAccuracy), so Athena's advice
// and the map the student is sent to can never disagree.
//
// Ranking: nodes the student has a weak signal on come first (lowest mastery),
// then ones they've started, then untouched material. Mastered and checked-off
// nodes are dropped — there is nothing to send them to.
//
// The read itself lives in `node-journeys.ts`: the knowledge map needs the same
// per-node journeys but the opposite slice (every node, mastered included), so
// the loader is shared and only the ranking is here.

import { buildNodeJourneys, nodeIdOf } from '@/lib/roadmap/node-journeys'
import type { JourneyState } from '@/lib/roadmap/journey-state'

export interface StudyFocusNode {
  /** Canvas key `${type}:${id}` — what `?node=` on the roadmap takes. */
  key: string
  title: string
  state: JourneyState
  /** Mastery 0–100, or null when no quiz has measured this node's topics yet. */
  pct: number | null
  topics: string[]
}

export interface StudyFocus {
  /** Weakest first, truncated to `limit`. */
  nodes: StudyFocusNode[]
  /** The student's course-wide mastery, or null when nothing is assessed yet.
   *  Carried alongside the ranking because the same read produces both — asking
   *  for it separately would mean a second whole-section read per question. */
  overall: number | null
}

/** Weakest first; within a state, lowest measured mastery first. */
const STATE_RANK: Record<JourneyState, number> = {
  review_next: 0,
  in_progress: 1,
  not_started: 2,
  mastered: 3,
}

export async function buildStudyFocus(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  userId: string,
  limit = 3,
): Promise<StudyFocus> {
  const { nodes, journeys, checkedOff, overall } = await buildNodeJourneys(adminDb, sectionId, userId)

  const ranked = nodes
    .flatMap((n) => {
      const j = journeys[n.key]
      if (!j || j.state === 'mastered') return []
      if (checkedOff.has(nodeIdOf(n.key))) return []
      return [{ key: n.key, title: n.title, topics: n.topics, state: j.state, pct: j.pct }]
    })
    .sort((a, b) => {
      const byState = STATE_RANK[a.state] - STATE_RANK[b.state]
      if (byState !== 0) return byState
      return (a.pct ?? 101) - (b.pct ?? 101)
    })
    .slice(0, limit)

  return { nodes: ranked, overall }
}
